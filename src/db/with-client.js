// A manual pool.connect() drops the pool's error listener. Without a
// replacement, a terminated backend emits 'error' and crashes the process.
// The sweep checkout uses the same shape: listen, log the code, release(err)
// when the client fails, and let the query reject.

const pool = require('./client');

function brokenClientError(err) {
  const wrapped = new Error('Something went wrong.');
  wrapped.status = 500;
  wrapped.code = err && err.code;
  return wrapped;
}

function clientIsBroken(err) {
  if (!err || err.status) return false;
  return true;
}

async function withClient(label, fn) {
  const client = await pool.connect();
  let failed = null;
  let rejectIdle = () => {};
  const idleDied = new Promise((_, reject) => { rejectIdle = reject; });
  idleDied.catch(() => {});
  const onError = (err) => {
    const wrapped = brokenClientError(err);
    failed = wrapped;
    console.error(`[db] ${label} client error: ${err && err.code || 'error'}`);
    rejectIdle(wrapped);
  };
  client.on('error', onError);
  const work = Promise.resolve().then(() => fn(client));
  work.catch(() => {});
  try {
    return await Promise.race([work, idleDied]);
  } catch (err) {
    if (!failed && clientIsBroken(err)) failed = brokenClientError(err);
    throw failed || err;
  } finally {
    client.removeListener('error', onError);
    if (failed) client.release(failed instanceof Error ? failed : new Error(`${label} client failed`));
    else client.release();
  }
}

module.exports = { withClient, brokenClientError };
