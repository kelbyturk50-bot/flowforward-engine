// Public prototype page: GET /demo/prototype/:token
//
// One server-rendered page per shop: a sample homepage in the shop's name
// and colors, plus four click-through agent demos (estimate follow-up, web
// lead reply, missed-call text-back, online booking). Sample data only.
// Nothing on the page sends, calls, books, or fetches: every action shows a
// toast, and the only outbound links are Kelby's booking page and email.
//
// The watermark ribbon, tile, and footer are part of this markup and do not
// read query params, flags, or brand data. Brand strings are escaped.
// The token is the credential (src/prototypes/tokens.js). Unknown, revoked,
// and archived are 404; expired is 410 with an expired page.

const express = require('express');
const path = require('path');
const { clientIp, consume } = require('../pilot/rate-limit');
const { SENDER } = require('../proposals/config');
const { lookupToken } = require('./store');
const { fixAccent } = require('./color');
const { tradeFor, AGENTS } = require('./content');

const WATERMARK_TEXT = 'PROTOTYPE, not live. FlowForward can make this real in days.';
const TZ = process.env.CRON_TZ || 'America/Denver';
const AGENT_ORDER = ['estimate_followup', 'speed_to_lead', 'receptionist', 'scheduling'];
const AGENT_ID = { estimate_followup: 'estimate', speed_to_lead: 'lead', receptionist: 'missed', scheduling: 'booking' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
const S = '<span class="pt-sample">Sample</span>';

function displayName(name) {
  const raw = String(name || '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '').trim().slice(0, 80);
  const bare = raw.replace(/^test:\s*/i, '').trim();
  return { raw: raw || 'this business', bare: bare || raw || 'Your business' };
}

function nextWeekdays(count) {
  const out = [];
  const d = new Date();
  while (out.length < count) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
    if (wd === 'Sat' || wd === 'Sun') continue;
    out.push(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }).format(d));
  }
  return out;
}

function longDate(d) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(d));
}

// ── shared bits ─────────────────────────────────────────────────────────────

function ribbon() {
  return `<p class="pt-ribbon" role="note" data-prototype-watermark="true">${WATERMARK_TEXT}</p>`;
}

function footer(biz, expiresAt) {
  return `<footer class="pt-footer"><p>Concept by FlowForward, sample data, not affiliated with or endorsed by <span class="pt-business">${esc(biz.raw)}</span>. This preview link expires 14 days after it was shared${expiresAt ? ` (${esc(longDate(expiresAt))})` : ''}.</p></footer>`;
}

function steps(id, labels) {
  return `<ol class="pt-steps" aria-label="Steps">${labels.map((l, i) =>
    `<li><button type="button" data-go="${i + 1}" aria-controls="${id}">${i + 1}. ${esc(l)}</button></li>`).join('')}</ol>`;
}

function stepNav() {
  return `<div class="pt-nav"><button type="button" class="pt-btn pt-ghost" data-prev>Back</button><span class="pt-count" aria-live="polite"></span><button type="button" class="pt-btn" data-next>Next</button></div>`;
}

function agentHead(key, featured) {
  const a = AGENTS[key];
  return `<header class="pt-agent-head"><p class="pt-kicker">${esc(a.tab)}${key === featured ? ' <span class="pt-rec">Recommended for you</span>' : ''}</p><h2>${esc(a.title)}</h2><p class="pt-lead">${esc(a.lead)}</p></header>`;
}

function msg(side, body, meta = '', step = 0, extra = '') {
  return `<div class="pt-msg pt-${side}"${step ? ` data-s="${step}"` : ''}${extra}><p>${body}</p>${meta ? `<span class="pt-meta">${meta}</span>` : ''}</div>`;
}

function phone(title, inner) {
  return `<div class="pt-device"><div class="pt-device-top"><span>${esc(title)}</span></div><div class="pt-device-body">${inner}</div><p class="pt-caption">What your customer sees ${S}</p></div>`;
}

function owner(inner) {
  return `<div class="pt-owner"><p class="pt-owner-label">What you see</p>${inner}</div>`;
}

// ── panels ──────────────────────────────────────────────────────────────────

function sitePanel(biz, trade, city, featured) {
  const hero = esc(trade.hero.replace('{city}', city || 'your area'));
  const services = trade.services.map(([t, d]) => `<li><h4>${esc(t)}</h4><p>${esc(d)}</p></li>`).join('');
  const jobOptions = trade.services.map(([t]) => `<option>${esc(t)}</option>`).join('');
  return `<section class="pt-panel" id="site" data-panel="site" aria-labelledby="site-h">
  <header class="pt-agent-head"><p class="pt-kicker">Sample homepage</p><h2 id="site-h">Your website, with the automations built in</h2>
  <p class="pt-lead">A sample homepage in your name and colors. The buttons marked <span class="pt-try-inline">Try it</span> open the automation behind them. The copy is placeholder; we'd write the real version with you.</p></header>
  <div class="pt-browser">
    <div class="pt-browser-bar"><span class="pt-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="pt-url">Sample homepage for ${esc(biz.bare)}</span></div>
    <div class="pt-site">
      <div class="pt-site-nav"><span class="pt-word">${esc(biz.bare)}</span><nav aria-label="Sample site"><a href="#site-services">Services</a><a href="#site-estimate">Free estimate</a></nav>
        <a class="pt-btn pt-call" href="#missed" data-tab="missed">Call (801) 555-0142 ${S}<span class="pt-try">Try it</span></a></div>
      <div class="pt-site-hero"><h3>${hero}</h3><p>${esc(trade.sub)}</p>
        <div class="pt-hero-cta"><a class="pt-btn" href="#booking" data-tab="booking">Book online<span class="pt-try">Try it</span></a><a class="pt-btn pt-alt" href="#site-estimate">Get a free estimate</a></div></div>
      <div class="pt-site-sec" id="site-services"><h3>What we do</h3><ul class="pt-services">${services}</ul></div>
      <div class="pt-site-sec pt-site-form" id="site-estimate"><h3>Ask for a free estimate</h3>
        <p class="pt-muted">Fill this in to see the instant reply. Use any name; nothing is saved or sent.</p>
        <form class="pt-form" data-lead-form novalidate>
          <label>Name<input name="name" autocomplete="off" maxlength="40" placeholder="Jordan Sample"></label>
          <label>Phone<input name="phone" autocomplete="off" value="(801) 555-0147" readonly aria-readonly="true"></label>
          <label>What do you need?<select name="job">${jobOptions}</select></label>
          <button class="pt-btn" type="submit">Send request<span class="pt-try">Try it</span></button>
        </form></div>
      <div class="pt-site-sec pt-area"><h3>Serving ${esc(city || 'your area')} and nearby</h3><p class="pt-muted">Sample service-area section.</p></div>
      <div class="pt-site-foot"><span class="pt-word">${esc(biz.bare)}</span><span>(801) 555-0142 ${S}</span></div>
      <a class="pt-bubble" href="#missed" data-tab="missed" aria-label="Text us (opens the missed-call demo)">Text us<span class="pt-try">Try it</span></a>
    </div>
  </div>
  <p class="pt-next-hint">Recommended next: <a href="#${AGENT_ID[featured]}" data-tab="${AGENT_ID[featured]}">${esc(AGENTS[featured].tab)} →</a></p>
</section>`;
}

function estimatePanel(biz, trade, featured, days) {
  const e = trade.estimate;
  const picked = e.options[e.pick];
  const opts = e.options.map(([t, a], i) => `<li${i === e.pick ? ' class="pt-picked"' : ''}><span>${esc(t)}</span><b>${money(a)}</b></li>`).join('');
  const id = 'estimate';
  const inbox = `
    <div class="pt-mail" data-s="1"><p class="pt-from">${esc(biz.bare)}</p><p class="pt-subj">Your ${esc(e.job.toLowerCase())} estimate</p><p>Hi Jordan, thanks for having us out. Here are the three options we talked about. Reply with any questions.</p><ul class="pt-opts">${opts}</ul></div>
    <div class="pt-mail" data-s="2"><p class="pt-from">${esc(biz.bare)} · Day 2</p><p class="pt-subj">Answers to common questions</p><p>A few things people usually ask: how long the install takes, what's included, and how the options differ. Happy to walk through any of it.</p></div>
    <div class="pt-mail pt-reply" data-s="4"><p class="pt-from">Jordan ${S} · Day 6</p><p>${esc(trade.question)}</p></div>
    <div class="pt-mail" data-s="5"><p class="pt-from">${esc(biz.bare)}</p><p>Hi Jordan, yes. Let's go over it on a quick call. Does ${esc(days[1])} at 10 work?</p></div>`;
  const own = `
    <div class="pt-card" data-s="1"><p class="pt-card-h">${esc(e.job)} · Jordan ${S}</p><p>${esc(picked[0])} option, ${money(picked[1])} ${S} · Follow-up on</p>
      <ol class="pt-seq"><li data-done="1">Estimate email</li><li data-done="2">Day 2: answers</li><li data-done="3">Day 5: reminder to you</li><li data-done="9">Day 9: last check-in</li></ol></div>
    <div class="pt-card pt-task" data-s="3"><p class="pt-card-h">Call Jordan today</p><p>They opened the estimate 3 times. A quick call usually helps. <em>(This is a reminder for you. Nothing calls them.)</em></p></div>
    <div class="pt-card pt-stop" data-s="4"><p class="pt-card-h">Sequence stopped: Jordan replied</p><p>No more automatic emails. A draft answer is ready for you.</p></div>
    <div class="pt-card" data-s="4"><p class="pt-card-h">Draft reply</p><p>Hi Jordan, yes. Let's go over it on a quick call. Does ${esc(days[1])} at 10 work?</p>
      <button type="button" class="pt-btn" data-only="4" data-toast="send this reply from your own email" data-advance>Approve &amp; send</button></div>
    <div class="pt-card pt-win" data-s="5"><p class="pt-card-h">Moved to: call booked</p><p>${esc(days[1])}, 10:00 · Jordan ${S}</p></div>`;
  return `<section class="pt-panel" id="${id}" data-panel="${id}" hidden aria-label="${esc(AGENTS.estimate_followup.tab)}">
  ${agentHead('estimate_followup', featured)}
  ${steps(id, ['Estimate sent', 'Day 2 email', 'Reminder to you', 'They reply', 'Call booked'])}
  <div class="pt-split" data-steps="${id}" data-max="5">${phone('Jordan\'s inbox', inbox)}${owner(own)}</div>
  ${stepNav()}
  <p class="pt-note">Email only, from your mailbox. It stops on any reply. No texts or calls go to the customer.</p>
</section>`;
}

function leadPanel(biz, trade, featured, days) {
  const id = 'lead';
  const dev = `
    <div class="pt-form-sent" data-s="1"><p class="pt-meta">Web form · 8:42pm</p><p><b class="js-name">Jordan</b> asked about <b class="js-job">${esc(trade.leadJob)}</b>.</p></div>
    ${msg('in', `Hi <span class="js-first">Jordan</span>, this is ${esc(biz.bare)}. Thanks for reaching out about <span class="js-job">${esc(trade.leadJob)}</span>. We can come take a look. Which works best?`, '8:42pm · 38 seconds later', 2)}
    <div class="pt-choices" data-s="2" data-only="2"><button type="button" class="pt-chip" data-pick-slot data-advance>${esc(days[0])} · 10–12</button><button type="button" class="pt-chip" data-pick-slot data-advance>${esc(days[1])} · 1–3</button><button type="button" class="pt-chip" data-pick-slot data-advance>${esc(days[2])} · 8–10</button></div>
    ${msg('out', '<span class="js-slot">' + esc(days[1]) + ' · 1–3</span> works', '8:44pm', 3)}
    ${msg('in', `You're set for <span class="js-slot">${esc(days[1])} · 1–3</span>. We'll text when the tech is on the way.`, '8:44pm', 3)}`;
  const own = `
    <div class="pt-card" data-s="1"><p class="pt-card-h">New web lead · <span class="js-name">Jordan</span> ${S}</p><p><span class="js-job">${esc(trade.leadJob)}</span> · (801) 555-0147 ${S}</p><p class="pt-muted">Came in after hours.</p></div>
    <div class="pt-card" data-s="2"><p class="pt-card-h">Replied in 38 seconds</p><p>Text and email sent with three open times from your schedule.</p></div>
    <div class="pt-card pt-win" data-s="3"><p class="pt-card-h">Booked: <span class="js-slot">${esc(days[1])} · 1–3</span></p><p>On your schedule with the job type and phone number. You didn't have to call back.</p></div>`;
  return `<section class="pt-panel" id="${id}" data-panel="${id}" hidden aria-label="${esc(AGENTS.speed_to_lead.tab)}">
  ${agentHead('speed_to_lead', featured)}
  ${steps(id, ['Form comes in', 'Instant reply', 'They book'])}
  <div class="pt-split" data-steps="${id}" data-max="3">${phone('Text messages', dev)}${owner(own)}</div>
  ${stepNav()}
  <p class="pt-note">Tip: fill in the estimate form on the sample homepage and your name shows up here.</p>
</section>`;
}

function missedPanel(biz, trade, featured, days) {
  const id = 'missed';
  const dev = `
    <div class="pt-call-card" data-s="1"><p class="pt-meta">Calling ${esc(biz.bare)}…</p><p class="pt-missed">No answer</p></div>
    ${msg('in', `Hi, this is ${esc(biz.bare)}. Sorry we missed your call! What can we help with?`, '6:10pm · 40 seconds later', 2)}
    ${msg('out', esc(trade.urgent.ask), '6:11pm', 3)}
    ${msg('in', `Sorry about that. We can have someone out ${esc(days[0])}, 8–10am or 1–3pm. Which works?`, '6:11pm', 3)}
    ${msg('out', '1–3 works', '6:12pm', 4)}
    ${msg('in', `Booked for ${esc(days[0])}, 1–3pm. You'll get a text when the tech is on the way.`, '6:12pm', 4)}`;
  const own = `
    <div class="pt-card" data-s="1"><p class="pt-card-h">Missed call · (801) 555-0148 ${S}</p><p>6:10pm, all lines busy.</p></div>
    <div class="pt-card" data-s="2"><p class="pt-card-h">Text-back sent</p><p>Within a minute, from your business number.</p></div>
    <div class="pt-card pt-task" data-s="3"><p class="pt-card-h">Flagged: ${esc(trade.urgent.tag)}</p><p>You get a heads-up for urgent jobs. You can jump into the thread anytime.</p>
      <button type="button" class="pt-btn pt-ghost" data-toast="open the text thread so you can reply yourself">Take over the thread</button></div>
    <div class="pt-card pt-win" data-s="4"><p class="pt-card-h">Booked: ${esc(days[0])}, 1–3pm</p><p>Job type, address question, and phone number saved to the job.</p></div>`;
  return `<section class="pt-panel" id="${id}" data-panel="${id}" hidden aria-label="${esc(AGENTS.receptionist.tab)}">
  ${agentHead('receptionist', featured)}
  ${steps(id, ['Missed call', 'Text-back', 'They explain', 'Booked'])}
  <div class="pt-split" data-steps="${id}" data-max="4">${phone('Text messages', dev)}${owner(own)}</div>
  ${stepNav()}
</section>`;
}

function bookingPanel(biz, trade, featured, days) {
  const id = 'booking';
  const services = trade.services.slice(0, 4).map(([t]) =>
    `<button type="button" class="pt-chip" data-pick-service data-advance>${esc(t)}</button>`).join('');
  const slots = days.map(d => ['8–10am', '10–12', '1–3pm'].map(t =>
    `<button type="button" class="pt-chip" data-pick-slot data-advance>${esc(d)} · ${t}</button>`).join('')).join('');
  const dev = `
    <div class="pt-book" data-only="1"><p class="pt-book-h">What do you need?</p><div class="pt-choices">${services}</div></div>
    <div class="pt-book" data-only="2"><p class="pt-book-h">Pick a time <span class="pt-muted">for <span class="js-service">${esc(trade.services[0][0])}</span></span></p><div class="pt-choices pt-grid">${slots}</div></div>
    <div class="pt-book" data-only="3"><p class="pt-book-h">Confirm</p><p><span class="js-service">${esc(trade.services[0][0])}</span><br><span class="js-slot">${esc(days[0])} · 10–12</span></p>
      <p>Jordan ${S} · (801) 555-0147 ${S}<br>Address: 123 Sample St ${S}</p><button type="button" class="pt-btn" data-advance>Book it</button></div>
    <div class="pt-book" data-only="4"><p class="pt-book-h">You're booked</p><p><span class="js-service">${esc(trade.services[0][0])}</span> with ${esc(biz.bare)}<br><span class="js-slot">${esc(days[0])} · 10–12</span></p><p class="pt-muted">A confirmation email and a reminder the day before.</p></div>`;
  const own = `
    <div class="pt-card"><p class="pt-card-h">Your schedule</p><ul class="pt-cal">
      <li><span>${esc(days[0])} · 8–10am</span><span>Tune-up · Sample</span></li>
      <li class="pt-new" data-s="4"><span class="js-slot">${esc(days[0])} · 10–12</span><span><span class="js-service">${esc(trade.services[0][0])}</span> · Jordan ${S}</span></li>
      <li><span>${esc(days[1])} · 1–3pm</span><span>Estimate · Sample</span></li></ul>
      <p class="pt-muted" data-only="1">Only the times you leave open show up for customers.</p></div>
    <div class="pt-card pt-win" data-s="4"><p class="pt-card-h">New booking</p><p>No phone tag. It's on your calendar with the job type and contact info.</p></div>`;
  return `<section class="pt-panel" id="${id}" data-panel="${id}" hidden aria-label="${esc(AGENTS.scheduling.tab)}">
  ${agentHead('scheduling', featured)}
  ${steps(id, ['Service', 'Time', 'Confirm', 'Booked'])}
  <div class="pt-split" data-steps="${id}" data-max="4">${phone('Booking page', dev)}${owner(own)}</div>
  ${stepNav()}
</section>`;
}

function ctaPanel(biz) {
  const mail = `mailto:${SENDER.email}?subject=${encodeURIComponent(`Prototype for ${biz.bare}`)}`;
  return `<aside class="pt-cta" aria-label="How we'd make this real"><h2>How we'd make this real</h2>
  <ol><li>Connect your phone, calendar or books.</li><li>We configure and test it with you.</li><li>Go live, with hosting and maintenance.</li></ol>
  <ul class="pt-prices"><li><span>Prototype</span><b>$0</b></li><li><span>MVP build</span><b>typically $1.5–3.5K</b></li><li><span>Hosting and maintenance</span><b>typically $150–400/mo</b></li><li><span>Consulting</span><b>typically $125–200/hr</b></li></ul>
  <p class="pt-muted">Typical starting ranges; final scope after a call. The first build may be discounted in exchange for a case study.</p>
  <a class="pt-btn pt-talk" href="${esc(SENDER.calendly)}" target="_blank" rel="noopener">Talk to Kelby</a>
  <a class="pt-link" href="${esc(mail)}">or email ${esc(SENDER.email)}</a>
  <p class="pt-muted pt-small">This preview link expires 14 days after it was shared.</p></aside>`;
}

// ── styles + script ─────────────────────────────────────────────────────────

function css(accent, onAccent, accent2) {
  return `
@font-face{font-family:Barlow;font-weight:400;font-display:swap;src:url(/demo/prototype-assets/barlow-latin-400-normal.woff2) format("woff2")}
@font-face{font-family:Barlow;font-weight:600;font-display:swap;src:url(/demo/prototype-assets/barlow-latin-600-normal.woff2) format("woff2")}
@font-face{font-family:Barlow;font-weight:700;font-display:swap;src:url(/demo/prototype-assets/barlow-latin-700-normal.woff2) format("woff2")}
:root{--a:${accent};--on:${onAccent};--a2:${accent2};--paper:#F3F6F5;--card:#fff;--ink:#1E2A2F;--muted:#5B6B70;--line:#D5DEDB;--ochre:#C9952F;--ok:#2F6B57;color-scheme:light}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font-family:Barlow,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased}
.pt-ribbon{position:sticky;top:0;z-index:2147483000;margin:0;padding:6px 12px;min-height:32px;background:#1E2A2F!important;color:#F3F6F5!important;text-align:center;font:600 14px/1.3 Barlow,system-ui,sans-serif;display:block!important;visibility:visible!important;opacity:1!important;pointer-events:none}
.pt-tile{position:fixed;inset:0;z-index:0;pointer-events:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='168' height='96'%3E%3Ctext x='6' y='58' fill='%231E2A2F' fill-opacity='0.05' font-family='sans-serif' font-size='15' font-weight='700' transform='rotate(-30 84 48)'%3EPROTOTYPE%3C/text%3E%3C/svg%3E");background-size:168px 96px}
.pt-wrap{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:0 16px}
.pt-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 0 6px;flex-wrap:wrap}
.pt-prepared{margin:0;font-size:.9rem;color:var(--muted)}.pt-prepared b{color:var(--ink)}
.pt-word{display:inline-block;background:var(--a);color:var(--on);font-weight:700;padding:4px 10px;border-radius:6px;line-height:1.5;max-width:100%;overflow-wrap:anywhere}
.pt-tabs{display:flex;gap:6px;overflow-x:auto;padding:10px 0 12px;margin:0;list-style:none;scrollbar-width:thin}
.pt-tabs a{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;padding:8px 14px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);text-decoration:none;font-weight:600;font-size:.95rem}
.pt-tabs a[aria-current="page"]{background:var(--a);border-color:var(--a);color:var(--on)}
.pt-tabs .pt-dot{width:7px;height:7px;border-radius:50%;background:var(--ochre)}
.pt-layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:24px;align-items:start;padding-bottom:24px}
.pt-panel[hidden]{display:none}
.pt-agent-head h2{font-size:clamp(1.4rem,3.4vw,1.9rem);line-height:1.15;margin:.1em 0 .3em}
.pt-kicker{margin:0;font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:600}
.pt-rec{display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;background:#F6EBD3;color:#7A5A12;letter-spacing:0;text-transform:none;font-size:.8rem}
.pt-lead{margin:0 0 14px;color:var(--muted);max-width:62ch}
.pt-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:9px;padding:10px 16px;font:600 1rem Barlow,system-ui,sans-serif;background:var(--a);color:var(--on);cursor:pointer;text-decoration:none;position:relative;min-height:44px}
.pt-btn.pt-alt{background:var(--card);color:var(--a);box-shadow:inset 0 0 0 1.5px var(--a)}
.pt-btn.pt-ghost{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 1px var(--line)}
.pt-btn:disabled{opacity:.4;cursor:default}
.pt-btn:focus-visible,.pt-chip:focus-visible,.pt-tabs a:focus-visible,.pt-steps button:focus-visible{outline:3px solid var(--ochre);outline-offset:2px}
.pt-sample{display:inline-block;margin-left:4px;padding:0 6px;border-radius:4px;background:#E7ECEA;color:#46555A;font-size:.72rem;font-weight:600;letter-spacing:.02em;vertical-align:middle;line-height:1.6}
.pt-try,.pt-try-inline{display:inline-block;padding:1px 7px;border-radius:999px;background:var(--ochre);color:#1E2A2F;font-size:.72rem;font-weight:700;letter-spacing:.02em}
.pt-try{position:absolute;top:-10px;right:-8px;box-shadow:0 0 0 0 rgba(201,149,47,.6);animation:pt-pulse 2s infinite}
@keyframes pt-pulse{0%{box-shadow:0 0 0 0 rgba(201,149,47,.55)}70%{box-shadow:0 0 0 9px rgba(201,149,47,0)}100%{box-shadow:0 0 0 0 rgba(201,149,47,0)}}
@media (prefers-reduced-motion:reduce){.pt-try{animation:none}html{scroll-behavior:auto}}
.pt-muted{color:var(--muted)}.pt-small{font-size:.85rem}
/* sample site */
.pt-browser{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--card);box-shadow:0 10px 30px rgba(30,42,47,.08)}
.pt-browser-bar{display:flex;align-items:center;gap:10px;padding:8px 12px;background:#E9EEEC;border-bottom:1px solid var(--line);font-size:.85rem;color:var(--muted)}
.pt-dots{display:flex;gap:5px}.pt-dots i{width:10px;height:10px;border-radius:50%;background:#C9D3D0;display:block}
.pt-url{background:#fff;border-radius:6px;padding:2px 10px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pt-site{position:relative}
.pt-site-nav{display:flex;align-items:center;gap:14px;padding:14px 18px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.pt-site-nav nav{display:flex;gap:14px;margin-right:auto}.pt-site-nav nav a{color:var(--ink);text-decoration:none;font-weight:600}
.pt-site-hero{padding:34px 22px 30px;background:linear-gradient(135deg,color-mix(in srgb,var(--a) 10%,#fff),#fff 70%);border-bottom:1px solid var(--line)}
.pt-site-hero h3{font-size:clamp(1.6rem,4.2vw,2.4rem);line-height:1.1;margin:0 0 .3em;max-width:20ch}
.pt-site-hero p{margin:0 0 18px;max-width:52ch;color:#3A4A4F}
.pt-hero-cta{display:flex;gap:12px;flex-wrap:wrap}
.pt-site-sec{padding:24px 22px;border-bottom:1px solid var(--line)}.pt-site-sec h3{margin:0 0 12px;font-size:1.25rem}
.pt-services{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.pt-services li{border:1px solid var(--line);border-radius:10px;padding:12px;border-top:3px solid var(--a2)}
.pt-services h4{margin:0 0 4px;font-size:1rem}.pt-services p{margin:0;color:var(--muted);font-size:.92rem}
.pt-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) auto;gap:10px;align-items:end}
.pt-form label{display:grid;gap:4px;font-weight:600;font-size:.88rem}
.pt-form input,.pt-form select{font:inherit;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;min-height:44px;width:100%}
.pt-area{background:color-mix(in srgb,var(--a) 6%,#fff)}
.pt-site-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:16px 22px;flex-wrap:wrap;font-size:.92rem}
.pt-bubble{position:absolute;right:16px;bottom:64px;background:var(--a);color:var(--on);border-radius:999px;padding:10px 16px;font-weight:700;text-decoration:none;box-shadow:0 6px 18px rgba(30,42,47,.25)}
.pt-next-hint{margin:14px 0 0;font-weight:600}.pt-next-hint a{color:var(--a)}
/* agent demos */
.pt-steps{display:flex;gap:6px;list-style:none;margin:0 0 14px;padding:0;flex-wrap:wrap}
.pt-steps button{font:600 .88rem Barlow,system-ui,sans-serif;border:1px solid var(--line);background:var(--card);color:var(--muted);border-radius:999px;padding:6px 12px;cursor:pointer;min-height:36px}
.pt-steps button[aria-current="step"]{background:var(--ink);border-color:var(--ink);color:#fff}
.pt-steps button.pt-done{color:var(--ink)}
.pt-split{display:grid;grid-template-columns:minmax(0,360px) minmax(0,1fr);gap:18px;align-items:start}
.pt-device{background:#1E2A2F;border-radius:28px;padding:10px;box-shadow:0 12px 30px rgba(30,42,47,.18)}
.pt-device-top{color:#F3F6F5;text-align:center;font-size:.82rem;font-weight:600;padding:4px 0 8px}
.pt-device-body{background:#fff;border-radius:20px;min-height:380px;padding:12px;display:flex;flex-direction:column;gap:8px}
.pt-caption{color:#C8D3D0;text-align:center;font-size:.78rem;margin:8px 0 2px}.pt-caption .pt-sample{background:#33444A;color:#E3EAE8}
.pt-msg{max-width:86%;animation:pt-in .25s ease-out}.pt-msg p{margin:0;padding:8px 12px;border-radius:16px;font-size:.95rem}
.pt-msg .pt-meta{display:block;font-size:.72rem;color:var(--muted);margin:2px 6px 0}
.pt-in{align-self:flex-start}.pt-in p{background:#EEF2F1;border-bottom-left-radius:4px}
.pt-out{align-self:flex-end;text-align:right}.pt-out p{background:var(--a);color:var(--on);border-bottom-right-radius:4px;text-align:left}
@keyframes pt-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.pt-msg,.pt-card,.pt-mail{animation:none!important}}
.pt-mail{border:1px solid var(--line);border-radius:12px;padding:10px 12px;animation:pt-in .25s ease-out;font-size:.93rem}
.pt-mail p{margin:0 0 4px}.pt-from{font-weight:700}.pt-subj{font-weight:600;color:#3A4A4F}
.pt-mail.pt-reply{border-color:var(--a);background:color-mix(in srgb,var(--a) 6%,#fff)}
.pt-opts{list-style:none;padding:0;margin:6px 0 0;display:grid;gap:4px}.pt-opts li{display:flex;justify-content:space-between;padding:4px 8px;border-radius:6px;background:#F5F7F6}
.pt-opts li.pt-picked{box-shadow:inset 0 0 0 1.5px var(--a)}
.pt-form-sent,.pt-call-card{border:1px dashed var(--line);border-radius:12px;padding:10px 12px;font-size:.93rem}.pt-form-sent p,.pt-call-card p{margin:0}
.pt-missed{font-weight:700;color:#A33A2B;font-size:1.1rem}
.pt-meta{font-size:.75rem;color:var(--muted)}
.pt-choices{display:flex;flex-wrap:wrap;gap:8px}.pt-choices.pt-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.pt-chip{font:600 .9rem Barlow,system-ui,sans-serif;border:1.5px solid var(--a);color:var(--a);background:#fff;border-radius:10px;padding:8px 10px;cursor:pointer;min-height:44px;text-align:left}
.pt-chip:hover{background:color-mix(in srgb,var(--a) 8%,#fff)}
.pt-book-h{font-weight:700;font-size:1.05rem;margin:0 0 8px}.pt-book p{margin:0 0 10px}
.pt-owner{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;display:grid;gap:10px}
.pt-owner-label{margin:0;font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:600}
.pt-card{border:1px solid var(--line);border-radius:10px;padding:10px 12px;animation:pt-in .25s ease-out}.pt-card p{margin:0 0 4px}
.pt-card-h{font-weight:700}.pt-card .pt-btn{margin-top:6px}
.pt-task{border-left:4px solid var(--ochre)}.pt-stop{border-left:4px solid var(--ink)}.pt-win{border-left:4px solid var(--ok);background:#F1F7F4}
.pt-seq{margin:6px 0 0;padding-left:20px;color:var(--muted)}.pt-seq li.pt-on{color:var(--ink);font-weight:600}.pt-seq li.pt-on::marker{color:var(--ok)}
.pt-cal{list-style:none;margin:6px 0;padding:0;display:grid;gap:6px}.pt-cal li{display:flex;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:8px;background:#F5F7F6;font-size:.92rem;flex-wrap:wrap}
.pt-cal li.pt-new{background:color-mix(in srgb,var(--a) 12%,#fff);box-shadow:inset 3px 0 0 var(--a)}
.pt-nav{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:16px 0 4px;max-width:760px}
.pt-count{color:var(--muted);font-size:.9rem}
.pt-note{color:var(--muted);font-size:.9rem;margin:8px 0 0}
[data-s][hidden],[data-only][hidden]{display:none!important}
/* cta */
.pt-cta{position:sticky;top:52px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
.pt-cta h2{margin:0 0 8px;font-size:1.2rem}.pt-cta ol{margin:0 0 12px;padding-left:20px}
.pt-prices{list-style:none;margin:0 0 8px;padding:0;display:grid;gap:6px}.pt-prices li{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid #EEF2F1;padding-bottom:6px;font-size:.95rem}
.pt-prices b{white-space:nowrap}
.pt-talk{width:100%;margin-top:8px}.pt-link{display:block;text-align:center;margin-top:8px;color:var(--a);font-size:.9rem}
.pt-footer{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:10px 16px 40px;color:var(--muted);font-size:.86rem}
.pt-toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147482000;background:#1E2A2F;color:#F3F6F5;padding:10px 16px;border-radius:10px;font-weight:600;max-width:calc(100% - 32px);box-shadow:0 8px 24px rgba(0,0,0,.25)}
.pt-toast[hidden]{display:none}
.pt-expired{max-width:560px;width:calc(100% - 32px);margin:60px auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;position:relative;z-index:1}
@media (max-width:980px){.pt-layout{grid-template-columns:1fr}.pt-cta{position:static}}
@media (max-width:720px){.pt-split{grid-template-columns:1fr}.pt-form{grid-template-columns:1fr}.pt-device-body{min-height:300px}.pt-site-nav nav{display:none}.pt-bubble{bottom:72px}}
@media print{.pt-ribbon{background:#fff!important;color:#1E2A2F!important;border:2px solid #1E2A2F;position:static}.pt-tile{position:absolute}}
`;
}

// Inline script. Reads nothing from the URL except the #tab name, never
// writes HTML from input (textContent only), and makes no network requests.
const SCRIPT = `(function(){
var tabs=[].slice.call(document.querySelectorAll('[data-tablink]'));
var panels=[].slice.call(document.querySelectorAll('[data-panel]'));
var ids=panels.map(function(p){return p.getAttribute('data-panel')});
var toast=document.querySelector('.pt-toast');var tt;
function say(t){toast.textContent='In the live version this would '+t+'.';toast.hidden=false;clearTimeout(tt);tt=setTimeout(function(){toast.hidden=true},4000)}
function show(id,focus){if(ids.indexOf(id)<0)id='site';panels.forEach(function(p){p.hidden=p.getAttribute('data-panel')!==id});
tabs.forEach(function(a){if(a.getAttribute('data-tablink')===id)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current')});
if(focus){var h=document.getElementById(id);if(h){window.scrollTo({top:0});}}}
window.addEventListener('hashchange',function(){var id=location.hash.slice(1);if(ids.indexOf(id)>=0)show(id,true)});
document.addEventListener('click',function(e){var t=e.target.closest('[data-tab]');if(t){e.preventDefault();var id=t.getAttribute('data-tab');history.pushState(null,'','#'+id);show(id,true);return}
var tl=e.target.closest('[data-tablink]');if(tl){e.preventDefault();var id2=tl.getAttribute('data-tablink');history.pushState(null,'','#'+id2);show(id2,true);return}
var to=e.target.closest('[data-toast]');if(to)say(to.getAttribute('data-toast'))});
var start=location.hash.slice(1);show(ids.indexOf(start)>=0?start:'site');
function setText(scope,cls,v){[].slice.call(scope.querySelectorAll(cls)).forEach(function(n){n.textContent=v})}
[].slice.call(document.querySelectorAll('[data-steps]')).forEach(function(box){
 var id=box.getAttribute('data-steps');var panel=document.getElementById(id);var max=+box.getAttribute('data-max');var cur=1;
 var pills=[].slice.call(panel.querySelectorAll('.pt-steps [data-go]'));var prev=panel.querySelector('[data-prev]');var next=panel.querySelector('[data-next]');var count=panel.querySelector('.pt-count');
 function render(){[].slice.call(panel.querySelectorAll('[data-s]')).forEach(function(n){n.hidden=+n.getAttribute('data-s')>cur});
  [].slice.call(panel.querySelectorAll('[data-only]')).forEach(function(n){n.hidden=+n.getAttribute('data-only')!==cur});
  [].slice.call(panel.querySelectorAll('[data-done]')).forEach(function(n){n.classList.toggle('pt-on',+n.getAttribute('data-done')<=cur)});
  pills.forEach(function(b){var g=+b.getAttribute('data-go');if(g===cur)b.setAttribute('aria-current','step');else b.removeAttribute('aria-current');b.classList.toggle('pt-done',g<cur)});
  prev.disabled=cur<=1;next.disabled=cur>=max;next.textContent=cur>=max?'Done':'Next';count.textContent='Step '+cur+' of '+max}
 panel.go=function(n){cur=Math.max(1,Math.min(max,n));render()};
 pills.forEach(function(b){b.addEventListener('click',function(){panel.go(+b.getAttribute('data-go'))})});
 prev.addEventListener('click',function(){panel.go(cur-1)});next.addEventListener('click',function(){panel.go(cur+1)});
 panel.addEventListener('click',function(e){var b=e.target.closest('button');if(!b||!panel.contains(b))return;
  if(b.hasAttribute('data-pick-service'))setText(panel,'.js-service',b.textContent);
  if(b.hasAttribute('data-pick-slot'))setText(panel,'.js-slot',b.textContent);
  if(b.hasAttribute('data-advance'))panel.go(cur+1)});
 render()});
var form=document.querySelector('[data-lead-form]');
if(form)form.addEventListener('submit',function(e){e.preventDefault();var lead=document.getElementById('lead');
 var name=(form.elements.name.value||'').replace(/[\\u0000-\\u001f]/g,'').trim().slice(0,40)||'Jordan';
 setText(lead,'.js-name',name);setText(lead,'.js-first',name.split(' ')[0]);setText(lead,'.js-job',form.elements.job.value);
 history.pushState(null,'','#lead');show('lead',true);if(lead.go)lead.go(1)});
})();`;

// ── page ────────────────────────────────────────────────────────────────────

function renderPrototype(row, { now = new Date() } = {}) {
  const biz = displayName(row.brand_name);
  const trade = tradeFor(row.industry);
  const city = String(row.city || '').trim().slice(0, 60);
  const theme = fixAccent(row.color_primary);
  const theme2 = fixAccent(row.color_secondary);
  const featured = AGENT_ORDER.includes(row.agent_type) ? row.agent_type : 'estimate_followup';
  const order = [featured, ...AGENT_ORDER.filter(a => a !== featured)];
  const days = nextWeekdays(3);
  const tabs = [['site', 'Your website', false], ...order.map(a => [AGENT_ID[a], AGENTS[a].tab, a === featured])]
    .map(([id, label, rec]) => `<li><a href="#${id}" data-tablink="${id}">${rec ? '<span class="pt-dot" aria-hidden="true"></span>' : ''}${esc(label)}${rec ? '<span class="sr-only"> (recommended)</span>' : ''}</a></li>`).join('');
  const panels = {
    estimate_followup: estimatePanel(biz, trade, featured, days),
    speed_to_lead: leadPanel(biz, trade, featured, days),
    receptionist: missedPanel(biz, trade, featured, days),
    scheduling: bookingPanel(biz, trade, featured, days),
  };
  void now;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(biz.bare)} · prototype by FlowForward</title>
<style>${css(theme.accent, theme.onAccent, theme2.accent)}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}</style>
</head><body>
${ribbon()}
<div class="pt-tile" aria-hidden="true" data-prototype-tile="true"></div>
<div class="pt-wrap">
  <div class="pt-top"><span class="pt-word">${esc(biz.bare)}</span><p class="pt-prepared">A prototype prepared for <b>${esc(biz.bare)}</b> by ${esc(SENDER.name)}, FlowForward. Sample data only.</p></div>
  <nav aria-label="Prototype sections"><ul class="pt-tabs">${tabs}</ul></nav>
  <div class="pt-layout"><main id="main">
    ${sitePanel(biz, trade, city, featured)}
    ${order.map(a => panels[a]).join('\n')}
  </main>${ctaPanel(biz)}</div>
</div>
${footer(biz, row.expires_at)}
<p class="pt-toast" role="status" hidden></p>
<script>${SCRIPT}</script>
</body></html>`;
}

function renderGone(status, row) {
  const title = status === 410 ? 'This preview link has expired' : 'This page isn\'t available';
  const body = status === 410
    ? `Prototype links last 14 days${row && row.expires_at ? `; this one expired on ${esc(longDate(row.expires_at))}` : ''}. Ask ${esc(SENDER.name.split(' ')[0])} for a fresh one.`
    : 'The link may be mistyped or turned off.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${title}</title>
<style>${css('#2F6B57', '#FFFFFF', '#2F6B57')}</style></head><body>${ribbon()}<div class="pt-tile" aria-hidden="true"></div>
<div class="pt-expired"><h1>${title}</h1><p class="pt-muted">${body}</p>${status === 410 ? `<a class="pt-btn" href="${esc(SENDER.calendly)}" target="_blank" rel="noopener">Talk to Kelby</a>` : ''}</div></body></html>`;
}

// ── routes ──────────────────────────────────────────────────────────────────

const router = express.Router();

function stamp(res) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  // No network from the page: fonts and inline code only.
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
}

router.get('/:token', async (req, res) => {
  const hit = consume(clientIp(req), 'prototype');
  stamp(res);
  if (hit.limited) {
    res.set('Retry-After', String(hit.retryAfter));
    return res.status(429).type('html').send(renderGone(404));
  }
  try {
    const { status, row } = await lookupToken(req.params.token);
    if (status !== 200) return res.status(status).type('html').send(renderGone(status, row));
    res.type('html').send(renderPrototype(row));
  } catch (err) {
    console.error('[prototype] page failed:', err && err.code);
    res.status(500).type('html').send(renderGone(404));
  }
});

const assets = express.static(path.join(__dirname, 'assets'), {
  index: false, fallthrough: false, maxAge: '30d', immutable: true,
  setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff'),
});

module.exports = { router, assets, renderPrototype, renderGone, WATERMARK_TEXT };
