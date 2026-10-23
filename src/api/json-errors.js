// Malformed JSON becomes one JSON body. The handler does not branch on
// the environment and does not copy the parser error onto the response.

const INVALID_BODY = Buffer.from('{"error":"invalid_body"}');

function isParseError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.type === 'entity.parse.failed') return true;
  return err instanceof SyntaxError && (err.status === 400 || err.statusCode === 400);
}

function jsonErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (!isParseError(err)) return next(err);
  console.error('[http] invalid_json');
  res.status(400);
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'no-store');
  res.end(INVALID_BODY);
}

module.exports = jsonErrorHandler;
