// The test extension's service: answers the rail entries the host polls
// (GET /rail) and lets the end-to-end check change them (PUT /rail).
import http from 'node:http';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
const DIAMOND = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2 22 12 12 22 2 12z"/></svg>';

let entries = [
  { id: 'alpha', title: 'Alpha view', icon: 'compass-3', order: 1 },
  { id: 'beta', title: 'Beta view', icon: 'route', order: 2 },
  { id: 'gamma', title: 'Gamma view (inline SVG)', icon: DIAMOND, order: 3 },
  { id: 'dock', title: 'Bottom panel', icon: 'layout-bottom', order: 4, zone: 'bottom' },
];

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401);
    res.end();
    return;
  }
  const { pathname } = new URL(req.url ?? '/', 'http://service');
  if (pathname === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }
  if (pathname === '/rail' && req.method === 'GET') {
    json(res, 200, { entries });
    return;
  }
  if (pathname === '/rail' && req.method === 'PUT') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const next = JSON.parse(body);
        if (!Array.isArray(next.entries)) throw new Error('entries');
        entries = next.entries;
        json(res, 200, { entries });
      } catch {
        json(res, 400, { message: 'Send { "entries": [...] }.' });
      }
    });
    return;
  }
  json(res, 404, { message: 'Not found.' });
}).listen(port, '127.0.0.1');
