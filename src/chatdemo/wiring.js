// Production wiring for the live gate. nodeEnv is the process value.
// The ceiling reader takes the process env on each call. It does not read a table.

const cfg = require('../proposals/config');
const { effective } = require('../flags/resolve');
const { readCeiling } = require('./ceiling');
const { makeDefaultLiveGate } = require('./gate');

async function flags(name) {
  if (name === 'FF_LIVE_CHAT_MODEL') return process.env.FF_LIVE_CHAT_MODEL === 'true';
  const view = await effective(name);
  return view.effective === true;
}

async function checkCaps(ctx) {
  return !!(ctx && ctx.capHit === true);
}

const defaultLiveGate = makeDefaultLiveGate({
  nodeEnv: process.env.NODE_ENV,
  flags,
  ceiling: () => readCeiling(process.env),
  caps: checkCaps,
  anthropicConfigured: cfg.anthropicConfigured,
  priced: () => Boolean(cfg.PRICES && cfg.PRICES[cfg.MODEL]),
});

module.exports = { defaultLiveGate, flags, checkCaps };
