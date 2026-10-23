// Daily live-chat spend ceiling. Env only. No database row and no code default.
// The value must be a plain decimal string matching DECIMAL: digits, with an
// optional dot and one or two decimal places. No spaces, sign, exponent, hex,
// binary, or leading dot. It must be greater than 0 and at most
// MAX_CEILING_USD (100000, one hundred thousand dollars per America/Denver
// day). Anything else leaves the live responder off.

const ENV_KEY = 'CHAT_DEMO_DAILY_CEILING_USD';
const MAX_CEILING_USD = 100000;
const DECIMAL = /^\d+(\.\d{1,2})?$/;

function usdToMicros(usd) {
  const micros = Math.round(usd * 1e6);
  if (!Number.isSafeInteger(micros)) return null;
  return micros;
}

function readCeiling(env = process.env) {
  if (!env || !Object.prototype.hasOwnProperty.call(env, ENV_KEY)) return null;
  const raw = env[ENV_KEY];
  if (typeof raw !== 'string' || !DECIMAL.test(raw)) return null;
  const dollars = Number(raw);
  if (!Number.isFinite(dollars) || dollars <= 0 || dollars > MAX_CEILING_USD) return null;
  const micros = usdToMicros(dollars);
  if (micros == null || micros <= 0) return null;
  return micros;
}

module.exports = { ENV_KEY, MAX_CEILING_USD, DECIMAL, readCeiling, usdToMicros };
