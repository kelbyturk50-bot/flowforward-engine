// Voice receptionist demo: configuration and caps. docs/VOICE_DEMO.md.
//
// Live calls cost money per minute, so turning them on is env-only, the same
// rule as FF_LIVE_CHAT_MODEL (Warden: any CRM key holder can flip a DB flag).
// All three env vars must be set and valid, or the voice demo is off:
//   RETELL_API_KEY            the Retell secret key (never sent to a browser)
//   RETELL_AGENT_ID           the Retell agent that answers (agent_...)
//   VOICE_DEMO_DAILY_MINUTES  whole minutes per America/Denver day, 1-600
// There is no default for any of them. NODE_ENV=test is always off unless a
// test injects a config.

const VOICE_CAPS = Object.freeze({
  // One call. Retell's minimum for max_call_duration_ms is 60000.
  maxCallSeconds: 180,
  // Silence after the agent speaks ends the call (Retell minimum 10000).
  silenceEndMs: 20000,
  // Per prototype link, over its 14-day life.
  callsPerLink: 3,
  secondsPerLink: 360,
  // Session mints per IP per clock hour (in-memory, fixed bucket).
  mintsPerIpHour: 4,
  // Calls that may run at once across every link.
  concurrentCalls: 3,
  // A reservation with no end event after this long stops counting as live.
  // Its full reserved time still counts against the day and the link.
  reservationTtlMs: 15 * 60 * 1000,
  // Retell create-web-call timeout.
  retellTimeoutMs: 10000,
});

const MINUTES = /^[1-9]\d{0,2}$/;
const AGENT_ID = /^agent_[A-Za-z0-9]{8,64}$/;
const API_KEY = /^[A-Za-z0-9_-]{16,200}$/;
const MAX_DAILY_MINUTES = 600;

function readDailyMinutes(env) {
  const raw = env && env.VOICE_DEMO_DAILY_MINUTES;
  if (typeof raw !== 'string' || !MINUTES.test(raw)) return null;
  const minutes = Number(raw);
  return minutes >= 1 && minutes <= MAX_DAILY_MINUTES ? minutes : null;
}

// Null unless every value is present and well formed. Values are not trimmed:
// a stray space is a typo, and off is the safe reading.
function readVoiceConfig(env) {
  if (!env) return null;
  const apiKey = env.RETELL_API_KEY;
  const agentId = env.RETELL_AGENT_ID;
  const dailyMinutes = readDailyMinutes(env);
  if (typeof apiKey !== 'string' || !API_KEY.test(apiKey)) return null;
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return null;
  if (dailyMinutes == null) return null;
  return Object.freeze({ apiKey, agentId, dailySeconds: dailyMinutes * 60, dailyMinutes });
}

let override = null;

// Production reads the env on every request, so unsetting a variable in
// Railway turns calls off at the next deploy without a code change.
function voiceConfig() {
  if (override) return override.config;
  if (process.env.NODE_ENV === 'test') return null;
  return readVoiceConfig(process.env);
}

function _setVoiceConfigForTests(config) {
  if (process.env.NODE_ENV !== 'test') throw new Error('_setVoiceConfigForTests is test-only');
  override = config === undefined ? null : { config };
}

module.exports = {
  VOICE_CAPS,
  MAX_DAILY_MINUTES,
  readVoiceConfig,
  readDailyMinutes,
  voiceConfig,
  _setVoiceConfigForTests,
};
