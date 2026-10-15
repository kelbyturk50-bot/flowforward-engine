// Public, personalized one-page proposal: GET /p/:slug
// No login — the slug is unguessable. Opens are counted (CRM previews add ?preview=1).

const express = require('express');
const pool    = require('../db/client');
const { SENDER } = require('./config');

const router = express.Router();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// "FlowForward" renders as the two-tone wordmark; any other company name stays plain.
const wordmark = (name) => /^FlowForward$/.test(name) ? 'Flow<span class="fwd">Forward</span>' : esc(name);
const para = (s) => esc(s).split(/\n{2,}/).map(x => `<p>${x.replace(/\n/g, '<br>')}</p>`).join('');
const BOT_UA = /bot|crawler|spider|preview|slurp|facebookexternalhit|google-?(read|inspection)|linkedin|skype|whatsapp|proofpoint|mimecast|barracuda|scanner/i;

function renderPage(p, lead) {
  const o = p.onepager || {};
  const first = SENDER.name.split(' ')[0];
  const mailto = `mailto:${SENDER.email}?subject=${encodeURIComponent(`Re: ideas for ${lead.company}`)}`;
  const obs = (o.observations || []).map(x => `<li><h3>${esc(x.title)}</h3><p>${esc(x.detail)}</p></li>`).join('');
  const opps = (o.opportunities || []).map((x, i) => `
    <article class="opp">
      <span class="num">${i + 1}</span>
      <div>
        <h3>${esc(x.title)}</h3>
        ${x.problem ? `<p class="lbl">What's happening</p><p>${esc(x.problem)}</p>` : ''}
        ${x.solution ? `<p class="lbl">What I'd build</p><p>${esc(x.solution)}</p>` : ''}
        ${x.impact ? `<div class="impact"><p class="lbl">Rough impact</p><p>${esc(x.impact)}</p>${x.assumptions ? `<p class="assume">${esc(x.assumptions)}</p>` : ''}</div>` : ''}
      </div>
    </article>`).join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(o.headline || `Ideas for ${lead.company}`)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Barlow+Semi+Condensed:wght@600;700&display=swap" rel="stylesheet">
<style>
:root{--paper:#F3F6F5;--surface:#fff;--ink:#1E2A2F;--ink-2:#55656B;--line:#D5DEDB;--juniper:#2F6B57;--juniper-wash:#E3EFEA;--ochre:#C9952F;--ochre-wash:#F7EBCF;color-scheme:light}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--paper);color:var(--ink);font-family:Barlow,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:17px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto;padding:0 20px}
header.top{background:var(--ink);color:#fff;padding:22px 0 64px;position:relative;overflow:hidden}
header.top svg.ridge{position:absolute;left:0;right:0;bottom:-1px;width:100%;height:70px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:1.15rem;letter-spacing:-.015em}
.brand svg{width:32px;height:32px;flex:none}
.brand .fwd{color:#8CCFB2}
.for{margin-top:40px;font-family:"Barlow Semi Condensed",Barlow,sans-serif;text-transform:uppercase;letter-spacing:.12em;font-size:.82rem;color:#B8C9C4}
h1{font-size:clamp(1.8rem,5vw,2.6rem);line-height:1.12;margin:.35rem 0 0;font-weight:700;letter-spacing:-.01em;max-width:22ch}
main{margin-top:-28px;position:relative}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:28px;margin-bottom:20px;box-shadow:0 8px 24px rgba(30,42,47,.06)}
.intro p{font-size:1.1rem;margin:0 0 .8em}.intro p:last-child{margin:0}
.sig{display:flex;gap:14px;align-items:center;margin-top:18px;padding-top:18px;border-top:1px solid var(--line)}
.avatar{width:46px;height:46px;border-radius:50%;background:var(--juniper);color:#fff;display:grid;place-items:center;font-weight:700;font-size:1.1rem;flex:none}
.sig strong{display:block}.sig span{color:var(--ink-2);font-size:.95rem}
h2{font-size:1.25rem;margin:0 0 16px}
ul.obs{list-style:none;margin:0;padding:0;display:grid;gap:14px}
ul.obs li{border-left:3px solid var(--ochre);padding:2px 0 2px 14px}
ul.obs h3{margin:0;font-size:1.02rem}ul.obs p{margin:.2em 0 0;color:var(--ink-2)}
.opp{display:grid;grid-template-columns:40px 1fr;gap:14px;padding:20px 0;border-top:1px solid var(--line)}
.opp:first-of-type{border-top:0;padding-top:4px}
.num{width:36px;height:36px;border-radius:50%;background:var(--juniper-wash);color:var(--juniper);display:grid;place-items:center;font-family:"Barlow Semi Condensed",sans-serif;font-weight:700;font-size:1.1rem}
.opp h3{margin:4px 0 8px;font-size:1.15rem}.opp p{margin:0 0 .6em}
.lbl{font-family:"Barlow Semi Condensed",sans-serif;text-transform:uppercase;letter-spacing:.1em;font-size:.75rem;color:var(--ink-2);margin:.8em 0 .15em!important}
.impact{background:var(--ochre-wash);border-radius:10px;padding:4px 14px 10px;margin-top:10px}
.assume{font-size:.88rem;color:#6b5a2e;margin:0!important}
ol.steps{margin:0;padding:0;list-style:none;display:grid;gap:12px;counter-reset:s}
ol.steps li{counter-increment:s;display:grid;grid-template-columns:28px 1fr;gap:10px}
ol.steps li::before{content:counter(s);font-family:"Barlow Semi Condensed",sans-serif;font-weight:700;color:var(--juniper)}
.cta{background:var(--juniper);color:#fff;border:0}
.cta h2{color:#fff}.cta p{color:#E3EFEA;margin:0 0 18px}
.btns{display:flex;flex-wrap:wrap;gap:12px}
.btn{display:inline-block;padding:13px 22px;border-radius:10px;font-weight:600;text-decoration:none;font-size:1.02rem}
.btn-main{background:#fff;color:var(--juniper)}.btn-alt{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.6)}
.btn:focus-visible{outline:3px solid var(--ochre);outline-offset:2px}
.pdf-bar{display:flex;justify-content:flex-end;padding:14px 0 6px}
.btn-pdf{display:inline-flex;align-items:center;gap:8px;padding:9px 18px;border-radius:9px;font-weight:600;font-size:.9rem;background:var(--surface);color:var(--ink);border:1.5px solid var(--line);cursor:pointer;text-decoration:none;box-shadow:0 2px 8px rgba(30,42,47,.07);transition:box-shadow .15s}
.btn-pdf:hover{box-shadow:0 4px 14px rgba(30,42,47,.13)}.btn-pdf svg{flex:none}
footer{color:var(--ink-2);font-size:.85rem;padding:12px 0 40px;text-align:center}
@media (max-width:560px){.card{padding:20px}.opp{grid-template-columns:1fr}.num{margin-bottom:-6px}}
@media print{
  @page{margin:0.6in}
  body{background:#fff;font-size:14px}
  header.top{background:#1E2A2F;color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  header.top svg.ridge{display:none}
  .card{box-shadow:none;break-inside:avoid;border:1px solid #D5DEDB}
  .cta{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .pdf-bar{display:none}
  a[href]::after{content:none}
}
</style></head>
<body>
<header class="top"><div class="wrap">
  <div class="brand"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M2 44 L20 16 L30 30 L42 12 L62 44 Z" fill="#F3F6F5"/><path d="M29 30 C24 36 22 42 30 46 C38 50 50 50 62 52 L62 58 C48 58 34 58 25 52 C17 47 21 37 29 30 Z" fill="#7FB0DA" stroke="#1E2A2F" stroke-width="2.5" stroke-linejoin="round"/></svg>${wordmark(SENDER.company)}</div>
  <p class="for">Prepared for ${esc(lead.company)}${lead.city ? ` · ${esc(lead.city)}` : ''}</p>
  <h1>${esc(o.headline || `A few ideas for ${lead.company}`)}</h1>
</div>
<svg class="ridge" viewBox="0 0 1440 70" preserveAspectRatio="none" aria-hidden="true"><path d="M0 70 L0 44 L180 20 L330 46 L520 8 L700 40 L860 18 L1040 48 L1220 14 L1440 38 L1440 70 Z" fill="#F3F6F5"/></svg>
</header>
<div class="wrap pdf-bar">
  <button class="btn-pdf" onclick="window.print()" title="Save as PDF">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    Save as PDF
  </button>
</div>
<main class="wrap">
  <section class="card intro">
    ${para(o.intro)}
    <div class="sig"><div class="avatar" aria-hidden="true">${esc(SENDER.name.split(' ').map(w => w[0]).join('').slice(0, 2))}</div>
      <div><strong>${esc(SENDER.name)}</strong><span>${esc(SENDER.title)}, ${esc(SENDER.company)} · ${esc(SENDER.hometown)}</span></div></div>
  </section>
  ${obs ? `<section class="card"><h2>What I noticed</h2><ul class="obs">${obs}</ul></section>` : ''}
  ${opps ? `<section class="card"><h2>Where I think I can help</h2>${opps}</section>` : ''}
  <section class="card"><h2>How working together starts</h2>
    <ol class="steps">
      <li><span><strong>A free 15-minute call.</strong> You tell me where the day gets eaten up. No pitch deck.</span></li>
      <li><span><strong>A look at how things run now.</strong> Calls, leads, quotes, scheduling, follow-up. I'm local, so I can come to you.</span></li>
      <li><span><strong>A short plan.</strong> The one or two changes that pay off fastest, in plain English.</span></li>
      <li><span><strong>I build it and hand it over.</strong> Set up around the tools you already use, and your team knows how it works.</span></li>
    </ol>
  </section>
  <section class="card cta" id="talk">
    <h2>Want to talk it through?</h2>
    ${para(o.closing || `Reply to my email with any questions, or grab 15 minutes on my calendar. Either way, happy to help.`)}
    <div class="btns">
      <a class="btn btn-main" href="${esc(SENDER.calendly)}" target="_blank" rel="noopener">Book a free 15-minute call</a>
      <a class="btn btn-alt" href="${esc(mailto)}">Email ${esc(first)}</a>
    </div>
  </section>
</main>
<footer class="wrap">${esc(SENDER.name)} · ${esc(SENDER.company)} · ${esc(SENDER.email)}${SENDER.phone ? ` · ${esc(SENDER.phone)}` : ''}${SENDER.address ? `<br>${esc(SENDER.address)}` : ''}<br>Estimates on this page are rough and based on public information.</footer>
</body></html>`;
}

router.get('/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pr.*, p.company, p.city FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id WHERE pr.slug = $1`, [req.params.slug]);
    const p = rows[0];
    if (!p || p.status === 'discarded') return res.status(404).type('html').send('<!doctype html><title>Not found</title><p style="font-family:sans-serif;padding:2rem">This page isn\'t available.</p>');
    const preview = req.query.preview === '1';
    if (!preview && p.sent_at && !BOT_UA.test(req.get('user-agent') || '')) {
      pool.query(`UPDATE proposals SET views = views + 1, last_viewed_at = NOW() WHERE id = $1`, [p.id]).catch(() => {});
    }
    res.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex, nofollow');
    res.type('html').send(renderPage(p, { company: p.company, city: p.city }));
  } catch (err) {
    res.status(500).type('text').send('Something went wrong.');
  }
});

module.exports = { router, renderPage };
