// Mount points for the live chat demo.
// Chat POSTs go on before cors(). The public flag read goes on after cors()
// and before the shared /api guard.

const NOT_FOUND = Buffer.from('{"error":"not_found"}');

function chatNotFound(res) {
  res.status(404);
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.end(NOT_FOUND);
}

function mountBeforeCors(app) {
  const { demoRouter, prototypeChatRouter } = require('./public');
  app.use('/api/public/chat', demoRouter);
  app.use('/api/public/prototypes/:token/chat', prototypeChatRouter);
  // A token that is not valid percent-encoding throws while the route
  // param is decoded. That is the same 404 as any other unknown token.
  app.use((err, req, res, next) => {
    const raw = req.originalUrl || '';
    const chat = raw.startsWith('/api/public/chat') || raw.startsWith('/api/public/prototypes/');
    if (chat && err instanceof URIError) return chatNotFound(res);
    return next(err);
  });
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
