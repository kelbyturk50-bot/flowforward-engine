// FF_DEMO_VIEW_TASK is env-only. It is off unless the value is a clear
// truthy token: after trim and a lower-case fold, one of true, 1, yes, on.
// Unset, empty, false, off, 0, no, and anything else stay off. This is not
// a feature_flags row and it is not writable from the CRM. Nothing in this
// process sets the variable.

const TRUTHY = new Set(['true', '1', 'yes', 'on']);

// One parser for the env-only view flags. A value counts only when it is a
// string and, after trim and a lower-case fold, one of true, 1, yes, on.
function envFlagOn(env, name) {
  if (!env || !Object.prototype.hasOwnProperty.call(env, name)) return false;
  const raw = env[name];
  if (typeof raw !== 'string') return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

function demoViewTaskOn(env = process.env) {
  return envFlagOn(env, 'FF_DEMO_VIEW_TASK');
}

// FF_PROSPECT_VIEWS is env-only, same parser as FF_DEMO_VIEW_TASK. Off
// unless the value is a clear truthy token. Nothing in this process sets it.
function prospectViewsOn(env = process.env) {
  return envFlagOn(env, 'FF_PROSPECT_VIEWS');
}

module.exports = { TRUTHY, demoViewTaskOn, prospectViewsOn };
