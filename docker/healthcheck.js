// Container health check: GET /api/info on the local server.
// Accepts the self-signed certificate that HTTPS=1 generates.
const https = process.env.HTTPS === '1' || process.env.HTTPS === 'true';
const lib = require(https ? 'https' : 'http');

const req = lib.get(
  { host: '127.0.0.1', port: Number(process.env.PORT) || 3000, path: '/api/info', rejectUnauthorized: false, timeout: 4000 },
  (res) => process.exit(res.statusCode === 200 ? 0 : 1)
);
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', () => process.exit(1));
