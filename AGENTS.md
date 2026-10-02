# AGENTS.md: working on friendspeak

This is the guide for engineers and AI agents changing this repo. Read it before editing. For deeper material:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): how the pieces fit, the socket protocol, and where data lives
- [`docs/DECISIONS.md`](docs/DECISIONS.md): why things are the way they are. Check it before "fixing" something that looks odd.
- [`docs/GAME.md`](docs/GAME.md): the penguin game (Yukon) integration, the full list of changes to vendored code, and how to add rooms
- [`README.md`](README.md): user-facing setup and features
- [`CHANGELOG.md`](CHANGELOG.md): release notes. Every release needs a section for its version.

## What this is

friendspeak is a self-hosted Discord/TeamSpeak-style app for small friend groups. It has text channels, WebRTC voice, emojis, GIFs, a soundboard, and an optional virtual penguin world based on the open-source Yukon client and server (game assets not included). **There are no accounts anywhere.** Identity is a profile stored in the desktop app. The app runs as:

1. **A server** (`server.js`): Express + Socket.IO, plus the Yukon game worlds, all on **one port**. It serves no chat UI (D26), only the game client that the app shows in an iframe.
2. **The client** (`public/`): vanilla JS ES modules with no build step. It ships only inside the desktop app.
3. **A desktop app** (`desktop/`): Electron. It loads the client from a private `friendspeak://` origin. It is a client only and never hosts (D23).

## Commands

The Node version must be **≥ 22.13**, because the game uses the built-in `node:sqlite`. On the maintainer's machine Node comes from nvm and may not be on a non-interactive PATH (`~/.nvm/versions/node/*/bin`).

| Command | What it does |
|---|---|
| `npm install` | Installs dependencies and builds the game (postinstall runs `scripts/build-game.js --if-possible`) |
| `npm start` | Runs the server on `:3000` (env vars: see ARCHITECTURE.md → Configuration) |
| `npm run desktop` | Runs the Electron app from source |
| `npm run build:game` | Rebuilds `game/server/dist` (Babel) and `game/client/dist` (webpack). **Required after any edit under `game/*/src`.** |
| `npm run dist[:mac\|:win\|:linux\|:all]` | Builds desktop installers into `release/` (`:all` cross-builds every OS from a Mac). The installers are client-only and don't include the server or game. |
| `docker build -t friendspeak .` | Builds the server image; `docker-compose.yaml` runs it (README → Docker) |
| `node --check server.js` | Quick syntax check (client modules: `node --check --input-type=module < file`) |

There is **no automated test suite**. See "Verifying changes" below.

## Repo map

```
server.js              friendspeak server; exports startServer(opts) (used by the CLI and Docker)
updater.js             server self-update: GitHub Releases check, cron maintenance window, Watchtower trigger (D29)
public/                the client UI, bundled into the desktop app (no bundler; files load as-is)
  js/main.js           UI, app state (object S), socket handlers, settings, game view
  js/voice.js          WebRTC mesh (VoiceClient)
  js/dm.js             peer-to-peer direct messages (DirectMessages), signaled via /dm on bookmarked servers
  js/call.js           calls in DMs (DmCalls): voice, camera and screen share over the DM link, media via VoiceClient
  js/audio.js          Web Audio graph: mic → mute/PTT gate → outgoing track, soundboard mixing
  js/store.js          localStorage (profiles, servers, settings) + IndexedDB (sounds, DMs)
  js/util.js           h() DOM helper, markdown renderer, avatars, address parsing
desktop/main.js        Electron main: friendspeak:// protocol, cert pinning, IPC, global hotkeys
desktop/preload.js     window.friendspeakDesktop bridge (contextIsolation, sandboxed)
game/index.js          glue: serves the game, starts Yukon worlds, creates penguins for profiles
game/client/           VENDORED Yukon client (patched); built to game/client/dist
game/server/           VENDORED Yukon server (patched); built to game/server/dist
game/assets-pack/      (gitignored) Yukon-compatible asset pack; ~3.4 GB
game/assets-extra/     (gitignored) art for the extra rooms
scripts/build-game.js  builds both vendored projects
scripts/release-notes.js  prints a version's CHANGELOG.md section (release notes)
.github/workflows/     ci.yml (dev + PRs: syntax, server boot, game build); release.yml (push to prod → release, D29)
data/                  (gitignored) server state when run via `npm start`
release/               (gitignored) electron-builder output
build/                 electron-builder resources: icon.png, entitlements.mac.plist
Dockerfile, docker-compose.yaml, docker/   production server image and stack (D21)
```

## Rules of the road

1. **Vendored Yukon code is patched, not pristine.** Mark every change in `game/client` or `game/server` with a `friendspeak:` comment, and add it to the patch inventory in `docs/GAME.md`. Keep patches small and local, so upstream Yukon updates stay mergeable. Don't reformat vendored files.
2. **Never commit game assets.** The game's art and audio are third-party copyrighted material. `game/assets-pack`, `game/assets-extra`, `game/client/assets/{media,fonts}` and the build outputs are gitignored. Keep it that way. Code from the Yukon repos (MIT) is fine to vendor. In docs, comments, server messages and logs, call it the penguin game or virtual penguin world, as Yukon does. The brand name appears only in client UI strings (`public/`, the desktop pop-out title, the game page title).
3. **No native Node modules.** The server must run under plain Node on any machine and in the Docker image without rebuilds. That is why the game uses `node:sqlite` through a custom Sequelize driver and `bcryptjs` instead of `bcrypt` (see DECISIONS.md D13). Check before adding a dependency.
4. **One port.** Chat, voice signaling, the game client and the game worlds all share the friendspeak HTTP server. Don't add listeners on other ports. Add socket.io paths or Express routes instead (and keep `destroyUpgrade: false` on every socket.io server attached to it).
5. **The client has no build step.** `public/` is plain ES modules loaded by the browser. Don't introduce a bundler, TypeScript or a framework without an explicit decision (D1).
6. **Treat user content as hostile HTML.** All message text goes through `formatText()` (`public/js/util.js`), which escapes first. Build DOM with `h()`. Only use `innerHTML` with strings you built from escaped input.
7. **The server validates every payload.** Use the `str()`, `cleanProfile()` and `isDataImage()` helpers in `server.js`. Socket handlers registered with `on()` in `attach()` already reject unauthenticated sockets.
8. **The trust model is "friends".** Anyone who knows the server address (and password, if set) can create or delete channels and emojis. Profile IDs are client-generated and spoofable. That is intentional (D3). Don't add half-measures that imply more security than exists.

## Common tasks

### Add a chat feature (new socket event)
1. `server.js` → inside `attach()` → `on('thing:do', (payload, ack) => { … })`. Validate the payload, mutate `state`, call `save()`, then `io.emit(...)`.
2. `public/js/main.js` → in `connectTo()` add `socket.on('thing:done', …)` and update `S`. Re-render the affected region (`renderChannels`, `renderMembers`, `renderMessages`, …).
3. Document the event in `docs/ARCHITECTURE.md` → Protocol.

### Add a setting
Add a default to `DEFAULT_SETTINGS` in `public/js/store.js`, then UI in the matching `settings*` function in `main.js`. Server-side options go in `startServer(opts)` plus the CLI env mapping at the bottom of `server.js` (and `docker-compose.yaml` / `.env.example` if Docker users need it).

### Change desktop behaviour
Keep the renderer API small. Add IPC in `desktop/main.js` (`ipcMain.handle('desktop:…')`), expose it in `desktop/preload.js`, and use it in `main.js` via `desktop`.

### Game changes
See `docs/GAME.md`. In short: edit under `game/*/src`, mark the change, `npm run build:game`, restart the server. To add a missing room, follow the recipe in GAME.md.

## Verifying changes

There are no unit tests. Verification so far has been scripted with **puppeteer-core** driving the system Chrome (and Electron via `--remote-debugging-port`). Those scripts lived in a scratch directory and are not in the repo. Reproduce the approach:

- **Server protocol:** a Node script with `socket.io-client` that runs `hello` → exercises events → asserts broadcasts.
- **UI / voice:** two Electron instances (separate `FRIENDSPEAK_USER_DATA`) with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`. Join the same voice channel and assert `.voice-user.speaking` appears for the remote peer. The fake mic beeps periodically, so poll.
- **Game rooms:** run the server with `GAME_SPAWN=<roomId>`, open the game from the UI, then watch for `pageerror` events and HTTP ≥400 responses inside the iframe. Screenshot the canvas.
- **Desktop:** `FRIENDSPEAK_USER_DATA=<tmp> npx electron . --remote-debugging-port=9333 …` then `puppeteer.connect`. Cross-origin iframes attach late, so use `page.waitForFrame`.

Always syntax-check after edits, and rebuild the game after touching `game/*/src`.

## Branches and releases (D29)

- `dev` is the default branch: commit and open PRs there. **`prod` is releases only.** Every push to it runs `.github/workflows/release.yml`, which publishes `version` from package.json as a GitHub Release (installers) plus `ghcr.io/nickolaiposs/friendspeak:<version>` and `:latest`. Installed apps and auto-updating servers act on it.
- To release: bump `version` in package.json, add a `## <version> - <date>` section to `CHANGELOG.md`, merge `dev` → `prod`. The workflow refuses a version that's already released, and `ci.yml` checks this on PRs into `prod`.
- Keep the socket protocol tolerant of version skew: a server may update while clients are older, and vice versa. Add optional fields; don't change the meaning of existing ones.
- Don't push to `prod`, tag, or publish a release unless asked.

## Finishing a feature

When a feature is fully implemented and verified (not after every small edit), rebuild the shipped artifacts so they match the source. CI does the real release builds. These local builds catch packaging breakage early:

1. `npm run dist:all`: desktop installers for macOS, Windows and Linux into `release/`. (Run `npm run build:game` separately if you touched the game; the Docker build rebuilds it itself.)
2. `docker build -t friendspeak:latest -t friendspeak:<version> .`: the server image, where `<version>` is `version` from `package.json`.

Run the two builds in parallel. Both are slow (minutes). Check that both exit 0 and list the new files in `release/`. Report any failure with its log. Don't bump the version, push the image or publish a release unless asked.

## Gotchas (learned the hard way)

- **The server has no UI.** `http://localhost:3000` only shows a plain-text notice. Run the client with `npm run desktop` (D26).
- **`localStorage` is per-origin.** The desktop app uses a fixed custom origin (`friendspeak://app`) so profiles don't vanish when ports change (D10).
- `replaceChildren(null)` inserts the text "null". Filter falsy children first (`h()` already does).
- **Yukon loads some files from the site root** (`/assets/media/clothing/...`), not relative to `/game/`. `game/index.js` mounts the asset dirs at both `/game/assets` and `/assets`.
- **Upstream Yukon room doors set to `null`** are rooms Yukon never built. They now show "closed for construction". Doors to the extra rooms friendspeak adds are wired to real room IDs (GAME.md).
- **Asset packs are not interchangeable.** Packs made for modified Yukon forks (different crumbs, no igloos) don't work with our upstream client. Use an upstream-compatible pack (D16).
- `socket.emitWithAck` never resolves if the socket disconnects mid-call. UI code assumes a connected socket.
- **Electron global shortcuts have no key-up event,** so push-to-talk can't be global. Soundboard hotkeys can.
- **Regenerate `package-lock.json` with the Node 24 npm** (the version Docker and CI use) after changing dependencies, e.g. `docker run --rm -v "$PWD:/w" -w /w node:24-bookworm-slim npm install --package-lock-only --ignore-scripts`. Older npm versions drop optional entries, and then `npm ci` fails in the image and in CI.
- **The sandbox/classifier in some agent environments blocks cloning third-party code** or bundling assets into installers. Surface that to the user rather than working around it.
