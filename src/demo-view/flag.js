// FF_DEMO_VIEW_TASK is env-only. It is off unless the value is a clear
// truthy token: after trim and a lower-case fold, one of true, 1, yes, on.
// Unset, empty, false, off, 0, no, and anything else stay off. This is not
// a feature_flags row and it is not writable from the CRM. Nothing in this
// process sets the variable.

const TRUTHY = new Set(['true', '1', 'yes', 'on']);

function demoViewTaskOn(env = process.env) {
  if (!env || !Object.prototype.hasOwnProperty.call(env, 'FF_DEMO_VIEW_TASK')) return false;
  const raw = env.FF_DEMO_VIEW_TASK;
  if (typeof raw !== 'string') return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

module.exports = { TRUTHY, demoViewTaskOn };
