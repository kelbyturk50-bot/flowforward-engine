function log(code) {
  if (typeof code !== 'string' || !/^[a-z0-9_]+$/.test(code)) return;
  console.log(`[chatdemo] ${code}`);
}

function logErr(code, err) {
  const sqlstate = err && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) ? err.code : 'error';
  const safe = typeof code === 'string' && /^[a-z0-9_]+$/.test(code) ? code : 'error';
  console.error(`[chatdemo] ${safe} ${sqlstate}`);
}

module.exports = { log, logErr };
