// HTML version of an outgoing email (sent alongside the plain text).
//
// Kept deliberately close to a personal email so it reads as one person
// writing, not a newsletter: normal text, no banners, no big buttons, no
// tracking. What it adds over plain text:
//   - links become short descriptive text instead of long raw URLs
//     ("See the ideas for Beehive" rather than https://…/p/beehive-…)
//   - a real signature with the FlowForward logo (one small hosted image)
//   - the CAN-SPAM footer in small gray text
// Every string from the draft is escaped. The plain-text part is unchanged.

const cfg = require('./config');

const { SENDER } = cfg;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const URL_RE = /https?:\/\/[^\s<>"')]+[^\s<>"').,;:!?]/g;
const LOGO_PATH = '/brand/flowforward-logo.png';
const FONT = "font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1E2A2F";

function shopName(p) {
  return String(p && p.company || '').replace(/^test:\s*/i, '').trim() || 'your shop';
}

// Short anchor text for links we know; anything else shows its host.
function labelFor(url, p) {
  const base = cfg.PUBLIC_BASE_URL;
  if (url.startsWith(`${base}/p/`)) return 'See the one-pager';
  if (url.startsWith(`${base}/demo/prototype/`)) return 'Open the prototype';
  if (SENDER.calendly && url.startsWith(SENDER.calendly)) return 'Grab 15 minutes on my calendar';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function linkify(line, p, ownLine) {
  let out = ''; let last = 0;
  for (const m of line.matchAll(URL_RE)) {
    out += esc(line.slice(last, m.index));
    const url = m[0];
    const label = labelFor(url, p);
    out += `<a href="${esc(url)}" style="color:#2F6B57;font-weight:bold;text-decoration:underline">${esc(label)}${ownLine ? ' &rarr;' : ''}</a>`;
    last = m.index + url.length;
  }
  return out + esc(line.slice(last));
}

// The sign-off is the last paragraph when it starts with the sender's first
// name ("Kelby" / "Kelby\nKelby Turk, ..."). It is replaced by the HTML
// signature so the name, title, and town aren't printed twice.
function splitSignoff(paras) {
  const first = SENDER.name.split(' ')[0];
  const last = paras[paras.length - 1] || '';
  const re = new RegExp(`^(—\\s*|-\\s*)?${first}\\b`, 'i');
  if (paras.length > 1 && re.test(last.trim())) {
    // Keep the short closing ("Kelby"); the signature block replaces the rest.
    const closing = last.trim().split('\n')[0].trim();
    return { body: [...paras.slice(0, -1), closing], signed: true };
  }
  return { body: paras, signed: false };
}

function signature() {
  const base = cfg.PUBLIC_BASE_URL;
  const site = String(process.env.SENDER_WEBSITE || '').trim();
  const contact = [
    SENDER.phone ? esc(SENDER.phone) : '',
    `<a href="mailto:${esc(SENDER.email)}" style="color:#5B6B70;text-decoration:none">${esc(SENDER.email)}</a>`,
    site ? `<a href="${esc(site)}" style="color:#5B6B70;text-decoration:none">${esc(site.replace(/^https?:\/\//, ''))}</a>` : '',
  ].filter(Boolean).join(' &middot; ');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;border-top:1px solid #E3E8E6;padding-top:14px">
<tr><td style="padding-top:14px;vertical-align:top">
<img src="${esc(base + LOGO_PATH)}" width="150" height="30" alt="FlowForward" style="display:block;border:0;width:150px;height:auto;margin-bottom:10px">
<div style="${FONT};font-size:15px"><strong>${esc(SENDER.name)}</strong></div>
<div style="${FONT};font-size:13px;color:#5B6B70">${esc(SENDER.title)}, ${esc(SENDER.company)} &middot; ${esc(SENDER.hometown)}</div>
<div style="${FONT};font-size:13px;color:#5B6B70">${contact}</div>
</td></tr></table>`;
}

function legal() {
  return `<p style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;color:#8A979B;margin:22px 0 0">${esc(SENDER.company)} &middot; ${esc(SENDER.address)}<br>Not interested? Reply &ldquo;no thanks&rdquo; and I won&rsquo;t reach out again.</p>`;
}

// text: the message body after placeholders are filled (no footer).
function renderHtml(text, p, { signature: withSig = true, footer = true } = {}) {
  // "…on one page here:" followed by a bare link reads better as one line.
  const raw = String(text || '').replace(/\r\n/g, '\n').trim()
    .replace(/:[ \t]*\n{1,2}[ \t]*(https?:\/\/\S+)[ \t]*(?=\n|$)/g, ': $1');
  const paras = raw.split(/\n{2,}/);
  const { body, signed } = withSig ? splitSignoff(paras) : { body: paras, signed: false };
  const html = body.map((para) => {
    const lines = para.split('\n');
    const inner = lines.map((l) => {
      const own = /^\s*https?:\/\/\S+\s*$/.test(l) || /:\s+https?:\/\/\S+\s*$/.test(l);
      return linkify(l.trim(), p, own);
    }).join('<br>');
    return `<p style="margin:0 0 14px">${inner}</p>`;
  }).join('\n');
  const sign = signed ? signature() : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#ffffff">
<div style="${FONT};max-width:600px;padding:4px 2px">
${html}
${sign}
${footer ? legal() : ''}
</div></body></html>`;
}

module.exports = { renderHtml, labelFor, LOGO_PATH };
