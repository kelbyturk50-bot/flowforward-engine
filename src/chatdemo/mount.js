// Mount points for the live chat demo.
// Chat POSTs go on before cors(). The public flag read goes on after cors()
// and before the shared /api guard.

function mountBeforeCors(app) {
  const { demoRouter, prototypeChatRouter } = require('./public');
  app.use('/api/public/chat', demoRouter);
  app.use('/api/public/prototypes/:token/chat', prototypeChatRouter);
}

function mountPublicFlags(app) {
  app.use('/api/public/flags', require('../api/public-flags'));
}

function startMaintenance() {
  if (process.env.NODE_ENV === 'test') return;
  const { purge } = require('./counters');
  const { sweep } = require('./spend');
  const { logErr } = require('./log');
  const tick = () => {
    const at = new Date();
    purge(at).catch((err) => logErr('ip_purge_failed', err));
    sweep(at).catch((err) => logErr('reservation_expired', err));
  };
  tick();
  const timer = setInterval(tick, 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = { mountBeforeCors, mountPublicFlags, startMaintenance };
