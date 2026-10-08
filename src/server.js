require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const { applySchema } = require('./db/migrate');
const { rescore }     = require('./scoring/fit');
const requireApiKey   = require('./api/auth');
const { projects, tasks } = require('./api/projects');

const app = express();

// CORS — restrict to your frontend(s) with CORS_ORIGINS="https://your-app.vercel.app,http://localhost:5173".
// Unset = allow any origin (the API key still guards access).
const origins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors(origins.length ? { origin: origins } : undefined));
app.use(express.json({ limit: '1mb' }));

// Health check (open — Railway uses it)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ─── Routes ───────────────────────────────────────────────────────────────
app.use('/api', requireApiKey);
app.use('/api/prospects', require('./api/prospects'));
app.use('/api/projects',  projects);
app.use('/api/tasks',     tasks);
app.use('/api/focus',     require('./api/focus'));
app.use('/api/runs',      require('./api/runs'));

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
}

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function boot() {
  try {
    await applySchema();
    console.log('[server] ✓ Schema up to date');
    const n = await rescore();
    console.log(`[server] ✓ Fit scores refreshed for ${n} prospects`);
  } catch (err) {
    // Keep serving /health so Railway doesn't crash-loop; errors show in logs.
    console.error('[server] ✗ Startup migration/rescore failed:', err.message);
  }
  app.listen(PORT, () => {
    console.log(`[server] FlowForward Engine running on port ${PORT}`);
  });
}

boot();
