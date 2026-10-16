require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const { applySchema } = require('./db/migrate');
const { concludeSchemaBoot } = require('./pilot/schema');
const pilotTokens = require('./pilot/tokens');
const { rescore }     = require('./scoring/fit');
const requireApiKey   = require('./api/auth');
const { projects, tasks } = require('./api/projects');

const app = express();

// Railway terminates one reverse proxy in front of this process.
// trust proxy = 1 trusts that hop only. The pilot rate limit uses the
// right-most X-Forwarded-For address — the client Railway appended — and
// ignores a left-most value the caller can spoof. See src/pilot/rate-limit.js.
app.set('trust proxy', 1);

// CORS — restrict to your frontend(s) with CORS_ORIGINS="https://your-app.vercel.app,http://localhost:5173".
// Unset = allow any origin (the API key still guards access).
const origins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors(origins.length ? { origin: origins } : undefined));
const pilotDemo = require('./pilot/demo');
app.use(express.json({ limit: '1mb' }));
// A body over the JSON limit fails here, before the demo router. Stamp the
// public demo 413 with the same noindex / no-store headers as a demo 404.
app.use(pilotDemo.payloadTooLarge);

// Health check (open — Railway uses it)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Google sign-in callback for "Connect Gmail" (public; protected by a one-time state value)
app.get('/oauth/google/callback', async (req, res) => {
  const gmail = require('./proposals/gmail');
  let result;
  try { result = await gmail.handleCallback(req.query); }
  catch (err) { result = { ok: false, message: err.response?.data?.error_description || err.message }; }
  const back = result.returnTo ? `${result.returnTo.replace(/#.*$/, '')}#/settings?gmail=${result.ok ? 'connected' : 'error'}` : null;
  const esc = (t) => String(t || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gmail ${result.ok ? 'connected' : 'not connected'}</title>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#1E2A2F">
<h1 style="font-size:1.5rem">${result.ok ? `Gmail connected` : `Gmail not connected`}</h1>
<p>${result.ok ? `FlowForward can now send from <strong>${esc(result.email)}</strong> and watch its inbox for replies.` : esc(result.message)}</p>
${back ? `<p><a href="${esc(back)}" style="color:#2F6B57;font-weight:600">Back to the CRM</a></p><script>setTimeout(()=>location.href=${JSON.stringify(back)},${result.ok ? 1500 : 6000})</script>` : '<p>You can close this tab.</p>'}
</body>`);
});

// Public one-page proposals (no API key — the slug is unguessable)
app.use('/p', require('./proposals/onepager').router);

// Public pilot demo (no API key — the token is the credential).
// 404 unless FF_PILOT_ESTIMATE_RECOVERY is exactly "true". No mint route.
app.use('/demo/estimate-recovery', pilotDemo.router);

// ─── Routes ───────────────────────────────────────────────────────────────
app.use('/api', requireApiKey);
app.use('/api/prospects', require('./api/prospects'));
app.use('/api/projects',  projects);
app.use('/api/tasks',     tasks);
app.use('/api/focus',     require('./api/focus'));
app.use('/api/runs',      require('./api/runs'));
app.use('/api/proposals', require('./api/proposals'));
app.use('/api/brands',    require('./api/brands'));
app.use('/api/rubric',    require('./api/rubric'));
// CSV intake for Pilot #1. 404 unless FF_PILOT_ESTIMATE_RECOVERY is exactly
// "true". These routes do not send mail.
app.use('/api/pilot/estimate-recovery', require('./api/pilot-estimates'));

// ─── Scheduled discovery bot ───────────────────────────────────────────────
const CRON_SCHEDULE = process.env.DISCOVERY_CRON || '0 6 * * *';

if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_CRON !== '1') {
  cron.schedule(CRON_SCHEDULE, async () => {
    console.log(`[cron] Triggering discovery run at ${new Date().toISOString()}`);
    const { runDiscovery } = require('./bot/discover');
    try {
      await runDiscovery();
    } catch (err) {
      console.error('[cron] Discovery run failed:', err.message);
    }
  }, { timezone: process.env.CRON_TZ || 'America/Denver' });
  console.log(`[server] Discovery cron scheduled: ${CRON_SCHEDULE} (${process.env.CRON_TZ || 'America/Denver'})`);

  // ─── Proposal bot: nightly drafts + follow-up sender / inbox watcher ─────
  const pcfg = require('./proposals/config');
  if (process.env.DISABLE_PROPOSAL_CRON !== '1') {
    // Nightly drafting only when PROPOSAL_AUTO_DRAFT=1; otherwise drafts are made on demand.
    if (pcfg.AUTO_DRAFT) {
      cron.schedule(pcfg.CRON, async () => {
        if (!pcfg.anthropicConfigured()) return console.log('[cron] Proposal drafting skipped: ANTHROPIC_API_KEY not set');
        const { runProposalBatch } = require('./proposals/draft');
        try { await runProposalBatch({ trigger: 'nightly' }); }
        catch (err) { console.error('[cron] Proposal run failed:', err.message); }
      }, { timezone: pcfg.SEND_TZ });
    }
    // Follow-ups for emails you approved + reply/opt-out detection. Sends nothing you haven't approved.
    cron.schedule(pcfg.SENDER_CRON, () => require('./proposals/send').senderTick(), { timezone: pcfg.SEND_TZ });
    console.log(`[server] Proposal drafting: ${pcfg.AUTO_DRAFT ? `automatic (${pcfg.CRON})` : 'on demand only'}; follow-ups/inbox: ${pcfg.SENDER_CRON}`);
  }
}

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function boot() {
  // schema.sql throws on failure, the same as before the pilot. That catch
  // logs the startup line and skips rescore. The brand-check step and the
  // pilot step return reports instead of throwing, so those failures do not
  // take this path. A brand-check failure is a warning. The server still boots.
  let mainOk = false;
  try {
    const report = await applySchema();
    mainOk = true;
    await concludeSchemaBoot(report);
  } catch (err) {
    pilotTokens.closePilot();
    console.error('[server] ✗ Startup migration/rescore failed:', err.message);
  }
  if (mainOk) {
    try {
      await require('./proposals/jobs').recover();
      const n = await rescore();
      console.log(`[server] ✓ Fit scores refreshed for ${n} prospects`);
    } catch (err) {
      console.error('[server] ✗ Startup migration/rescore failed:', err.message);
    }
  }
  app.listen(PORT, () => {
    console.log(`[server] FlowForward Engine running on port ${PORT}`);
  });
}

boot();
