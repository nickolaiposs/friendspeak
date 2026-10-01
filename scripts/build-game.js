// Builds the vendored Yukon (virtual penguin world) server and client.
// Runs after `npm install`; skips quietly if dev dependencies aren't installed.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const bin = (name) => path.join(root, 'node_modules/.bin', process.platform === 'win32' ? name + '.cmd' : name);
const optional = process.argv.includes('--if-possible');

if (!fs.existsSync(bin('babel')) || !fs.existsSync(bin('webpack'))) {
  const msg = 'Game build tools are not installed (run `npm install` with dev dependencies).';
  if (optional) {
    console.log('[friendspeak] ' + msg + ' Skipping game build.');
    process.exit(0);
  }
  console.error(msg);
  process.exit(1);
}

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

console.log('[friendspeak] Building the game server (Yukon)…');
run(bin('babel'), ['src', '-d', 'dist', '--copy-files', '--delete-dir-on-start'], path.join(root, 'game/server'));
console.log('[friendspeak] Building the game client (Yukon)…');
run(bin('webpack'), ['--mode', 'production', '--no-stats'], path.join(root, 'game/client'));
console.log('[friendspeak] Game built. Add the Yukon asset pack to game/client/assets to play.');
