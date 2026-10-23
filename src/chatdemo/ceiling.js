// Daily live-chat spend ceiling. Env only. No database row and no code default.
// Unset, empty, non-numeric, non-finite, zero, negative, or a value that
// rounds to 0 micro-dollars keeps the live responder off.

const ENV_KEY = 'CHAT_DEMO_DAILY_CEILING_USD';

function usdToMicros(usd) {
  const micros = Math.round(usd * 1e6);
  if (!Number.isSafeInteger(micros)) return null;
  return micros;
}

function readCeiling(env = process.env) {
  if (!env || !Object.prototype.hasOwnProperty.call(env, ENV_KEY)) return null;
  const raw = env[ENV_KEY];
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  const micros = usdToMicros(dollars);
  if (micros == null || micros <= 0) return null;
  return micros;
}

module.exports = { ENV_KEY, readCeiling, usdToMicros };
