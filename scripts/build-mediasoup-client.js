// Builds public/vendor/mediasoup-client/mediasoup-client.js: the mediasoup-client library (the app's side of
// the SFU, D70) as one ES module, so the client keeps loading its files as they are, with no build step (D1).
// The output is committed; run this only to change the pinned version (package.json → devDependencies).
//
//   npm run build:mediasoup-client
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'vendor', 'mediasoup-client');
const dir = path.join(root, 'node_modules', 'mediasoup-client'); // its `exports` hide package.json
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

fs.mkdirSync(out, { recursive: true });
esbuild
  .build({
    // It is CommonJS, so its exports are named here; the fake handler and test parameters are left out
    stdin: { contents: "import * as m from 'mediasoup-client';\nexport const { Device, version, detectDevice, detectDeviceAsync, parseScalabilityMode } = m;", resolveDir: root, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    outfile: path.join(out, 'mediasoup-client.js'),
    // Its `debug` logging reads these; production keeps it quiet
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.DEBUG': 'undefined' },
    legalComments: 'eof',
    banner: { js: `// mediasoup-client ${pkg.version} (ISC), bundled by scripts/build-mediasoup-client.js. Do not edit.` },
    logLevel: 'warning',
  })
  .then(() => {
    fs.copyFileSync(path.join(dir, 'LICENSE'), path.join(out, 'LICENSE'));
    const file = path.join(out, 'mediasoup-client.js');
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    console.log(`[friendspeak] mediasoup-client ${pkg.version}: ${path.relative(root, file)} (${fs.statSync(file).size} bytes, sha256 ${sha})`);
  })
  .catch(() => process.exit(1));
