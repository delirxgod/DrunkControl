// Local dev server: static files + /api/presets (same handler Vercel runs).
// WebHID needs a secure context, and http://localhost counts as one.
// Usage: node serve.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const presets = require('./api/presets.js');

const root = __dirname;
const port = Number(process.argv[2]) || 8090;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon',
};

// Minimal shim of the Vercel req/res helpers used by the API handler.
function vercelRes(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return res; };
  return res;
}

// Same security headers as vercel.json (keep them in sync).
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self' https://api.github.com",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
const SECURITY = {
  'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'hid=(self)',
};
// Only answer to localhost names: blocks DNS-rebinding pages from talking to this server.
const HOST_OK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

http.createServer((req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  if (!HOST_OK.test(req.headers.host || '')) { res.writeHead(403).end(); return; }
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400).end(); return; }
  if (url.pathname === '/api/presets') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) { res.writeHead(413).end(); req.destroy(); } });
    req.on('end', () => {
      try { req.body = body ? JSON.parse(body) : undefined; } catch { req.body = body; }
      presets(req, vercelRes(res)).catch((e) => { console.error(e); if (!res.headersSent) res.writeHead(500); res.end(); });
    });
    return;
  }
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(root, p));
  const rel = path.relative(root, file);
  // Inside the folder only (a sibling like "new-ui-old" shares the prefix), and no dot-folders
  // (.data, .git, .vercel) or server code, in any letter case (Windows paths ignore case).
  const parts = rel.split(path.sep);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || parts.some((x) => x.startsWith('.')) || /^(serve\.js|start\.bat|api)$/i.test(parts[0])) {
    res.writeHead(403).end(); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`DrunkDeer Control: http://localhost:${port}/`));
