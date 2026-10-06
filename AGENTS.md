# AGENTS.md: working on friendspeak

This is the guide for engineers and AI agents changing this repo. Read it before editing. For deeper material:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): how the pieces fit, the socket protocol, and where data lives
- [`docs/DECISIONS.md`](docs/DECISIONS.md): why things are the way they are. Check it before "fixing" something that looks odd.
- [`docs/GAME.md`](docs/GAME.md): the penguin game (Yukon) integration, the full list of changes to vendored code, and how to add rooms
- [`README.md`](README.md): user-facing setup and features
- [`CHANGELOG.md`](CHANGELOG.md): release notes. Every release needs a section for its version.

## What this is

friendspeak is a self-hosted Discord/TeamSpeak-style app for small friend groups. It has text channels, WebRTC voice, emojis, GIFs, a soundboard, and an optional virtual penguin world based on the open-source Yukon client and server (game assets not included). **There are no accounts anywhere.** Identity is a profile stored in the desktop app. The app runs as:

1. **A server** (`server.js`): Express + Socket.IO, plus the Yukon game worlds, all on **one port**. It serves no chat UI (D26), only the game client that the app shows in an iframe and the admin dashboard (D34), at a random path it prints at start (D52; `/admin` forwards to it from localhost).
2. **The client** (`public/`): vanilla JS ES modules with no build step. It ships only inside the desktop app.
3. **A desktop app** (`desktop/`): Electron. It loads the client from a private `friendspeak://` origin. It is a client only and never hosts (D23).

## Commands

The Node version must be **≥ 22.13**, because the game uses the built-in `node:sqlite`. On the maintainer's machine Node comes from nvm and may not be on a non-interactive PATH (`~/.nvm/versions/node/*/bin`).

| Command | What it does |
|---|---|
| `npm install` | Installs dependencies and builds the game (postinstall runs `scripts/build-game.js --if-possible`) |
| `npm start` | Runs the server on `:3000` (env vars: see ARCHITECTURE.md → Configuration) |
| `npm run desktop` | Runs the Electron app from source |
| `npm run build:media` | Builds the native media sidecar (`native/`, Rust) for this OS into `native/dist/`. Needs Rust (`rustup`). `cargo build --release` in `native/` is enough for `npm run desktop`. **Required after any edit under `native/src`.** |
| `npm run build:denoise` | Rebuilds the noise suppression wasm in `public/vendor/deepfilternet/` from upstream DeepFilterNet (`scripts/denoise/`, D47). Needs Docker. The built files are committed: only needed to change the patch or the pinned versions. |
| `npm run build:game` | Rebuilds `game/server/dist` (Babel) and `game/client/dist` (webpack). **Required after any edit under `game/*/src`.** |
| `npm run dist[:mac\|:win\|:linux\|:all]` | Builds desktop installers into `release/` (`:all` cross-builds every OS from a Mac). The installers are client-only and don't include the server or game. Each first builds the media sidecar for the machine's own OS if Rust is installed; installers for other OSes are built without it (D45). |
| `docker build -t friendspeak .` | Builds the server image; `docker-compose.yaml` runs it (README → Docker) |
| `node --check server.js` | Quick syntax check (client modules: `node --check --input-type=module < file`) |

There is **no automated test suite**. See "Verifying changes" below.

## Repo map

```
server.js              friendspeak server; exports startServer(opts) (used by the CLI and Docker)
updater.js             server self-update: GitHub Releases check, cron maintenance window, Watchtower trigger (D29)
persist.js             writes the saved state in pieces, off the event loop (D56): state.json, profiles/, messages/, emojis.json, mail/
admin.js               admin dashboard backend: local rule, admin keys, the random path and TOTP 2-step sign-in (D52), sessions, rate limit, audit log, JSON API + event stream (D34)
logbuffer.js           the server's console output (D49): a ring buffer for the dashboard's live view, JSON lines in data/logs for history, secrets scrubbed
crashlog.js            crash reports in data/crashes (D49): uncaught errors, failed starts, unclean exits
admin-ui/              the admin dashboard (plain ES modules, no build step); one module per view in js/views/; js/qr.js is the QR encoder for the 2-step setup
public/                the client UI, bundled into the desktop app (no bundler; files load as-is)
  js/main.js           UI, app state (object S), socket handlers, settings, game view
  js/voice.js          WebRTC mesh (VoiceClient)
  js/dm.js             peer-to-peer direct messages (DirectMessages): sealed ops and images over a data channel, signaled and mailboxed via /dm
  js/identity.js       per-profile key pairs, cards, end-to-end sealing, friend codes (D32)
  js/native.js         client for the media sidecar (D45): what it can do, commands, events
  js/call.js           calls in DMs (DmCalls): voice, camera and screen share over the DM link, media via VoiceClient
  js/background.js     camera backgrounds (blur, pictures): MediaPipe person segmentation, composited per frame into the track that is sent (D37)
  models/              the segmentation model for camera backgrounds (Apache 2.0; see its README)
  js/audio.js          Web Audio graph: mic → noise suppression → noise gate → mute/PTT gate → outgoing track, mic test loopback, soundboard mixing (D38, D47, D48)
  js/denoise-worklet.js  the mic's noise suppression (D47): runs DeepFilterNet on the audio thread; denoise-shim.js is its TextDecoder stand-in
  js/gate-worklet.js   the mic's noise gate (D48), on the audio thread; reports the mic's level for the bar in Settings
  vendor/deepfilternet/  the DeepFilterNet wasm, its glue and the model (MIT / Apache 2.0; see its README)
  js/log.js            page errors, console.warn/error and a few explicit events → the desktop app's log (D49)
  js/store.js          localStorage (profiles, keys, servers, settings) + IndexedDB (sounds, DMs, DM images, camera background pictures)
  js/theme.js          appearance: themes, custom palette, font, text size, density → CSS variables on <html> (D30); UI size → window zoom (D40)
  js/gogh.js           data: 50 terminal color schemes from Gogh
  js/util.js           h() DOM helper, markdown renderer, avatars, address parsing. Also served to the admin dashboard as /admin/js/util.js, so keep it import-free and safe under the dashboard's CSP
desktop/main.js        Electron main: friendspeak:// protocol, cert pinning, IPC, global hotkeys
desktop/preload.js     window.friendspeakDesktop bridge (contextIsolation, sandboxed)
desktop/logs.js        the app's log and crash reports (D49): files in userData, scrubbed, never uploaded
native/                the media sidecar (Rust, D45): captures a screen, window or camera, encodes H.264 and sends it to viewers over standard WebRTC; see ARCHITECTURE.md → Native streaming
  src/engine.rs        streams, layers (one encoder per rung of the ladder), viewers (str0m), the run loop
  src/source/          captures per OS, and a test pattern
  src/encode/          encoders: VideoToolbox, Media Foundation, OpenH264
  dist/, target/       (gitignored) build output
game/index.js          glue: serves the game, starts Yukon worlds, creates penguins for profiles
game/client/           VENDORED Yukon client (patched); built to game/client/dist
game/server/           VENDORED Yukon server (patched); built to game/server/dist
game/assets-pack/      (gitignored) Yukon-compatible asset pack; ~3.4 GB
game/assets-extra/     (gitignored) art for the extra rooms
scripts/build-game.js  builds both vendored projects
scripts/build-media.js builds the media sidecar for this OS into native/dist/<os>-<arch>/
scripts/denoise/       builds vendor/deepfilternet in Docker: build.sh, libdf.patch (our changes to upstream), Cargo.lock
scripts/release-notes.js  prints a version's CHANGELOG.md section (release notes)
.github/workflows/     ci.yml (dev + PRs: syntax of server, admin and client modules, the deploy stack (D53), server boot, game build, media sidecar build on macOS and Windows); release.yml (push to prod → release, D29)
data/                  (gitignored) server state when run via `npm start` (state.json, profiles/, messages/, mail/, files/, …)
release/               (gitignored) electron-builder output
build/                 electron-builder resources: icon.png, entitlements.mac.plist
Dockerfile, docker-compose.yaml, docker/   production server image and stack (D21)
deploy/                the stack for a domain (D53): docker-compose.yaml (friendspeak behind Caddy, real HTTPS), Caddyfile, .env.example, install.sh. A server variable Docker hosts need goes in both compose files and both .env.example files
```

## Rules of the road

1. **Vendored Yukon code is patched, not pristine.** Mark every change in `game/client` or `game/server` with a `friendspeak:` comment, and add it to the patch inventory in `docs/GAME.md`. Keep patches small and local, so upstream Yukon updates stay mergeable. Don't reformat vendored files.
2. **Never commit game assets.** The game's art and audio are third-party copyrighted material. `game/assets-pack`, `game/assets-extra`, `game/client/assets/{media,fonts}` and the build outputs are gitignored. Keep it that way. Code from the Yukon repos (MIT) is fine to vendor. In docs, comments, server messages and logs, call it the penguin game or virtual penguin world, as Yukon does. The brand name appears only in client UI strings (`public/`, the desktop pop-out title, the game page title).
3. **No native Node modules.** The desktop app ships one native program, the media sidecar (D45), as a separate process; nothing native is loaded into Node or the server. The server must run under plain Node on any machine and in the Docker image without rebuilds. That is why the game uses `node:sqlite` through a custom Sequelize driver and `bcryptjs` instead of `bcrypt` (see DECISIONS.md D13). Check before adding a dependency.
4. **One port.** Chat, voice signaling, the game client and the game worlds all share the friendspeak HTTP server. Don't add listeners on other ports. Add socket.io paths or Express routes instead (and keep `destroyUpgrade: false` on every socket.io server attached to it).
5. **The client has no build step.** `public/` is plain ES modules loaded by the browser. Don't introduce a bundler, TypeScript or a framework without an explicit decision (D1).
6. **Treat user content as hostile HTML.** All message text goes through `formatText()` (`public/js/util.js`), which escapes first. Build DOM with `h()`. Only use `innerHTML` with strings you built from escaped input.
7. **The server validates every payload.** Use the `str()`, `cleanProfile()` and `isDataImage()` helpers in `server.js`. Socket handlers registered with `on()` in `attach()` already reject unauthenticated sockets.
8. **Logs say who did what, never what was said (D49).** No message text, DM or mail blobs, passwords, keys, friend codes, file names or image data in `console.*` on the server or `log.*` in the client. Tag server lines (`[auth]`, `[mod]`, `[files]`, …). Anything that can carry chat text goes to `console.debug`, which is never stored.
9. **The trust model is "friends", with roles on top.** Joining takes an invite unless the server turns that off (D51); once in, a member is known by their pinned key. A server is open (every member can do everything, except manage roles and invites) until someone holds an admin role. From then on roles and channel overrides decide (D43). The server checks every permission itself: `permsOf()` in `server.js` is the one resolver, and the client only hides what it's told it can't do. Profile IDs are client-generated, but a server pins the key that first signs `hello` for an id, and only that key can use it after (D42; the profile file carries the key). Ids that only pre-D42 apps use are still spoofable. Don't add half-measures that imply more security than exists.

## Common tasks

### Add a chat feature (new socket event)
1. `server.js` → inside `attach()` → `on('thing:do', (payload, ack) => { … })`. Validate the payload, mutate `state`, call `save()` (or `saveProfile(id)`, `saveMessages(channelId)`, `saveEmojis()` for those pieces, D56), then `io.emit(...)`.
2. `public/js/main.js` → in `connectTo()` add `socket.on('thing:done', …)` and update `S`. Re-render the affected region (`renderChannels`, `renderMembers`, `renderMessages`, …).
3. Document the event in `docs/ARCHITECTURE.md` → Protocol.

### Add a setting
Add a default to `DEFAULT_SETTINGS` in `public/js/store.js`, then UI in the matching `settings*` function in `main.js`. Server-side options go in `startServer(opts)` plus the CLI env mapping at the bottom of `server.js` (and `docker-compose.yaml` / `.env.example`, and the same two files in `deploy/`, if Docker users need it).

### Add a dashboard view or admin route
1. `admin.js` → add the route on `api` below the session check (everything after the `// Everything below needs a local request or a session` middleware is already gated). Validate input (`cleanName()`, `str()`, `clampInt()`), call `audit(req.admin.actor, peerOf(req), 'thing.did', detail)` for every state change, and `notify(topic)` so open dashboards refetch. If the app can do the same thing over the socket (ban, remove, server settings, roles), put the logic in the shared `actions` object in `server.js`, which returns `{ ok }` or `{ error }`, and call it from both. Don't duplicate it in `admin.js`. State-changing routes get the CSRF checks for free: they must be `POST`/`PUT`/`PATCH`/`DELETE` with a JSON body.
2. `admin-ui/js/views/<name>.js` → export `{ id, title, mount(root, ctx) }` and register it in the `views` array in `admin-ui/js/admin.js`. Build DOM with `h()`. The CSP forbids inline `<script>`, `<style>` and `style="…"` attributes in HTML, so put styles in `admin.css` (setting `el.style` from JS is fine). Don't add a second `util.js` there.
3. Document the route in `docs/ARCHITECTURE.md` → Admin dashboard, and the decision in DECISIONS.md if it changes who can do what.

### Change desktop behaviour
Keep the renderer API small. Add IPC in `desktop/main.js` (`ipcMain.handle('desktop:…')`), expose it in `desktop/preload.js`, and use it in `main.js` via `desktop`.

### Game changes
See `docs/GAME.md`. In short: edit under `game/*/src`, mark the change, `npm run build:game`, restart the server. To add a missing room, follow the recipe in GAME.md.

## Verifying changes

There are no unit tests. Verification so far has been scripted with **puppeteer-core** driving the system Chrome (and Electron via `--remote-debugging-port`). Those scripts lived in a scratch directory and are not in the repo. Reproduce the approach:

- **Server protocol:** a Node script with `socket.io-client` that runs `hello` → exercises events → asserts broadcasts.
- **UI / voice:** two Electron instances (separate `FRIENDSPEAK_USER_DATA`) with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`. Join the same voice channel and assert `.voice-user.speaking` appears for the remote peer. The fake mic beeps periodically, so poll. To feed a recording instead, add `--use-file-for-fake-audio-capture=<wav> --disable-features=AudioServiceSandbox` (without the second flag the sandboxed audio service can't read the file and the mic is silent). Mic processing can also be rendered offline: an `OfflineAudioContext` at 48 kHz with the same worklet (`fs-denoise` with `processorOptions: { wasm, model, on: true, limit }`; messages posted to an offline context's worklet arrive after it has rendered; `fs-gate` takes `processorOptions: { threshold }`). Echo cancellation can't be measured with fake devices: the fake mic doesn't hear the speakers.
- **Game rooms:** run the server with `GAME_SPAWN=<roomId>`, open the game from the UI, then watch for `pageerror` events and HTTP ≥400 responses inside the iframe. Screenshot the canvas.
- **Admin dashboard:** a Node script using `fetch` against a running server. Run it with `ADMIN_PATH=off ADMIN_MFA=off` to get `/admin` and key-only sign-in (D52); otherwise read the path from the `Admin dashboard:` line of the output, and `login` answers `{ mfa: 'setup', secret }` until it is sent `{ key, code }` with the TOTP code for that secret (HMAC-SHA1 of the 30 s step, 6 digits; a code works once, the next step's is accepted too). Sign in with the key printed on first boot or `ADMIN_KEY`, then send the `fs_admin` cookie (state-changing calls need `Content-Type: application/json` and an `Origin` equal to the host). Use `node:http` when a test needs a custom `Host` header, since `fetch` won't set one, and puppeteer-core for the pages. Run with `ADMIN_LOCAL=off` to exercise sign-in on localhost.
- **Media sidecar (D45):** two layers. (1) The sidecar alone: a Node script that spawns `native/target/release/friendspeak-media`, sends `start` with `source: { type: 'test' }` (a moving pattern; `audio: true` adds a tone) and `viewer`, and relays `signal` events to a page in the system Chrome (puppeteer-core) that answers on a plain `RTCPeerConnection`; assert on the page's `inbound-rtp` stats (frames decoded, size, `audioLevel` with an unmuted element) and on the sidecar's `stats` events. `type: 'camera'` uses the real camera. (2) In the app: run the Electron instances with `FRIENDSPEAK_FAKE_CAPTURE=1` so every native source is the test pattern; get the `VoiceClient` by wrapping `VoiceClient.prototype.join` from `import('friendspeak://app/js/voice.js')` (modules are singletons), call `setNativeMedia` on one and `watch` on the other, and check `mediaOf`, `videoStats` and `peers.get(sid).nin`. Set `peer.noStream.screen = true` on the viewer to act as an older app. Real screen capture needs the Screen Recording permission, which macOS refuses to a process started from a terminal. Windows code can be type-checked from a Mac in a container (`rust` image, `mingw-w64`, `nasm`, target `x86_64-pc-windows-gnu`); it can only be run on Windows.
- **The domain stack (D53):** `COMPOSE_PROJECT_NAME=<scratch name> FRIENDSPEAK_IMAGE=friendspeak:latest ./deploy/install.sh --domain localhost --dir <tmp> --yes` with a locally built image. For `localhost` Caddy signs with its own CA, so test with certificate checks off: `/api/info` and a socket.io websocket on `https://localhost` and `https://localhost:3000`, and the dashboard's sign-in. It takes ports 80, 443 and 3000. The project name keeps it away from a real `friendspeak` stack and its data volume; remove it with `docker compose down -v`.
- **Desktop:** `FRIENDSPEAK_USER_DATA=<tmp> npx electron . --remote-debugging-port=9333 …` then `puppeteer.connect`. Cross-origin iframes attach late, so use `page.waitForFrame`. `FRIENDSPEAK_TEST_NO_DIALOGS=1` skips the crash dialogs and reloads a crashed window at once (crash a page with CDP `Page.crash`).
- **Logs and crash reports (D49):** run the server as a child process on a scratch `DATA_DIR` and read `logs/server-*.log` and `crashes/*.json`; `kill -9` then a restart gives an `unclean-exit` report. `startServer({ crashReports: true })` in a script that throws gives an `uncaughtException` one.

Always syntax-check after edits, rebuild the game after touching `game/*/src`, and rebuild the sidecar (`cargo build --release` in `native/`) after touching `native/src`.

## Branches and releases (D29)

- `dev` is the default branch: commit and open PRs there. **`prod` is releases only.** Every push to it runs `.github/workflows/release.yml`, which publishes `version` from package.json as a GitHub Release (installers) plus `ghcr.io/nickolaiposs/friendspeak:<version>` and `:latest`. Installed apps and auto-updating servers act on it.
- To release: bump `version` in package.json, add a `## <version> - <date>` section to `CHANGELOG.md`, merge `dev` → `prod`. The workflow refuses a version that's already released, and `ci.yml` checks this on PRs into `prod`.
- Keep the socket protocol tolerant of version skew: a server may update while clients are older, and vice versa. Add optional fields; don't change the meaning of existing ones.
- Don't push to `prod`, tag, or publish a release unless asked.

## Finishing a feature

When a feature is fully implemented and verified (not after every small edit), rebuild the shipped artifacts so they match the source. CI does the real release builds. These local builds catch packaging breakage early:

1. `npm run dist:all`: desktop installers for macOS, Windows and Linux into `release/`. (Run `npm run build:game` separately if you touched the game; the Docker build rebuilds it itself.) It builds the media sidecar for this machine's OS first; check that `release/mac*/friendspeak.app/Contents/Resources/native/friendspeak-media` exists.
2. `docker build -t friendspeak:latest -t friendspeak:<version> .`: the server image, where `<version>` is `version` from `package.json`.

Run the two builds in parallel. Both are slow (minutes). Check that both exit 0 and list the new files in `release/`. Report any failure with its log. Don't bump the version, push the image or publish a release unless asked.

## Gotchas (learned the hard way)

- **The server has no chat UI.** `http://localhost:3000` only shows a plain-text notice. Run the client with `npm run desktop` (D26). The one web page is the admin dashboard (D34). Its path is random (D52), but `/admin` forwards to it from localhost, where it needs no key unless `ADMIN_LOCAL=off`.
- **`localStorage` is per-origin.** The desktop app uses a fixed custom origin (`friendspeak://app`) so profiles don't vanish when ports change (D10).
- `replaceChildren(null)` inserts the text "null". Filter falsy children first (`h()` already does).
- **Yukon loads some files from the site root** (`/assets/media/clothing/...`), not relative to `/game/`. `game/index.js` mounts the asset dirs at both `/game/assets` and `/assets`.
- **Upstream Yukon room doors set to `null`** are rooms Yukon never built. They now show "closed for construction". Doors to the extra rooms friendspeak adds are wired to real room IDs (GAME.md).
- **Asset packs are not interchangeable.** Packs made for modified Yukon forks (different crumbs, no igloos) don't work with our upstream client. Use an upstream-compatible pack (D16).
- `socket.emitWithAck` never resolves if the socket disconnects mid-call. UI code assumes a connected socket.
- **Electron global shortcuts have no key-up event,** so push-to-talk can't be global. Soundboard hotkeys can.
- **Regenerate `package-lock.json` with the Node 24 npm** (the version Docker and CI use) after changing dependencies, e.g. `docker run --rm -v "$PWD:/w" -w /w node:24-bookworm-slim npm install --package-lock-only --ignore-scripts`. Older npm versions drop optional entries, and then `npm ci` fails in the image and in CI.
- **`overrides` in `package.json` replace deprecated packages that our dependencies still ask for** (issue #86): `uuid` 8 in Sequelize 6, `glob` 7 and `chokidar` 3 in `@babel/cli` 7, `global-agent` 3 in electron-builder. Drop an entry once its parent no longer needs it (Babel 8 needs Node ≥ 22.18; electron-builder 27). What is left (`dottie`, `lodash.isequal`, `glob` 7 and 9, `inflight`, `rimraf` 2) has no fix upstream yet: `glob` ≥ 10 has no default export, which `babel-plugin-module-resolver` needs.
- **A compiled `WebAssembly.Module` can't be posted to an AudioWorklet's port** (the worklet gets `messageerror`); it travels in `processorOptions`. The audio thread also has no `TextDecoder`, `performance` or `URL`.
- **Test instances outlive a failed script.** A puppeteer script that throws before closing leaves its Electron running on its debugging port, and the next run connects to that old one. Kill it first.
- **The media sidecar needs only the Command Line Tools on macOS, not Xcode.** Its Apple bindings are the `objc2` crates for that reason; `cidre` (and `scap`, which uses it) run `xcodebuild` in their build scripts.
- **str0m's rule:** every change to an `Rtc` (input, write, SDP, candidate) is followed by polling it until it returns a timeout (`drain` in `native/src/engine.rs`). Two changes in a row without that leave it inconsistent.
- **Chromium's `audioLevel` stats stay 0 for a muted `<video>`.** Unmute the element when a test checks that a share's audio has sound.
- **The sandbox/classifier in some agent environments blocks cloning third-party code** or bundling assets into installers. Surface that to the user rather than working around it.
