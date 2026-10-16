// Feature flags until #63's flag service lands.
// TODO(#63): replace the body of isFlagOn with one call into that service.
// Exactly the string "true" is on. "1", "TRUE", "yes", and an empty value stay off.
// Not cached: the next read sees the current env.

function isFlagOn(name) {
  return process.env[name] === 'true';
}

module.exports = { isFlagOn };
