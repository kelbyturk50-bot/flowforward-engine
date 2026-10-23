// Public prototype page: GET /demo/prototype/:token
//
// A sample homepage built the way real local contractor sites are (see the
// design spec in docs/design/prototype-site.md): utility bar, header with the
// phone number, a solid brand-color hero with a free-estimate form, service
// tiles, how-it-works, CTA bands, a service-area list, a dense footer, and a
// mobile Call/Text/Schedule bar. Colors come from the shop's own palette.
// The automations run from the controls a customer would touch:
//   Schedule Service -> booking window      (scheduling)
//   any phone number -> missed-call text-back in the chat widget (receptionist)
//   free-estimate form -> instant reply      (speed_to_lead)
//   ...plus the follow-up schedule after it  (estimate_followup)
//
// Sample data only. FlowForward prices are not rendered. Nothing sends, calls, books, or fetches. Reviews,
// ratings, licenses, offers and years in business are dashed "add yours"
// slots, never invented. The watermark ribbon, tile, and footer are server
// markup that no query param, flag, or brand string can remove. Brand
// strings are escaped; script writes user input with textContent only.

const express = require('express');
const path = require('path');
const { clientIp, consume } = require('../pilot/rate-limit');
const { SENDER } = require('../proposals/config');
const { lookupToken } = require('./store');
const { fixAccent, contrastRatio, normalizeHex } = require('./color');
const { tradeFor, serviceArea, AGENTS } = require('./content');
const { icon, VAN } = require('./icons');

const WATERMARK_TEXT = 'PROTOTYPE, not live. FlowForward can make this real in days.';
const TZ = process.env.CRON_TZ || 'America/Denver';
const AGENT_ORDER = ['scheduling', 'receptionist', 'speed_to_lead', 'estimate_followup'];
const SAMPLE_PHONE = '(801) 555-0142';
const SAMPLE_TEL = '+18015550142';
const INK = '#1C2430';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
const fill = (s, city) => String(s).replace(/\{city\}/g, city || 'Your Town');

function displayName(name) {
  const raw = String(name || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim().slice(0, 80);
  const bare = raw.replace(/^test:\s*/i, '').trim();
  return { raw: raw || 'this business', bare: bare || raw || 'Your Business' };
}

// "Eric's Plumbing & Drain Cleaning" -> top line "ERIC'S", second line the rest.
function wordmarkParts(bare) {
  const words = bare.split(/\s+/);
  const tradeAt = words.findIndex((w, i) => i > 0 && /^(plumbing|heating|air|hvac|electric|electrical|roofing|landscap|lawn|drain|services?|&|and|co\.?|company|llc|inc\.?|mechanical|comfort|pros?)/i.test(w));
  if (tradeAt > 0) return [words.slice(0, tradeAt).join(' '), words.slice(tradeAt).join(' ')];
  if (words.length >= 3) return [words.slice(0, 2).join(' '), words.slice(2).join(' ')];
  return [bare, ''];
}

function nextWeekdays(count) {
  const out = [];
  const d = new Date();
  while (out.length < count) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
    if (wd === 'Sat' || wd === 'Sun') continue;
    out.push({
      short: new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d),
      day: new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'numeric', day: 'numeric' }).format(d),
    });
  }
  return out;
}

function longDate(d) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(d));
}

// ── color system (spec §4) ──────────────────────────────────────────────────
function hexToRgb(hex) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }
function hueSat(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => v / 255);
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}
const neutral = (hex) => hueSat(hex).s < 0.18 || hueSat(hex).v < 0.12;

function onColor(bg) {
  const w = contrastRatio(bg, '#FFFFFF'); const k = contrastRatio(bg, INK);
  if (w >= 4.5 && w >= k) return '#FFFFFF';
  if (k >= 4.5) return INK;
  return null;
}

function theme(primaryRaw, secondaryRaw) {
  const primary = normalizeHex(primaryRaw) || '#2F6B57';
  const { h, s } = hueSat(primary);
  const warm = s > 0.35 && (h < 40 || h > 330); // red / orange brands
  // The shop's exact color when white text reads on it; else the same hue darkened.
  const brand = contrastRatio(primary, '#FFFFFF') >= 4.5 ? primary : fixAccent(primary).accent;
  let accent = normalizeHex(secondaryRaw);
  if (!accent || accent === '#1E2A2F' || neutral(accent) || contrastRatio(accent, brand) < 1.6) accent = null;
  if (warm) {
    // Spec: a full red hero reads as alarm. Charcoal hero, red buttons.
    return { brand, heroBg: INK, heroBar: brand, accent: brand, onAccent: onColor(brand) || '#FFFFFF', eyebrow: '#FF8A99', warm: true };
  }
  if (!accent) accent = '#FFC845';
  let onAccent = onColor(accent);
  if (!onAccent) { accent = fixAccent(accent).accent; onAccent = '#FFFFFF'; }
  const eyebrow = contrastRatio(accent, brand) >= 3 ? accent : '#FFFFFF';
  return { brand, heroBg: brand, heroBar: null, accent, onAccent, eyebrow, warm: false };
}

// ── sections ────────────────────────────────────────────────────────────────
function wordmark(biz, trade, cls = '') {
  const [top, rest] = wordmarkParts(biz.bare);
  return `<span class="wm ${cls}"><span class="wm-glyph">${icon(trade.glyph)}</span><span class="wm-text"><span class="wm-top">${esc(top)}</span>${rest ? `<span class="wm-rest">${esc(rest)}</span>` : ''}</span></span>`;
}

function callLink(cls, label = `Call ${SAMPLE_PHONE}`) {
  return `<a class="${cls}" href="tel:${SAMPLE_TEL}" data-call>${icon('phone')}<span>${esc(label)}</span></a>`;
}

function header(biz, trade, city) {
  return `
<div class="util"><div class="wrap util-in">
  <span>${icon('pin', 'ic ic-sm')} Serving ${esc(city || 'your area')} &amp; nearby</span>
  <span class="util-right">Call or text <a href="tel:${SAMPLE_TEL}" data-call>${SAMPLE_PHONE}</a> <span class="samp">sample #</span></span>
</div></div>
<header class="hdr"><div class="wrap hdr-in">
  <a class="hdr-brand" href="#top" aria-label="${esc(biz.bare)} home">${wordmark(biz, trade)}</a>
  <nav class="hdr-nav" aria-label="Sample site">
    <a href="#services">Services</a>${trade.nav.slice(0, 2).map(n => `<a href="#services">${esc(n)}</a>`).join('')}<a href="#area">Service Area</a>
  </nav>
  <a class="hdr-phone" href="tel:${SAMPLE_TEL}" data-call><span class="hdr-phone-ic">${icon('phone')}</span><span><small>Call or text</small><b>${SAMPLE_PHONE}</b></span></a>
  <button type="button" class="btn btn-primary hdr-book" data-book>Schedule Service</button>
  <a class="hdr-callbtn" href="tel:${SAMPLE_TEL}" data-call aria-label="Call ${SAMPLE_PHONE}">${icon('phone')}</a>
</div></header>`;
}

function hero(biz, trade, city, t) {
  return `
<section class="hero${t.warm ? ' hero-warm' : ''}" id="top"><div class="hero-art-wrap" aria-hidden="true">${VAN}</div><div class="wrap hero-in">
  <div class="hero-copy">
    <p class="eyebrow">${esc(trade.label)} · ${esc(city || 'Your Town')}, UT</p>
    <h1>${esc(fill(trade.heroLine, city))}</h1>
    <p class="hero-sub">${esc(fill(trade.sub, city))}</p>
    <div class="hero-btns"><button type="button" class="btn btn-primary" data-book>${icon('calendar')}Schedule Service</button>${callLink('btn btn-outline')}</div>
    <ul class="hero-checks"><li>${icon('check')}Book online any time</li><li>${icon('check')}Text us a photo of the problem</li><li>${icon('check')}Free estimates</li></ul>
    <p class="hero-note">Sample checklist: we'd use only what ${esc(biz.bare)} actually offers.</p>
  </div>
  <div class="est-card" id="estimate" data-est>
    <div class="est-form-wrap">
      <h2>Request a Free Estimate</h2>
      <p class="est-lead">Tell us what's going on. We'll text you back.</p>
      <form class="est-form" data-est-form novalidate>
        <label>Your name<input name="name" autocomplete="off" maxlength="40" placeholder="Jordan Sample"></label>
        <label>Phone<input name="phone" autocomplete="off" value="(801) 555-0147" readonly aria-readonly="true"></label>
        <label>What do you need?<select name="job">${trade.formJobs.map(j => `<option>${esc(j)}</option>`).join('')}</select></label>
        <label>ZIP<input name="zip" autocomplete="off" inputmode="numeric" maxlength="5" placeholder="84043"></label>
        <button class="btn btn-primary btn-block" type="submit">Get My Estimate</button>
        <p class="est-micro">Sample form. Nothing is saved or sent.</p>
      </form>
    </div>
    <div class="est-done" hidden>
      <p class="est-check">${icon('check')}</p>
      <h2>Thanks, <span class="js-first">Jordan</span>. Check your phone.</h2>
      <p class="mini-label">Text, just now <span class="samp">sample</span></p>
      <div class="sms sms-in"><p>Hi <span class="js-first">Jordan</span>, this is ${esc(biz.bare)}. Thanks for asking about <span class="js-job">${esc(trade.formJobs[0].toLowerCase())}</span>. We can come take a look. Want the next open time? Reply YES or book here: <u>book link</u></p></div>
      <p class="mini-label">Email, just now</p>
      <div class="mail-prev"><p class="mail-subj">${icon('mail', 'ic ic-sm')} Your estimate request with ${esc(biz.bare)}</p><p>Hi <span class="js-first">Jordan</span>, we got your request and will be in touch shortly with a time to come out…</p></div>
      <p class="mini-label">Then, if they get a quote and go quiet</p>
      <ol class="fu-line">
        <li><b>Day 2</b> Friendly check-in: answers to common questions</li>
        <li><b>Day 5</b> Reminder to you: they've opened the quote 3 times, give them a call</li>
        <li><b>Day 10</b> Last note, with a link to book</li>
      </ol>
      <p class="fu-stop">Stops the moment they reply. Sent from your own email.</p>
      <div class="est-done-btns"><button type="button" class="btn btn-outline-dark" data-fu-preview>Preview the Day 2 email</button><button type="button" class="linkbtn" data-est-reset>Start over</button></div>
      <p class="bts"><b>Behind the scenes:</b> lead saved to your list, reply sent in under a minute, follow-up scheduled for the quote.</p>
    </div>
  </div>
</div>${t.heroBar ? '<div class="hero-bar" aria-hidden="true"></div>' : ''}</section>`;
}

function trustStrip() {
  const cells = [['star', 'Your Google rating here'], ['shield', 'Your license # here'], ['clock', 'Your years in business here'], ['award', 'Your badges & associations here']];
  return `<section class="trust" aria-label="Placeholders for the shop's real trust details"><div class="wrap trust-in">${cells.map(([i, l]) =>
    `<div class="slot">${icon(i)}<span>${esc(l)}</span><em>Add yours</em></div>`).join('')}</div></section>`;
}

function services(trade, city) {
  const [ft, fs] = trade.featured;
  const tiles = trade.services.slice(0, 6).map(([title, ic, subs], i) => `
    <article class="tile"><h3>${icon(ic)}<span>${esc(title)}</span></h3><ul>${subs.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
    <button type="button" class="tile-link" data-book data-service="${esc(title)}">Schedule ${esc(title.toLowerCase())} ${icon('arrow', 'ic ic-sm')}</button></article>${i === 1 ? `
    <article class="tile tile-feat"><h3>${icon('bolt')}<span>${esc(ft)}</span></h3><p>${esc(fs)}</p>
    <div class="tile-feat-btns"><button type="button" class="btn btn-primary" data-book>Schedule Service</button>${callLink('btn btn-outline', 'Call now')}</div></article>` : ''}`).join('');
  return `<section class="sec sec-paper" id="services"><div class="wrap">
  <div class="sec-head"><div><p class="eyebrow eyebrow-dark">What we do</p><h2>${esc(trade.label)} Services in ${esc(city || 'Your Town')}</h2></div><a class="sec-link" href="#contact">Not sure what you need? Ask us ${icon('arrow', 'ic ic-sm')}</a></div>
  <div class="tiles">${tiles}</div></div></section>`;
}

function howItWorks() {
  const steps = [['Book online or call', 'Pick a time that works, day or night.'], ['We confirm by text', 'You get a text with your time window.'], ['Tech arrives & quotes upfront', 'Options and prices before any work starts.'], ['Job done right', 'Clean up, walk-through, and you\'re set.']];
  return `<section class="sec" id="how"><div class="wrap"><p class="eyebrow eyebrow-dark">How it works</p><h2>Four Easy Steps</h2>
  <ol class="steps">${steps.map(([h, p], i) => `<li><span class="num">${i + 1}</span><div><h3>${esc(h)}</h3><p>${esc(p)}</p></div></li>`).join('')}</ol></div></section>`;
}

function band(text, dark) {
  return `<section class="band${dark ? ' band-dark' : ''}"><div class="wrap band-in"><h2>${esc(text)}</h2>
  <div class="band-btns"><button type="button" class="btn btn-primary" data-book>Schedule Service</button>${callLink('btn btn-outline')}</div></div></section>`;
}

function offers() {
  return `<section class="sec sec-paper sec-tight"><div class="wrap offers">
  <div class="coupon">${icon('scissors')}<div><h3>Your seasonal offer here</h3><p>A real coupon or special from the shop goes in this spot.</p></div><em>Add yours</em></div>
  <div class="coupon">${icon('clipboard')}<div><h3>Financing details here</h3><p>If the shop offers financing, the terms go here.</p></div><em>Add yours</em></div>
</div></section>`;
}

function area(city) {
  const { county, towns } = serviceArea(city);
  return `<section class="sec" id="area"><div class="wrap area">
  <div><p class="eyebrow eyebrow-dark">Service area</p><h2>Proudly Serving ${esc(county || city || 'Your Area')}</h2>
  <p class="muted">Sample list of nearby towns. The real one comes from the shop.</p>
  <ul class="towns">${towns.map(t => `<li>${icon('pin', 'ic ic-sm')}${esc(t)}</li>`).join('')}</ul></div>
  <div class="area-box">${icon('pin')}<h3>Not on the list?</h3><p>Call or text and we'll let you know if we can get out to you.</p>${callLink('btn btn-primary')}</div></div>
</div></section>`;
}

function reviews(city) {
  return `<section class="sec sec-paper"><div class="wrap"><p class="eyebrow eyebrow-dark">Reviews</p><h2>What ${esc(city || 'Local')} Homeowners Say</h2>
  <div class="revs">${[1, 2, 3].map(() => `<div class="slot slot-tall">${icon('chat')}<span>Your Google reviews appear here</span><em>Add yours</em></div>`).join('')}</div>
  <p class="muted small">We'd pull these from the shop's Google Business Profile. Nothing here is a real review.</p></div></section>`;
}

function closer(trade, city) {
  return `<section class="closer" id="contact"><div class="wrap closer-in"><h2>${esc(fill(trade.closer, city))}</h2>
  <a class="closer-phone" href="tel:${SAMPLE_TEL}" data-call>${SAMPLE_PHONE}</a>
  <div class="band-btns center"><button type="button" class="btn btn-primary" data-book>Schedule Service</button><button type="button" class="btn btn-outline" data-text>${icon('chat')}Text Us</button></div></div></section>`;
}

function siteFooter(biz, trade, city) {
  const year = new Date().getFullYear();
  return `<footer class="sfoot"><div class="wrap sfoot-in">
  <div>${wordmark(biz, trade, 'wm-light')}<p>${esc(city || 'Your Town')}, Utah</p><p>Hours: <span class="ph">add yours</span></p></div>
  <div><h4>Services</h4><ul>${trade.services.slice(0, 5).map(([t]) => `<li><a href="#services">${esc(t)}</a></li>`).join('')}</ul></div>
  <div><h4>Company</h4><ul><li><a href="#how">How it works</a></li><li><a href="#area">Service area</a></li><li><a href="#top" data-toast="open the About page">About</a></li><li><a href="#top" data-toast="open the Careers page">Careers</a></li></ul></div>
  <div><h4>Contact</h4><a class="sfoot-phone" href="tel:${SAMPLE_TEL}" data-call>${SAMPLE_PHONE}</a><p class="small">Sample number</p><ul><li><a href="#top" data-text>Text us</a></li><li><a href="#top" data-book>Schedule online</a></li></ul></div>
</div><div class="wrap sfoot-bottom"><span>License # <span class="ph">add yours</span></span><span>© ${year} ${esc(biz.bare)}</span><span>Privacy</span></div></footer>`;
}

function flowforward(biz, featured, expiresAt) {
  const mail = `mailto:${SENDER.email}?subject=${encodeURIComponent(`Prototype for ${biz.bare}`)}`;
  const order = [featured, ...AGENT_ORDER.filter(a => a !== featured)];
  return `<section class="ffsec" aria-label="How we'd make this real"><div class="wrap ffsec-in">
  <div>
    <p class="ff-kicker">From FlowForward · not part of the sample site</p>
    <h2>How we'd make this real</h2>
    <ol class="ff-steps"><li>Connect your phone, calendar or books.</li><li>We configure and test it with you.</li><li>Go live, with hosting and maintenance.</li></ol>
    <p class="ff-what">What's built into this sample: ${order.map(a => `<b>${esc(AGENTS[a].name)}</b>`).join(', ')}.</p>
  </div>
  <div class="ff-card">
    <a class="ff-talk" href="${esc(SENDER.calendly)}" target="_blank" rel="noopener">Talk to Kelby</a>
    <a class="ff-mail" href="${esc(mail)}">or email ${esc(SENDER.email)}</a>
    <p class="small">This preview link expires 14 days after it was shared${expiresAt ? ` (${esc(longDate(expiresAt))})` : ''}.</p>
  </div>
</div></section>`;
}

function ribbon() {
  return `<p class="pt-ribbon" role="note" data-prototype-watermark="true">${WATERMARK_TEXT}</p>`;
}

function ffBar(biz, featured) {
  const order = [featured, ...AGENT_ORDER.filter(a => a !== featured)];
  const ids = { scheduling: 'book', receptionist: 'call', speed_to_lead: 'estimate', estimate_followup: 'followup' };
  return `<div class="ffbar"><div class="wrap ffbar-in">
  <span>A sample site for <b>${esc(biz.bare)}</b>, by ${esc(SENDER.name)} at FlowForward.</span>
  <div class="ffmenu"><button type="button" class="ffmenu-btn" aria-expanded="false" aria-controls="ffmenu-list" data-menu>See the 4 automations ▾</button>
  <ol class="ffmenu-list" id="ffmenu-list" hidden>${order.map((a, i) => `<li><button type="button" data-show="${ids[a]}"><b>${esc(AGENTS[a].name)}</b>${i === 0 ? ' <span class="rec">recommended</span>' : ''}<span>${esc(AGENTS[a].how)}</span></button></li>`).join('')}</ol></div>
</div></div>`;
}

function dialogs(biz, trade, days) {
  const svc = trade.services.slice(0, 5).map(([t, ic]) => `<label class="opt"><input type="radio" name="svc" value="${esc(t)}">${icon(ic)}<span>${esc(t)}</span></label>`).join('');
  const windows = ['8–11 AM', '11–2 PM', '2–5 PM'];
  const grid = days.map(d => `<div class="slot-col"><p><b>${esc(d.short)}</b> ${esc(d.day)}</p>${windows.map(w =>
    `<button type="button" class="tslot" data-slot="${esc(`${d.short} ${d.day}, ${w}`)}">${esc(w)}</button>`).join('')}</div>`).join('');
  return `
<dialog class="dlg" id="book" aria-labelledby="book-h">
  <div class="dlg-head"><h2 id="book-h">Schedule Service</h2><button type="button" class="dlg-x" data-close aria-label="Close">${icon('close')}</button></div>
  <div class="dlg-prog" aria-hidden="true"><i data-prog></i></div>
  <div class="dlg-body">
    <div data-bstep="1"><p class="dlg-q">What do you need help with?</p><div class="opts">${svc}</div></div>
    <div data-bstep="2" hidden><p class="dlg-q">Pick a time for <b class="js-svc"></b></p><div class="slots">${grid}</div><button type="button" class="linkbtn" data-bback>← Back</button></div>
    <form data-bstep="3" hidden novalidate><p class="dlg-q"><b class="js-svc"></b> · <span class="js-slot"></span></p>
      <label>Name<input name="bname" autocomplete="off" maxlength="40" placeholder="Jordan Sample"></label>
      <label>Phone<input value="(801) 555-0147" readonly aria-readonly="true"></label>
      <label>Address<input value="123 Sample St" readonly aria-readonly="true"></label>
      <button type="submit" class="btn btn-primary btn-block">Book It</button><button type="button" class="linkbtn" data-bback>← Back</button></form>
    <div data-bstep="4" hidden><p class="est-check">${icon('check')}</p><h3>You're booked for <span class="js-slot"></span></h3>
      <p class="mini-label">Confirmation text <span class="samp">sample</span></p>
      <div class="sms sms-in"><p>${esc(biz.bare)}: you're confirmed for <span class="js-svc"></span>, <span class="js-slot"></span>. We'll text when the tech is on the way. Reply C to change.</p></div>
      <p class="bts"><b>Behind the scenes:</b> added to ${esc(biz.bare)}'s calendar, confirmation text sent, reminder set for the day before.</p>
      <button type="button" class="btn btn-outline-dark" data-close>Done</button></div>
  </div>
</dialog>
<dialog class="dlg dlg-sm" id="callsheet" aria-labelledby="call-h">
  <div class="dlg-head"><h2 id="call-h">Calling ${esc(biz.bare)}…</h2><button type="button" class="dlg-x" data-close aria-label="Close">${icon('close')}</button></div>
  <div class="dlg-body"><p class="missed">${icon('phone')} No answer</p><p>Demo: imagine the crew is on a job and nobody can pick up. Nothing is dialed.</p>
  <button type="button" class="btn btn-primary btn-block" data-missed>Show what the caller gets</button></div>
</dialog>
<button type="button" class="bubble" data-text aria-label="Text ${esc(biz.bare)}">${icon('chat')}</button>
<section class="chat" id="chat" hidden aria-label="Text conversation (sample)">
  <div class="chat-head"><div><b>${esc(biz.bare)}</b><span>Usually replies in minutes · sample</span></div><button type="button" class="dlg-x" data-chat-close aria-label="Close">${icon('close')}</button></div>
  <div class="chat-log" aria-live="polite"></div>
  <form class="chat-form" data-chat-form><input name="msg" autocomplete="off" maxlength="160" placeholder="Type a reply…" aria-label="Your reply"><button type="submit" class="btn btn-primary">Send</button></form>
  <p class="bts chat-bts" hidden></p>
</section>
<nav class="callbar" aria-label="Quick actions"><a href="tel:${SAMPLE_TEL}" data-call>${icon('phone')}Call</a><a href="#top" data-text>${icon('chat')}Text</a><a href="#top" data-book>${icon('calendar')}Schedule</a></nav>
<p class="toast" role="status" hidden></p>`;
}

// ── styles ──────────────────────────────────────────────────────────────────
function css(t) {
  return `
@font-face{font-family:"Barlow Condensed";font-weight:600;font-display:swap;src:url(/demo/prototype-assets/barlow-condensed-latin-600-normal.woff2) format("woff2")}
@font-face{font-family:"Barlow Condensed";font-weight:700;font-display:swap;src:url(/demo/prototype-assets/barlow-condensed-latin-700-normal.woff2) format("woff2")}
@font-face{font-family:"Source Sans 3";font-weight:400;font-display:swap;src:url(/demo/prototype-assets/source-sans-3-latin-400-normal.woff2) format("woff2")}
@font-face{font-family:"Source Sans 3";font-weight:600;font-display:swap;src:url(/demo/prototype-assets/source-sans-3-latin-600-normal.woff2) format("woff2")}
@font-face{font-family:"Source Sans 3";font-weight:700;font-display:swap;src:url(/demo/prototype-assets/source-sans-3-latin-700-normal.woff2) format("woff2")}
:root{--brand:${t.brand};--hero:${t.heroBg};--accent:${t.accent};--on-accent:${t.onAccent};--eyebrow:${t.eyebrow};
--brand-dark:color-mix(in srgb,var(--brand) 72%,#000);--brand-ink:color-mix(in srgb,var(--brand) 22%,#0b0f14);
--brand-tint:color-mix(in srgb,var(--brand) 7%,#fff);--brand-line:color-mix(in srgb,var(--brand) 18%,#fff);
--ink:#1C2430;--ink-2:#475569;--ink-3:#64748B;--paper:#F4F6F9;--rule:#DCE1E8;
--d:"Barlow Condensed","Arial Narrow",Arial,sans-serif;--b:"Source Sans 3",system-ui,-apple-system,"Segoe UI",sans-serif;
--sh1:0 1px 2px rgba(16,24,40,.08);--sh2:0 8px 24px rgba(16,24,40,.18);color-scheme:light}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:230px;overflow-x:hidden}
body{margin:0;background:#fff;color:var(--ink);font:400 18px/1.55 var(--b);-webkit-font-smoothing:antialiased}
.wrap{max-width:1200px;margin:0 auto;padding:0 20px;position:relative}
a{color:var(--brand)}
.ic{width:24px;height:24px;flex:none;fill:none;stroke:currentColor;stroke-width:2.25;stroke-linecap:square;stroke-linejoin:miter}.ic-sm{width:16px;height:16px;vertical-align:-3px}
.small{font-size:15px}.muted{color:var(--ink-2)}
.samp{display:inline-block;font:700 11px/1.6 var(--b);letter-spacing:.08em;text-transform:uppercase;padding:0 6px;border-radius:3px;background:rgba(255,255,255,.18);color:inherit;vertical-align:1px}
.ph{border-bottom:1.5px dashed currentColor;opacity:.8}
/* watermark + FlowForward chrome */
.pt-ribbon{position:sticky;top:0;z-index:2147483000;margin:0;padding:6px 12px;min-height:32px;background:#1E2A2F!important;color:#F3F6F5!important;text-align:center;font:600 14px/1.3 var(--b);display:block!important;visibility:visible!important;opacity:1!important;pointer-events:none}
.pt-tile{position:fixed;inset:0;z-index:2147482500;pointer-events:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='168' height='96'%3E%3Ctext x='6' y='58' fill='%231E2A2F' fill-opacity='0.05' font-family='sans-serif' font-size='15' font-weight='700' transform='rotate(-30 84 48)'%3EPROTOTYPE%3C/text%3E%3C/svg%3E");background-size:168px 96px}
.ffbar{background:#2B3940;color:#DCE4E2;font-size:14px}.ffbar-in{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:38px;flex-wrap:wrap}
.ffbar b{color:#fff}.ffmenu{position:relative}
.ffmenu-btn{font:700 14px var(--b);color:#1E2A2F;background:#C9952F;border:0;border-radius:4px;padding:6px 12px;cursor:pointer;min-height:32px}
.ffmenu-list{position:absolute;right:0;top:calc(100% + 6px);z-index:60;list-style:none;margin:0;padding:6px;background:#fff;border-radius:6px;box-shadow:var(--sh2);width:min(340px,calc(100vw - 32px))}
.ffmenu-list button{display:block;width:100%;text-align:left;background:none;border:0;padding:10px;border-radius:4px;cursor:pointer;font:400 15px/1.35 var(--b);color:var(--ink)}
.ffmenu-list button:hover,.ffmenu-list button:focus-visible{background:var(--paper)}
.ffmenu-list b{font-weight:700;color:var(--ink)}.ffmenu-list button{color:var(--ink)}.ffmenu-list span:not(.rec){display:block;color:var(--ink-3);font-size:14px}.rec{font-size:12px;font-weight:700;color:#7A5A12;background:#F6EBD3;padding:0 6px;border-radius:3px}
/* utility + header */
.util{background:var(--brand-dark);color:#fff;font-size:15px}.util-in{display:flex;justify-content:space-between;align-items:center;min-height:36px;gap:12px}
.util a{color:#fff;font-weight:700;text-decoration:none}.util span{display:inline-flex;align-items:center;gap:6px}
.topbars{position:sticky;top:0;z-index:2147482800;box-shadow:0 2px 10px rgba(16,24,40,.12)}
.hdr{background:#fff;border-bottom:1px solid var(--rule)}
.hdr-in{display:flex;align-items:center;gap:22px;min-height:78px}.hdr-book{white-space:nowrap}
.hdr-brand{text-decoration:none;color:var(--ink);margin-right:auto}
.wm{display:inline-flex;align-items:center;gap:10px}.wm-glyph{display:grid;place-items:center;width:40px;height:40px;background:var(--brand);color:#fff;border-radius:4px}
.wm-glyph .ic{width:24px;height:24px}.wm-text{display:grid;line-height:1}
.wm-top{font:700 28px/1 var(--d);text-transform:uppercase;letter-spacing:.005em;color:var(--brand)}
.wm-rest{font:700 12px/1.3 var(--b);text-transform:uppercase;letter-spacing:.18em;color:var(--ink-2);margin-top:3px}
.wm-light .wm-top{color:#fff}.wm-light .wm-rest{color:rgba(255,255,255,.7)}.wm-light .wm-glyph{background:rgba(255,255,255,.12)}
.hdr-nav{display:flex;gap:18px}.hdr-nav a{white-space:nowrap;color:var(--ink);text-decoration:none;font:600 16px var(--b)}.hdr-nav a:hover{color:var(--brand)}
.hdr-phone{display:flex;align-items:center;gap:10px;white-space:nowrap;text-decoration:none;color:var(--brand)}
.hdr-phone-ic{display:grid;place-items:center;width:40px;height:40px;background:var(--brand-tint);border-radius:4px}
.hdr-phone small{display:block;font:700 12px var(--b);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3)}
.hdr-phone b{font:700 28px/1 var(--d);letter-spacing:.01em;font-variant-numeric:tabular-nums}.hdr-phone:hover b{text-decoration:underline}
.hdr-callbtn{display:none}
/* buttons */
.btn{font:600 20px/1 var(--d);text-transform:uppercase;letter-spacing:.04em;padding:15px 24px;border-radius:4px;border:2px solid transparent;min-height:52px;display:inline-flex;gap:10px;align-items:center;justify-content:center;cursor:pointer;text-decoration:none;transition:background-color .15s,color .15s}
.btn .ic{width:20px;height:20px}
.btn-primary{background:var(--accent);color:var(--on-accent)}.btn-primary:hover{background:color-mix(in srgb,var(--accent) 86%,#000)}
.btn-outline{border-color:currentColor;color:#fff;background:transparent}.btn-outline:hover{background:rgba(255,255,255,.1)}
.btn-outline-dark{border-color:var(--brand);color:var(--brand);background:#fff}
.btn-block{width:100%}
.linkbtn{background:none;border:0;color:var(--brand);font:600 16px var(--b);cursor:pointer;padding:8px 0;text-decoration:underline}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,label.opt:focus-within{outline:3px solid #C9952F;outline-offset:2px}
/* hero */
.hero{position:relative;background:var(--hero);color:#fff;overflow:hidden}
.hero-art-wrap{position:absolute;right:-40px;bottom:-10px;width:min(760px,70vw);opacity:.11;pointer-events:none}
.hero-art{width:100%;fill:none;stroke:#fff;stroke-width:4;stroke-linecap:square}
.hero-in{display:grid;grid-template-columns:7fr 5fr;gap:48px;padding-top:64px;padding-bottom:72px;align-items:start}
.eyebrow{font:700 14px/1.2 var(--b);letter-spacing:.12em;text-transform:uppercase;color:var(--eyebrow);margin:0 0 14px}.eyebrow-dark{color:var(--brand)}
.hero h1{font:700 60px/1 var(--d);text-transform:uppercase;letter-spacing:.005em;margin:0 0 18px;max-width:14ch}
.hero-sub{font-size:20px;margin:0 0 28px;max-width:44ch;color:rgba(255,255,255,.9)}
.hero-btns{display:flex;gap:14px;flex-wrap:wrap}
.hero-checks{list-style:none;padding:0;margin:28px 0 0;display:grid;gap:8px}.hero-checks li{display:flex;gap:10px;align-items:center;font-weight:600}.hero-checks .ic{color:var(--eyebrow)}
.hero-note{font-size:14px;color:rgba(255,255,255,.62);margin:10px 0 0}
.hero-bar{position:absolute;left:0;right:0;bottom:0;height:10px;background:var(--brand)}
.hero-warm h1{color:#fff}
.est-card{background:#fff;color:var(--ink);border-radius:6px;box-shadow:var(--sh2);padding:28px;position:relative;z-index:1}
.est-card h2{font:700 30px/1.05 var(--d);text-transform:uppercase;margin:0 0 6px}.est-lead{margin:0 0 18px;color:var(--ink-2)}
.est-form{display:grid;gap:14px}.est-form label,.dlg label{display:grid;gap:6px;font:600 15px var(--b)}
input,select{font:400 17px var(--b);height:52px;padding:0 12px;border:1.5px solid #B8C1CC;border-radius:4px;background:#fff;color:var(--ink);width:100%}
input[readonly]{background:var(--paper);color:var(--ink-2)}
.est-micro{margin:0;font-size:14px;color:var(--ink-3)}
.est-check{margin:0 0 6px;color:#1F7A4D}.est-check .ic{width:44px;height:44px;stroke-width:2.5}
.mini-label{margin:16px 0 6px;font:700 12px var(--b);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}.mini-label .samp{background:var(--paper)}
.sms p{margin:0;padding:10px 14px;border-radius:16px 16px 16px 4px;background:#E9EDF1;font-size:16px;line-height:1.4;max-width:92%}
.sms-out{display:flex;justify-content:flex-end}.sms-out p{background:var(--brand);color:#fff;border-radius:16px 16px 4px 16px}
.mail-prev{border:1px solid var(--rule);border-radius:4px;padding:10px 12px;font-size:15px}.mail-prev p{margin:0}.mail-subj{font-weight:700;margin-bottom:4px!important;display:flex;gap:6px;align-items:center}
.fu-line{list-style:none;margin:0;padding:0 0 0 18px;border-left:2px solid var(--brand-line);display:grid;gap:8px;font-size:15px}
.fu-line li{position:relative}.fu-line li::before{content:"";position:absolute;left:-24px;top:7px;width:10px;height:10px;border-radius:50%;background:var(--brand)}
.fu-line b{font:700 15px var(--b);margin-right:6px}
.fu-stop{font-size:14px;color:var(--ink-3);margin:8px 0 14px}.est-done-btns{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.bts{margin:16px 0 0;background:#334155;color:#E2E8F0;font-size:14px;line-height:1.45;padding:10px 12px;border-radius:4px}.bts b{color:#fff}
/* trust */
.trust{border-bottom:1px solid var(--rule)}.trust-in{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding-top:24px;padding-bottom:24px}
.slot{display:flex;align-items:center;gap:10px;border:1.5px dashed var(--rule);border-radius:4px;padding:14px 16px;color:var(--ink-3);font-size:15px;font-weight:600;position:relative}
.slot em{margin-left:auto;font:700 11px var(--b);font-style:normal;letter-spacing:.1em;text-transform:uppercase;background:var(--paper);padding:2px 6px;border-radius:3px;white-space:nowrap}
/* sections */
.sec{padding:80px 0}.sec-paper{background:var(--paper)}.sec-tight{padding:40px 0}
.sec h2,.band h2,.closer h2,.ffsec h2{font:700 42px/1.05 var(--d);text-transform:uppercase;letter-spacing:.01em;margin:0 0 28px}
.sec-head{display:flex;justify-content:space-between;align-items:end;gap:20px;flex-wrap:wrap}.sec-head h2{margin-bottom:28px}
.sec-link{font-weight:600;text-decoration:none;margin-bottom:34px;display:inline-flex;gap:6px;align-items:center}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.tile{background:#fff;border:1px solid var(--rule);border-radius:4px;padding:22px;box-shadow:var(--sh1);display:flex;flex-direction:column;gap:10px;transition:border-color .15s}
.tile:hover{border-color:var(--brand)}
.tile h3{display:flex;align-items:center;gap:12px;margin:0;font:600 24px/1.1 var(--d);text-transform:uppercase;letter-spacing:.02em;color:var(--ink)}
.tile h3 .ic{width:36px;height:36px;color:var(--brand)}
.tile ul{margin:0;padding:0;list-style:none;color:var(--ink-2);font-size:15px;display:grid;gap:2px}
.tile-link{margin-top:auto;padding:6px 0 0;background:none;border:0;text-align:left;color:var(--brand);font:600 16px var(--b);cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.tile-feat{grid-column:span 2;background:var(--brand);border-color:var(--brand);color:#fff}
.tile-feat h3,.tile-feat h3 .ic{color:#fff}.tile-feat p{margin:0;color:rgba(255,255,255,.88)}.tile-feat-btns{display:flex;gap:10px;flex-wrap:wrap;margin-top:auto}
.steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,1fr);gap:28px}
.steps li{display:flex;gap:14px;border-top:3px solid var(--brand);padding-top:16px}
.num{font:700 52px/0.9 var(--d);color:var(--brand)}.steps h3{font:600 22px/1.1 var(--d);text-transform:uppercase;margin:0 0 6px}.steps p{margin:0;font-size:16px;color:var(--ink-2)}
.band{background:var(--accent);color:var(--on-accent);border-top:6px solid var(--brand)}
.band-dark{background:var(--brand-ink);color:#fff;border-top:0}
.band-in{display:flex;justify-content:space-between;align-items:center;gap:24px;padding-top:52px;padding-bottom:52px;flex-wrap:wrap}.band h2{margin:0;max-width:22ch}
.band .btn-primary{background:var(--brand);color:#fff}.band .btn-outline{color:inherit}.band-dark .btn-primary{background:var(--accent);color:var(--on-accent)}
.band-btns{display:flex;gap:12px;flex-wrap:wrap}.band-btns.center{justify-content:center}
.offers{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.coupon{display:flex;gap:14px;align-items:flex-start;border:2px dashed var(--brand-line);background:#fff;border-radius:4px;padding:20px;position:relative}
.coupon .ic{color:var(--brand);width:30px;height:30px}.coupon h3{font:600 22px var(--d);text-transform:uppercase;margin:0 0 4px}.coupon p{margin:0;color:var(--ink-2);font-size:15px}
.coupon em{position:absolute;top:10px;right:10px;font:700 11px var(--b);font-style:normal;letter-spacing:.1em;text-transform:uppercase;background:var(--paper);padding:2px 6px;border-radius:3px;color:var(--ink-3)}
.area{display:grid;grid-template-columns:3fr 2fr;gap:40px;align-items:center}.area h2{margin-bottom:10px}
.towns{list-style:none;padding:0;margin:20px 0 0;display:grid;grid-template-columns:repeat(3,1fr);gap:10px 18px;font-weight:600}
.towns li{display:flex;gap:6px;align-items:center}.towns .ic{color:var(--brand)}
.area-box{background:var(--brand-tint);border:1px solid var(--brand-line);border-radius:4px;padding:28px}.area-box>.ic{color:var(--brand);width:36px;height:36px}.area-box h3{font:600 26px var(--d);text-transform:uppercase;margin:8px 0 6px}.area-box p{margin:0 0 18px;color:var(--ink-2)}
.revs{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:12px}.slot-tall{min-height:120px;align-items:flex-start;flex-direction:column}.slot-tall em{margin:auto 0 0}
.closer{background:var(--hero);color:#fff;text-align:center}.closer-in{padding-top:72px;padding-bottom:72px}.closer h2{margin-bottom:10px}
.closer-phone{display:inline-block;font:700 56px/1 var(--d);color:#fff;text-decoration:none;margin-bottom:24px}.closer-phone:hover{text-decoration:underline}
.sfoot{background:var(--brand-ink);color:rgba(255,255,255,.78);font-size:16px}
.sfoot-in{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:40px;padding-top:64px;padding-bottom:40px}
.sfoot h4{font:600 18px var(--d);text-transform:uppercase;letter-spacing:.04em;color:#fff;margin:6px 0 12px}
.sfoot ul{list-style:none;padding:0;margin:0;display:grid;gap:6px}.sfoot a{color:rgba(255,255,255,.85);text-decoration:none}.sfoot a:hover{color:#fff;text-decoration:underline}
.sfoot-phone{font:700 26px var(--d);color:#fff!important}.sfoot p{margin:8px 0}
.sfoot-bottom{display:flex;gap:24px;flex-wrap:wrap;border-top:1px solid rgba(255,255,255,.12);padding-top:18px;padding-bottom:22px;font-size:14px}
/* FlowForward section + prototype footer */
.ffsec{background:#EEF2F0;border-top:4px solid #C9952F;font-family:Arial,var(--b)}
.ffsec-in{display:grid;grid-template-columns:1fr 380px;gap:40px;padding-top:48px;padding-bottom:48px}
.ffsec h2{font-size:32px;color:#1E2A2F;margin-bottom:14px}.ff-kicker{margin:0 0 6px;font:700 13px var(--b);letter-spacing:.1em;text-transform:uppercase;color:#5B6B70}
.ff-steps{margin:0 0 14px;padding-left:22px}.ff-what{color:#3A4A4F;font-size:16px}
.ff-card{background:#fff;border:1px solid #D5DEDB;border-radius:6px;padding:20px}
.ff-talk{display:flex;justify-content:center;align-items:center;min-height:48px;background:#2F6B57;color:#fff;font:700 17px var(--b);border-radius:6px;text-decoration:none;margin-top:12px}
.ff-card > .ff-talk:first-child{margin-top:0}
.ff-mail{display:block;text-align:center;margin-top:8px;color:#2F6B57;font-size:15px}.ff-card .small{color:#5B6B70}
.pt-footer{background:#EEF2F0;color:#5B6B70;font-size:14px;padding:0 0 40px}.pt-footer p{max-width:1200px;margin:0 auto;padding:0 20px}
/* dialogs, chat, callbar */
.dlg{border:0;border-radius:6px;box-shadow:var(--sh2);padding:0;width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 80px);color:var(--ink)}
.dlg::backdrop{background:rgba(15,23,42,.55)}.dlg-sm{width:min(420px,calc(100vw - 32px))}
.dlg-head{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--rule)}
.dlg-head h2{font:700 28px var(--d);text-transform:uppercase;margin:0}.dlg-x{background:none;border:0;cursor:pointer;color:var(--ink-2);width:44px;height:44px;display:grid;place-items:center}
.dlg-prog{height:4px;background:var(--rule)}.dlg-prog i{display:block;height:100%;width:25%;background:var(--brand);transition:width .2s}
.dlg-body{padding:20px;display:grid;gap:12px}.dlg-body form{display:grid;gap:12px}.dlg-q{margin:0;font-weight:600}.dlg h3{font:700 26px/1.1 var(--d);text-transform:uppercase;margin:0}
.opts{display:grid;gap:8px}.opt{display:flex!important;grid-template-columns:none!important;flex-direction:row;align-items:center;gap:12px!important;border:1.5px solid var(--rule);border-radius:4px;padding:12px 14px;cursor:pointer;font-weight:600}
.opt input{width:18px;height:18px}.opt .ic{color:var(--brand)}.opt:hover{border-color:var(--brand)}
.slots{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.slot-col p{margin:0 0 6px;font-size:15px}
.tslot{display:block;width:100%;margin-bottom:6px;min-height:44px;border:1.5px solid var(--brand);background:#fff;color:var(--brand);border-radius:4px;font:600 15px var(--b);cursor:pointer}.tslot:hover{background:var(--brand-tint)}
.missed{display:flex;gap:8px;align-items:center;font:700 24px var(--d);text-transform:uppercase;color:#B42318;margin:0}
.bubble{position:fixed;right:20px;bottom:20px;z-index:45;width:58px;height:58px;border-radius:50%;border:0;background:var(--brand);color:#fff;display:grid;place-items:center;box-shadow:var(--sh2);cursor:pointer}
.chat{position:fixed;right:20px;bottom:90px;z-index:46;width:min(360px,calc(100vw - 32px));height:min(500px,calc(100vh - 160px));background:#fff;border-radius:6px;box-shadow:var(--sh2);display:flex;flex-direction:column;overflow:hidden}
.chat[hidden]{display:none}
.chat-head{display:flex;justify-content:space-between;align-items:center;background:var(--brand);color:#fff;padding:10px 6px 10px 14px}.chat-head span{display:block;font-size:13px;opacity:.85}.chat-head .dlg-x{color:#fff}
.chat-log{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#F8FAFB}
.chat-log .meta{font-size:12px;color:var(--ink-3);text-align:center}
.typing p{color:var(--ink-3)}
.chat-form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--rule)}.chat-form input{height:44px}.chat-form .btn{min-height:44px;padding:0 14px;font-size:17px}
.chat-bts{margin:0;border-radius:0}
.callbar{display:none}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147482000;background:#1E2A2F;color:#F3F6F5;padding:10px 16px;border-radius:6px;font-weight:600;max-width:calc(100% - 32px);box-shadow:var(--sh2)}.toast[hidden]{display:none}
.flash{outline:3px solid #C9952F!important;outline-offset:4px;transition:outline-color .3s}
.pt-expired{max-width:560px;width:calc(100% - 32px);margin:60px auto;background:#fff;border:1px solid var(--rule);border-radius:6px;padding:24px;position:relative;z-index:1}
.pt-expired h1{font:700 36px/1.05 var(--d);text-transform:uppercase;margin:0 0 10px}
[hidden]{display:none!important}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:1180px){.hdr-nav{display:none}}@media (max-width:1100px){.tiles{grid-template-columns:repeat(3,1fr)}.sfoot-in{grid-template-columns:1fr 1fr}}
@media (max-width:900px){.hero-in{grid-template-columns:1fr;gap:32px}.steps{grid-template-columns:1fr 1fr}.ffsec-in,.area{grid-template-columns:1fr}.trust-in{grid-template-columns:1fr 1fr}}
@media (max-width:768px){
 body{font-size:17px;padding-bottom:60px}.wrap{padding:0 16px}html{scroll-padding-top:170px}.util{display:none}.ffbar-in>span{display:none}.ffbar-in{justify-content:flex-end;min-height:40px}
 .util .util-right{display:none}.util-in{justify-content:center}
 .hdr{position:static}.hdr-in{min-height:62px;gap:10px}.hdr-phone,.hdr-book{display:none}
 .hdr-callbtn{display:grid;place-items:center;width:44px;height:44px;background:var(--brand);color:#fff;border-radius:4px}
 .wm-top{font-size:22px}.wm-rest{font-size:10px;letter-spacing:.14em}.wm-glyph{width:34px;height:34px}
 .hero-in{padding-top:36px;padding-bottom:40px}.hero h1{font-size:38px}.hero-sub{font-size:17px}.hero-btns .btn{width:100%}
 .est-card{padding:20px}.sec{padding:56px 0}.sec h2,.band h2,.closer h2{font-size:30px}
 .tiles{grid-template-columns:1fr 1fr;gap:10px}.tile{padding:16px}.tile h3{font-size:20px;gap:8px}.tile h3 .ic{width:28px;height:28px}
 .steps{grid-template-columns:1fr}.offers,.revs,.trust-in{grid-template-columns:1fr}.trust-in{gap:8px;padding-top:16px;padding-bottom:16px}.hero-art-wrap{right:0;width:100%}.slot{min-width:0}.towns{grid-template-columns:1fr 1fr}
 .band-in{padding-top:40px;padding-bottom:40px}.band-btns .btn{width:100%}.closer-phone{font-size:42px}
 .sfoot-in{grid-template-columns:1fr;gap:24px}.slots{grid-template-columns:1fr}
 .callbar{position:fixed;left:0;right:0;bottom:0;z-index:44;display:grid;grid-template-columns:1fr 1fr 1.2fr;height:60px;padding-bottom:env(safe-area-inset-bottom);box-shadow:0 -2px 8px rgba(0,0,0,.15)}
 .callbar a{display:flex;align-items:center;justify-content:center;gap:8px;font:600 18px var(--d);text-transform:uppercase;letter-spacing:.04em;text-decoration:none;color:#fff}
 .callbar a:nth-child(1){background:var(--brand)}.callbar a:nth-child(2){background:var(--brand-dark)}.callbar a:nth-child(3){background:var(--accent);color:var(--on-accent)}
 .bubble{bottom:72px;right:16px;width:52px;height:52px}.chat{right:8px;left:8px;width:auto;bottom:70px;height:min(460px,calc(100vh - 150px))}
 .dlg{width:100vw;max-width:100vw;max-height:100vh;height:100%;margin:0;border-radius:0}
 .ffsec h2{font-size:28px}.toast{bottom:72px}
}
@media (max-width:420px){.tiles{grid-template-columns:1fr}.tile-feat{grid-column:auto}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}
@media print{.pt-ribbon{background:#fff!important;color:#1E2A2F!important;border:2px solid #1E2A2F;position:static}.pt-tile{position:absolute}.callbar,.bubble,.chat{display:none}}
`;
}

// ── script ──────────────────────────────────────────────────────────────────
// No network, no HTML from input (textContent only), reads only location.hash.
function script(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028|\u2029/g, '');
  return `(function(){var D=${json};
function $(s,r){return (r||document).querySelector(s)}function $$(s,r){return [].slice.call((r||document).querySelectorAll(s))}
var toast=$('.toast'),tt;function say(t){toast.textContent='In the live version this would '+t+'.';toast.hidden=false;clearTimeout(tt);tt=setTimeout(function(){toast.hidden=true},4000)}
function setText(sel,v,root){$$(sel,root).forEach(function(n){n.textContent=v})}
function flash(el){if(!el)return;el.classList.add('flash');setTimeout(function(){el.classList.remove('flash')},1800)}
function open(d){if(!d)return;if(d.showModal){if(!d.open)d.showModal()}else d.setAttribute('open','')}
function close(d){if(!d)return;if(d.close)d.close();else d.removeAttribute('open')}
// booking
var book=$('#book'),bs=1,svc='',slot='';
function bstep(n){bs=n;$$('[data-bstep]',book).forEach(function(s){s.hidden=+s.getAttribute('data-bstep')!==n});$('[data-prog]',book).style.width=(n*25)+'%';setText('.js-svc',svc||D.services[0],book);setText('.js-slot',slot,book)}
function openBook(service){svc=service||'';slot='';$$('input[name=svc]',book).forEach(function(r){r.checked=r.value===svc});bstep(service?2:1);open(book)}
book.addEventListener('change',function(e){if(e.target.name==='svc'){svc=e.target.value;bstep(2)}});
book.addEventListener('click',function(e){var s=e.target.closest('[data-slot]');if(s){slot=s.getAttribute('data-slot');bstep(3)}if(e.target.closest('[data-bback]'))bstep(bs-1)});
$('form[data-bstep="3"]',book).addEventListener('submit',function(e){e.preventDefault();bstep(4)});
// missed call + chat
var sheet=$('#callsheet'),chat=$('#chat'),log=$('.chat-log',chat),bts=$('.chat-bts',chat),timers=[];
function clearChat(){timers.forEach(clearTimeout);timers=[];log.textContent='';bts.hidden=true}
function bubble(side,text){var w=document.createElement('div');w.className='sms '+(side==='out'?'sms-out':'sms-in');var p=document.createElement('p');p.textContent=text;w.appendChild(p);log.appendChild(w);log.scrollTop=log.scrollHeight;return w}
function meta(text){var m=document.createElement('p');m.className='meta';m.textContent=text;log.appendChild(m)}
function later(ms,fn){timers.push(setTimeout(fn,ms))}
function typing(ms,side,text,after){var t=bubble('in','…');t.classList.add('typing');later(ms,function(){t.remove();bubble(side,text);if(after)after()})}
function showChat(){chat.hidden=false;var i=$('input',chat);if(i)i.focus({preventScroll:true})}
var stage=0;
function playMissed(){clearChat();showChat();stage=1;meta('Missed call from (801) 555-0148 · sample');
 typing(900,'in',D.missedFirst,function(){later(700,function(){bubble('out',D.urgent);typing(1100,'in',D.offer,function(){stage=2;bts.textContent='Behind the scenes: the text went out within a minute of the missed call. Urgent jobs get flagged for you, and you can jump into the thread anytime.';bts.hidden=false})})})}
function playText(){clearChat();showChat();stage=3;bubble('in',D.textHello)}
$('form[data-chat-form]').addEventListener('submit',function(e){e.preventDefault();var i=e.target.elements.msg;var v=(i.value||'').replace(/[\\u0000-\\u001f]/g,'').trim().slice(0,160);if(!v)return;i.value='';bubble('out',v);
 if(stage===2){typing(900,'in',D.booked,function(){bts.textContent='Behind the scenes: booked on the calendar with the job type and phone number. Nobody had to call back.';bts.hidden=false})}
 else{typing(900,'in',D.reply,function(){stage=2})}});
// estimate form
var card=$('[data-est]');
$('form[data-est-form]').addEventListener('submit',function(e){e.preventDefault();var f=e.target;var n=(f.elements.name.value||'').replace(/[\\u0000-\\u001f]/g,'').trim().slice(0,40)||'Jordan';
 setText('.js-first',n.split(/\\s+/)[0],card);setText('.js-job',f.elements.job.value.toLowerCase(),card);$('.est-form-wrap',card).hidden=true;$('.est-done',card).hidden=false;flash(card)});
$('[data-est-reset]').addEventListener('click',function(){$('.est-form-wrap',card).hidden=false;$('.est-done',card).hidden=true});
$('[data-fu-preview]').addEventListener('click',function(){clearChat();showChat();stage=3;meta('Day 2 email, from your mailbox · sample');bubble('in',D.day2)});
// menu
var mbtn=$('[data-menu]'),mlist=$('#ffmenu-list');
function menu(on){mlist.hidden=!on;mbtn.setAttribute('aria-expanded',on?'true':'false')}
function showAuto(id){menu(false);if(id==='book')openBook();if(id==='call')open(sheet);if(id==='estimate'){var f=$('#estimate');f.scrollIntoView({block:'center'});flash(f);var inp=$('input[name=name]',f);if(inp)inp.focus({preventScroll:true})}
 if(id==='followup'){var c=$('#estimate');c.scrollIntoView({block:'center'});$('.est-form-wrap',c).hidden=true;$('.est-done',c).hidden=false;flash($('.fu-line',c))}}
// clicks
document.addEventListener('click',function(e){
 var t=e.target;if(t.closest('[data-menu]')){menu(mlist.hidden);return}
 if(!t.closest('.ffmenu'))menu(false);
 var sh=t.closest('[data-show]');if(sh){showAuto(sh.getAttribute('data-show'));return}
 var b=t.closest('[data-book]');if(b){e.preventDefault();openBook(b.getAttribute('data-service')||'');return}
 var c=t.closest('[data-call]');if(c){e.preventDefault();open(sheet);return}
 if(t.closest('[data-missed]')){close(sheet);playMissed();return}
 var tx=t.closest('[data-text]');if(tx){e.preventDefault();playText();return}
 if(t.closest('[data-chat-close]')){chat.hidden=true;return}
 var cl=t.closest('[data-close]');if(cl){close(cl.closest('dialog'));return}
 var to=t.closest('[data-toast]');if(to){e.preventDefault();say(to.getAttribute('data-toast'))}});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){menu(false);if(!chat.hidden)chat.hidden=true}});
$$('dialog').forEach(function(d){d.addEventListener('click',function(e){if(e.target===d)close(d)})});
// deep links: #book #call #estimate #followup
var h=location.hash.slice(1);if(['book','call','estimate','followup'].indexOf(h)>=0)setTimeout(function(){showAuto(h)},300);
})();`;
}

// ── page ────────────────────────────────────────────────────────────────────
function renderPrototype(row) {
  const biz = displayName(row.brand_name);
  const trade = tradeFor(row.industry);
  const city = String(row.city || '').trim().slice(0, 60);
  const t = theme(row.color_primary, row.color_secondary);
  const featured = AGENT_ORDER.includes(row.agent_type) ? row.agent_type : 'estimate_followup';
  const days = nextWeekdays(3);
  const data = {
    services: trade.services.map(s => s[0]),
    missedFirst: `Hi, this is ${biz.bare}. Sorry we missed your call! What can we help with? You can also book online here: book link`,
    urgent: trade.urgent.ask,
    offer: `Sorry about that. We can have someone out ${days[0].short} ${days[0].day}, 8–11 AM or 2–5 PM. Which works? (Type a reply.)`,
    booked: `You're booked for ${days[0].short} ${days[0].day}. We'll text when the tech is on the way.`,
    textHello: `Hi! This is ${biz.bare}. What can we help with today? Send a photo if it helps.`,
    reply: `Thanks! We can come take a look. The next open times are ${days[0].short} 8–11 AM or ${days[1].short} 11–2. Which works?`,
    day2: `Hi Jordan, following up on your ${trade.estimate.job.toLowerCase()} estimate (${trade.estimate.options[trade.estimate.pick][0]} option, ${money(trade.estimate.options[trade.estimate.pick][1])}, sample). People usually ask how long it takes and what's included, happy to answer either. — ${biz.bare}`,
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(biz.bare)} · ${esc(trade.label)} in ${esc(city || 'Utah')} (prototype)</title>
<link rel="preload" href="/demo/prototype-assets/barlow-condensed-latin-700-normal.woff2" as="font" type="font/woff2" crossorigin>
<style>${css(t)}</style>
</head><body>
<div class="pt-tile" aria-hidden="true" data-prototype-tile="true"></div>
<div class="topbars">
${ribbon()}
${ffBar(biz, featured)}
${header(biz, trade, city)}
</div>
<main id="main">
${hero(biz, trade, city, t)}
${trustStrip()}
${services(trade, city)}
${howItWorks()}
${band(trade.band, false)}
${offers()}
${area(city)}
${reviews(city)}
${closer(trade, city)}
</main>
${siteFooter(biz, trade, city)}
${flowforward(biz, featured, row.expires_at)}
<footer class="pt-footer"><p>Concept by FlowForward, sample data, not affiliated with or endorsed by <span class="pt-business">${esc(biz.raw)}</span>. This preview link expires 14 days after it was shared${row.expires_at ? ` (${esc(longDate(row.expires_at))})` : ''}.</p></footer>
${dialogs(biz, trade, days)}
<script>${script(data)}</script>
</body></html>`;
}

function renderGone(status) {
  const title = status === 410 ? 'This preview link has expired' : 'This page isn\'t available';
  const body = status === 410
    ? `Prototype links last 14 days. This link is no longer active. Ask ${esc(SENDER.name.split(' ')[0])} for a fresh one.`
    : 'The link may be mistyped or turned off.';
  const t = theme('#2F6B57', '#C9952F');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${title}</title>
<style>${css(t)}body{background:#EEF2F0}</style></head><body>${ribbon()}<div class="pt-tile" aria-hidden="true"></div>
<div class="pt-expired"><h1>${title}</h1><p class="muted">${body}</p>${status === 410 ? `<a class="ff-talk" href="${esc(SENDER.calendly)}" target="_blank" rel="noopener">Talk to Kelby</a>` : ''}</div></body></html>`;
}

// ── routes ──────────────────────────────────────────────────────────────────
const router = express.Router();

function stamp(res) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  // No network from the page: self-hosted fonts and inline code only.
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
    if (status !== 200) return res.status(status).type('html').send(renderGone(status));
    res.type('html').send(renderPrototype(row));
  } catch (err) {
    console.error('[prototype] page failed:', err && err.code);
    res.status(500).type('html').send(renderGone(404));
  }
});

function closePage(req, res) {
  stamp(res);
  if (req.method !== 'GET') {
    res.set('Allow', 'GET');
    return res.status(405).type('html').send(renderGone(404));
  }
  return res.status(404).type('html').send(renderGone(404));
}

// Last on the page router. Unmatched paths never reach cors().
router.use(closePage);

const assets = express.Router();
assets.use(express.static(path.join(__dirname, 'assets'), {
  index: false,
  // Missing files and non-GET methods call next() so the handler below
  // answers them. Nothing under this mount calls next() out of the router.
  fallthrough: true,
  maxAge: '30d',
  immutable: true,
  setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff'),
}));
assets.use((req, res) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.set('Allow', 'GET, HEAD');
    return res.status(405).type('text/plain').send('Method not allowed');
  }
  return res.status(404).type('text/plain').send('Not found');
});

module.exports = { router, assets, renderPrototype, renderGone, theme, WATERMARK_TEXT };
