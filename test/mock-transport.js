// In-process stand-in for http.request / https.request. No sockets.
// The lookup on the request is invoked the way Node's HTTP client does
// (options.all), and the address it returns is stored on the options as
// connectedAddress — that is the address the guard pinned.

const { EventEmitter } = require('events');
const { Readable } = require('stream');

function invokeLookup(options) {
  const lookup = options.lookup;
  if (typeof lookup !== 'function') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    lookup(options.hostname, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses && addresses[0] ? addresses[0].address : null);
    });
  });
}

function mockTransport(handler) {
  return function request(options, callback) {
    const req = new EventEmitter();
    req.destroyed = false;
    req.setTimeout = () => req;
    req.destroy = () => { req.destroyed = true; };
    req.end = () => {
      Promise.resolve()
        .then(() => invokeLookup(options))
        .then((address) => {
          options.connectedAddress = address;
          return handler(options);
        })
        .then((result) => {
          if (req.destroyed || result == null) return;
          const res = new Readable({ read() {} });
          res.statusCode = result.status == null ? 200 : result.status;
          res.headers = result.headers || {};
          process.nextTick(() => {
            if (req.destroyed) return;
            callback(res);
            if (res.destroyed) return;
            if (result.body != null) {
              const body = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body);
              res.push(body);
            }
            if (!res.destroyed) res.push(null);
          });
        })
        .catch((err) => {
          if (!req.destroyed) req.emit('error', err);
        });
    };
    return req;
  };
}

function requestedUrl(options) {
  const host = (options.headers && (options.headers.Host || options.headers.host)) || options.hostname;
  const proto = options.protocol || 'https:';
  const path = options.path || '/';
  return `${proto}//${host}${path}`;
}

module.exports = { mockTransport, requestedUrl };
