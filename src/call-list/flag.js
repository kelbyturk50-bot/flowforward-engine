// FF_CALL_LIST. Database row, seeded off. Env can force it off and cannot
// force it on. A missing row or a read error is off (effective() already
// fails that way). Callers read this before BEGIN. Do not call it on a
// second pool client while a transaction holds a row lock (issue #147).

const { effective } = require('../flags/resolve');

const FLAG = 'FF_CALL_LIST';

async function callListEnabled() {
  const view = await effective(FLAG);
  return !!(view && view.effective === true);
}

module.exports = { FLAG, callListEnabled };
