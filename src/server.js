require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────
app.use('/api/prospects', require('./api/prospects'));
app.use('/api/runs',      require('./api/runs'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ─── Scheduled discovery bot ───────────────────────────────────────────────
const CRON_SCHEDULE = process.env.DISCOVERY_CRON || '0 6 * * *';

if (process.env.NODE_ENV !== 'test') {
  cron.schedule(CRON_SCHEDULE, async () => {
    console.log(`[cron] Triggering discovery run at ${new Date().toISOString()}`);
    const { runDiscovery } = require('./bot/discover');
    try {
      await runDiscovery();
    } catch (err) {
      console.error('[cron] Discovery run failed:', err.message);
    }
  });
  console.log(`[server] Discovery cron scheduled: ${CRON_SCHEDULE}`);
}

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] FlowForward Engine running on port ${PORT}`);
  console.log(`[server] Health: http://localhost:${PORT}/health`);
  console.log(`[server] Prospects: http://localhost:${PORT}/api/prospects`);
});
