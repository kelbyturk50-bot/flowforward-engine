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

// Live chat and GET /api/public/flags are mounted before cors() and the
// global JSON parser. Chat bodies over 2 KB never inherit the 1 MB parser.
// These routes do not use cors() below; their allowlist is src/chatdemo/cors.js.
const chatMount = require('./chatdemo/mount');
chatMount.mountBeforeCors(app);
chatMount.mountPublicFlags(app);

// CORS — restrict to your frontend(s) with CORS_ORIGINS="https://your-app.vercel.app,http://localhost:5173".
// Unset = allow any origin (the API key still guards access).
// Does not apply to the public chat routers or GET /api/public/flags.
const origins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors(origins.length ? { origin: origins } : undefined));
const pilotDemo = require('./pilot/demo');
app.use(express.json({ limit: '1mb' }));
// A malformed JSON body on the chat routes is a JSON 400. The handler does
// not send the parser's HTML page or the stack.
app.use(require('./api/chat').invalidJson);
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
// 404 unless the master flag is effectively on. No mint route.
app.use('/demo/estimate-recovery', pilotDemo.router);

// Public prototype read (no API key — the token is the credential).
// Mounted before the API-key guard. Rate limit uses the prototype bucket,
// separate from the pilot demo.
app.use('/api/public/prototypes', require('./prototypes/public').router);
// The prototype page itself: sample homepage + agent click-throughs.
// Server-rendered, watermarked, no API key (the token is the credential).
app.use('/demo/prototype-assets', require('./prototypes/page').assets);
// FlowForward logo for the email signature (public, cached, no key).
app.use('/brand', require('express').static(require('path').join(__dirname, 'brand', 'assets'), { index: false, fallthrough: false, maxAge: '30d' }));
app.use('/demo/prototype', require('./prototypes/page').router);

// ─── Routes ───────────────────────────────────────────────────────────────
// requireApiKey fail-closes every /api route (503 api_key_not_configured)
// unless crmApiKeyReady(). A ready key still requires the header (401 if
// it is missing or wrong). OPTIONS is not gated. /api/public/prototypes
// is mounted above and stays public.
// The flags guard is mounted first and returns that same 503 for GET and PUT
// when the key is not ready. The campaigns gate is also mounted first: not
// ready -> 503 before the flag is read; ready and FF_CAMPAIGNS off -> the
// same 404 as an unknown path, with or without a request key.
const flagsApi = require('./api/flags');
app.use('/api/flags', flagsApi.requireFlagApiKey);
const campaignsApi = require('./api/campaigns');
app.use('/api/campaigns', campaignsApi.flagGate);
app.use('/api', requireApiKey);
app.use('/api/prospects', require('./api/prospects'));
app.use('/api/projects',  projects);
app.use('/api/tasks',     tasks);
app.use('/api/focus',     require('./api/focus'));
app.use('/api/runs',      require('./api/runs'));
app.use('/api/proposals', require('./api/proposals'));
app.use('/api/inbox',     require('./api/inbox'));
app.use('/api/prototypes', require('./api/prototypes'));
app.use('/api/brands',    require('./api/brands'));
app.use('/api/rubric',    require('./api/rubric'));
app.use('/api/flags',     flagsApi);
// CSV intake for Pilot #1. The shared guard returns 503 when the key is
// not ready. When the key is ready, 404 unless the master flag is effectively
// on (database row true, and the env var is not a trimmed case-insensitive
// "false", "off", "0", or "no"). These routes do not send mail.
app.use('/api/pilot/estimate-recovery', require('./api/pilot-estimates'));
// Tracking only. GET /api/campaigns and /api/campaigns/metrics. Does not send.
app.use('/api/campaigns', campaignsApi.router);
// Facts sheet and spend read. requireApiKey is also applied inside the router.
app.use('/api/chat', require('./api/chat'));

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
  // skips rescore. A lock or statement timeout is logged as the SQLSTATE
  // only (55P03 or 57014), with no query text. Brand, estimate, and pilot
  // steps do not run after that throw. Those steps return reports instead
  // of throwing, so their own failures do not take this path. A brand-check
  // or estimate-check failure is a warning. The listen call below still runs.
  let mainOk = false;
  try {
    const report = await applySchema();
    mainOk = true;
    await concludeSchemaBoot(report);
  } catch (err) {
    pilotTokens.closePilot();
    if (err && (err.code === '55P03' || err.code === '57014')) console.error(err.code);
    else console.error('[server] ✗ Startup migration/rescore failed:', err.message);
  }
  if (mainOk) {
    try {
      await require('./proposals/jobs').recover();
      await require('./proposals/inbox').recover();
      const n = await rescore();
      console.log(`[server] ✓ Fit scores refreshed for ${n} prospects`);
    } catch (err) {
      console.error('[server] ✗ Startup migration/rescore failed:', err.message);
    }
    try {
      chatMount.startMaintenance();
    } catch (err) {
      console.error('[chatdemo] maintenance_failed', err && err.code ? err.code : 'error');
    }
  }
  app.listen(PORT, () => {
    console.log(`[server] FlowForward Engine running on port ${PORT}`);
  });
}

boot();
