// Request fields the view log is allowed to read. The IP is the same
// bucket the pilot limiter uses (IPv4 as-is, IPv6 by /64). The raw
// user-agent is passed to the classifier and is not stored.

const { clientIp } = require('../pilot/rate-limit');

function header(req, name) {
  if (!req || typeof req.get !== 'function') return '';
  return req.get(name) || '';
}

function viewFromRequest(req) {
  const query = req && req.query;
  return {
    method: req && req.method ? req.method : 'GET',
    ua: header(req, 'user-agent'),
    purpose: header(req, 'purpose'),
    secPurpose: header(req, 'sec-purpose'),
    cookie: header(req, 'cookie'),
    preview: Boolean(query && query.preview === '1'),
    ip: clientIp(req),
  };
}

module.exports = { viewFromRequest };
