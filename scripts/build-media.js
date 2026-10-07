// Builds the native media sidecar (native/, Rust; D45) for the installers:
// native/dist/<os>-<arch>/friendspeak-media, which electron-builder copies into
// the app's resources. Only for the machine's own OS: the sidecar calls OS
// capture and encoder APIs and compiles C++ (OpenH264), so it isn't
// cross-built. An installer for an OS it wasn't built for ships without it,
// and that app shares through the browser engine, as before.
//
//   node scripts/build-media.js                build for this OS (on macOS: arm64 and x64)
//   node scripts/build-media.js --if-possible  the same, but skip quietly without Rust
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const crate = path.join(root, 'native');
const optional = process.argv.includes('--if-possible');
const log = (msg) => console.log('[friendspeak] ' + msg);

// os and arch as electron-builder names them (${os}-${arch} in package.json → build.extraResources)
const TARGETS = {
  darwin: [
    ['mac-arm64', 'aarch64-apple-darwin'],
    ['mac-x64', 'x86_64-apple-darwin'],
  ],
  win32: [['win-x64', 'x86_64-pc-windows-msvc']],
  // Linux: no native capture or hardware encoder yet, so there is nothing to ship
}[process.platform];

const skip = (msg) => {
  if (optional) {
    log(msg + ' Skipping the media sidecar; shares will use the standard pipeline.');
    process.exit(0);
  }
  console.error(msg);
  process.exit(1);
};

if (!TARGETS) {
  log('The media sidecar has no capture support on this OS yet. Nothing to build.');
  process.exit(0);
}
const has = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
if (!has('cargo')) skip('Rust (cargo) is not installed: https://rustup.rs.');

const exe = 'friendspeak-media' + (process.platform === 'win32' ? '.exe' : '');
// In the crate's directory: its rust-toolchain.toml picks the toolchain, and the targets are per toolchain
const installed = has('rustup') ? String(execFileSync('rustup', ['target', 'list', '--installed'], { cwd: crate, shell: process.platform === 'win32' })) : '';
let built = 0;
for (const [name, target] of TARGETS) {
  if (installed && !installed.includes(target)) {
    log(`Rust target ${target} is not installed (rustup target add ${target}). Skipping ${name}.`);
    continue;
  }
  log(`Building the media sidecar for ${name}…`);
  // Windows: the crypto library's assembly comes prebuilt, so NASM doesn't have to be installed
  const env = { AWS_LC_SYS_PREBUILT_NASM: '1', ...process.env };
  execFileSync('cargo', ['build', '--release', '--locked', '--target', target], { cwd: crate, stdio: 'inherit', env, shell: process.platform === 'win32' });
  const out = path.join(crate, 'dist', name);
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(path.join(crate, 'target', target, 'release', exe), path.join(out, exe));
  built++;
}
if (!built) skip('No Rust target for this OS is installed.');
log('Media sidecar built.');
