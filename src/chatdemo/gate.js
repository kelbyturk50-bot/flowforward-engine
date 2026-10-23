// Default live gate. Every input is injected so each condition can be tested alone.
// The gate does not reserve spend.

function makeDefaultLiveGate({ nodeEnv, flags, ceiling, caps, anthropicConfigured, priced }) {
  return async function liveGate(ctx) {
    if (nodeEnv === 'test') return false;
    if (typeof flags !== 'function') return false;
    if (!(await flags('FF_PROTOTYPE_GALLERY'))) return false;
    if (!(await flags('FF_LIVE_CHAT_DEMO'))) return false;
    if (!(await flags('FF_LIVE_CHAT_MODEL'))) return false;
    const amount = typeof ceiling === 'function' ? ceiling() : null;
    if (amount == null || amount <= 0) return false;
    if (typeof caps === 'function' && (await caps(ctx))) return false;
    if (typeof anthropicConfigured !== 'function' || !anthropicConfigured()) return false;
    if (typeof priced !== 'function' || !priced()) return false;
    return true;
  };
}

module.exports = { makeDefaultLiveGate };
