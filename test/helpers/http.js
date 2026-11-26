import { request as httpRequest } from 'node:http';

/**
 * One-shot HTTP request against a localhost server. `agent: false` keeps the
 * connection non-reusable, so servers under test can close without waiting for
 * idle keep-alive sockets to time out.
 */
export function request(port, { path = '/', method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers, agent: false },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
