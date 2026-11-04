const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const port = Number(process.env.PORT || 3002);
const root = path.resolve(__dirname, 'dist');
// The backend API runs as a separate Node process on this host. Requests to /api are proxied to
// it so the browser only ever talks to this origin — no second DNS name, no CORS.
const apiTarget = new URL(process.env.API_ORIGIN || 'http://127.0.0.1:5000');

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
};

function sendFile(response, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  response.statusCode = 200;
  response.setHeader('Content-Type', contentTypes[extension] || 'application/octet-stream');
  response.setHeader('Cache-Control', extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable');
  fs.createReadStream(filePath).on('error', () => {
    if (!response.headersSent) response.statusCode = 500;
    response.end('Internal server error');
  }).pipe(response);
}

// The API is expected on loopback, so http is the only supported scheme — http.request throws
// on an 'https:' protocol, and failing loudly at boot beats a 502 on every request later.
if (apiTarget.protocol !== 'http:') {
  throw new Error(`API_ORIGIN must be an http:// URL (got ${apiTarget.protocol}//). Run the API on loopback and terminate TLS at the edge.`);
}

const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 120000);

// Hop-by-hop headers describe one connection and must not be relayed to the next one
// (RFC 9110 §7.6.1). Forwarding the client's `connection: keep-alive` or a `transfer-encoding`
// that no longer applies makes the upstream negotiate against the wrong peer.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function withoutHopByHop(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

function failGateway(response, code, detail) {
  console.error(`[scorelo-frontend] API proxy ${code}:`, detail);
  // Once the upstream's headers and part of its body are on the wire, this response belongs to
  // the API. Appending a JSON error would corrupt that partial body, so cut the connection and
  // let the client see a truncated response, which is what actually happened.
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: code === 504 ? 'API timed out' : 'API unavailable' }));
}

function proxyToApi(request, response) {
  // The API sits two hops from the browser (edge proxy -> here -> API). X-Forwarded-For is a
  // list, so APPEND this hop rather than overwrite: the edge proxy already recorded the real
  // client there, and replacing it would leave the API seeing only the edge proxy's address.
  const forwardedFor = request.headers['x-forwarded-for'];
  const thisHop = request.socket.remoteAddress ?? '';

  const upstream = http.request(
    {
      hostname: apiTarget.hostname,
      port: apiTarget.port || 80,
      method: request.method,
      path: request.url,
      headers: {
        ...withoutHopByHop(request.headers),
        host: apiTarget.host,
        'x-forwarded-for': forwardedFor ? `${forwardedFor}, ${thisHop}` : thisHop,
        'x-forwarded-proto': request.headers['x-forwarded-proto'] ?? 'http',
        'x-forwarded-host': request.headers.host ?? '',
      },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, withoutHopByHop(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    },
  );

  // Without this a hung API would hold the connection open indefinitely.
  upstream.setTimeout(API_TIMEOUT_MS, () => {
    upstream.destroy();
    failGateway(response, 504, `no response within ${API_TIMEOUT_MS}ms`);
  });

  upstream.on('error', (error) => {
    if (response.writableEnded) return;
    failGateway(response, 502, error.message);
  });

  // A browser that navigates away mid-request leaves this socket half-open; without tearing the
  // upstream down too, its request outlives the client and the sockets accumulate under load.
  const abortUpstream = () => upstream.destroy();
  request.on('aborted', abortUpstream);
  response.on('close', abortUpstream);

  request.pipe(upstream);
}

const server = http.createServer((request, response) => {
  if (request.url === '/api' || request.url.startsWith('/api/') || request.url.startsWith('/api?')) {
    proxyToApi(request, response);
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }

  const requestedPath = path.resolve(root, `.${pathname}`);
  const isInsideRoot = requestedPath === root || requestedPath.startsWith(`${root}${path.sep}`);
  const candidate = isInsideRoot ? requestedPath : path.join(root, 'index.html');

  fs.stat(candidate, (error, stats) => {
    const filePath = !error && stats.isFile() ? candidate : path.join(root, 'index.html');
    fs.stat(filePath, (fallbackError) => {
      if (fallbackError) {
        response.writeHead(500);
        response.end('Frontend build is missing. Run npm run build.');
        return;
      }

      if (request.method === 'HEAD') {
        response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
        response.end();
        return;
      }

      sendFile(response, filePath);
    });
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[scorelo-frontend] listening on port ${port}`);
});