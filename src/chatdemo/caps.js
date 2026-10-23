// Single source of truth for live-chat caps (docs/LIVE_CHAT_DEMO.md §8.1).
// Express reads this object. schema.sql CHECK constraints use the same numbers.
// The daily spend ceiling is not a cap here. It comes only from the env var.

const CHAT_CAPS = Object.freeze({
  maxMessageChars: 500,
  maxMessagesPerSession: 20,
  maxMessagesPerLinkDay: 40,
  maxMessagesPerLink: 100,
  maxSessionsPerLink: 10,
  maxSessionsGlobalDay: 300,
  maxMintsPerIpHour: 5,
  maxMintsPerIpDay: 20,
  maxMessagesPerTokenIpMinute: 10,
  maxInputTokens: 16000,
  maxOutputTokens: 300,
  reservationTtlMs: 600000,
});

// Constraint name → CHAT_CAPS key. A test reads pg_constraint and compares.
const CAP_CHECKS = Object.freeze([
  Object.freeze(['chat_demo_turns_input_chars_cap', 'maxMessageChars']),
  Object.freeze(['chat_demo_sessions_message_count_cap', 'maxMessagesPerSession']),
  Object.freeze(['chat_demo_link_days_message_count_cap', 'maxMessagesPerLinkDay']),
  Object.freeze(['chat_demo_links_message_count_cap', 'maxMessagesPerLink']),
  Object.freeze(['chat_demo_links_session_count_cap', 'maxSessionsPerLink']),
  Object.freeze(['chat_demo_global_days_session_count_cap', 'maxSessionsGlobalDay']),
  Object.freeze(['chat_demo_ip_hours_mint_count_cap', 'maxMintsPerIpHour']),
  Object.freeze(['chat_demo_ip_days_mint_count_cap', 'maxMintsPerIpDay']),
  Object.freeze(['chat_demo_rate_minutes_count_cap', 'maxMessagesPerTokenIpMinute']),
  Object.freeze(['chat_demo_turns_input_bound_cap', 'maxInputTokens']),
  Object.freeze(['chat_demo_turns_output_tokens_cap', 'maxOutputTokens']),
]);

module.exports = { CHAT_CAPS, CAP_CHECKS };
