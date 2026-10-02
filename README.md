# friendspeak

A self-hosted Discord / Slack / TeamSpeak-style app for you and your friends.
No accounts or sign-up. Run a server, share your IP, and talk.

- **Text channels:** markdown (`# heading` / `##` / `###`, `-# small text`, `**bold**`, `*italic*`, `__underline__`, `~~strike~~`, `||spoiler||`, `- lists`, `1. lists`, `> quotes`, `` `code` ``, ```` ``` ```` blocks), replies, edits, deletes, reactions, @mentions, typing indicators, and history that persists on the server.
- **Direct messages:** peer to peer, separate from any server. Click anyone in a member list (or right-click them) and choose **Message**. Conversations show up in their own collapsible **DMs** group at the top of the left rail, above your servers, and open without leaving the server you're connected to (voice keeps going). Messages go straight between the two devices over an encrypted WebRTC connection and are stored only there; servers you have bookmarked just help you find each other. Messages to someone who's offline are delivered the next time you're both online. Text, GIFs, replies, edits, deletes and reactions work; files don't.
- **Member list:** everyone online, plus an **Offline** section with everyone who has been on the server before (collapsible).
- **Remove from server:** right-click someone in the member list → **Remove from server…** to disconnect them and take them off the list. They can come back.
- **Bans:** right-click someone in the member list → **Ban…** to disconnect them and keep their profile (and optionally their IP) out. Unban in **Settings → Server**. Like channels, anyone on the server can ban or unban.
- **Files:** drop, paste or attach up to 10 files per message. Images, videos and audio play inline, and other files get a download card. A TeamSpeak-style **file browser** (the folder icon in the channel header, or next to the server name) lists the files of one channel or the whole server, with search, sorting and storage usage. Anyone can delete any file. The host caps total storage with `MAX_STORAGE` (default 2 GB).
- **Embeds:** links to YouTube, Vimeo, Streamable, Spotify, SoundCloud and direct image/video/audio files embed a player under the message. Wrap a link in `<angle brackets>` to post it without an embed.
- **Voice channels:** peer-to-peer WebRTC voice with mute, deafen, push-to-talk, per-user volume, speaking indicators, device selection, and echo/noise suppression. The call keeps going while you look at another server: the voice panel shows where it is and takes you back.
- **Screen sharing:** share an entire screen or a single window, with audio, at up to 1080p 60 fps, from the monitor button in the voice panel. Friends click the red **LIVE** badge to watch. Video is only sent to people who are watching.
- **Cameras:** the camera button next to it turns on your webcam (720p 30 fps). Right-click it, or go to **Settings → Voice & video**, to pick a device. Click the camera icon next to anyone in the channel to open the video view with every camera, plus the screen share you're watching.
- **Emojis:** a full searchable emoji picker, plus **custom server emojis** that you upload and use as `:name:`. Channel names can have emojis too: use the emoji button in the create/rename dialog.
- **GIFs:** GIPHY search built into the composer.
- **Saved profiles:** name, avatar (any image, an animated GIF, a GIPHY GIF, a link, or an emoji), a **profile background** (image, GIF or color, shown on your profile card when friends click your name), color and status, stored in your browser. You can keep several, switch between them, and export or import them as JSON.
- **Connect by IP:** save any number of servers in the left rail, with optional passwords.
- **Server name and icon:** click the server name (or **Settings → Server**). Anyone can set the icon from any image (it's resized for you), an animated GIF, a GIPHY GIF or an https link. Everyone on the server sees it, like Discord.
- **Soundboard:** add your own audio files (drag and drop works). They're stored locally, and when you play one it's mixed into your voice stream so everyone in the channel hears it, even while you're muted. Each sound can have its own emoji, volume and hotkey.
- **Desktop app:** an Electron app for macOS, Windows and Linux. The mic always works, soundboard hotkeys work from other apps, and it connects to any friendspeak server. (It doesn't host one; run the server separately.) It tells you when a new version is out, links to the release notes, and updates itself on Windows and Linux.
- **Server auto-updates (Docker):** the server installs new releases in a maintenance window you choose (cron format, default Sunday 06:00). Everyone on the server gets a closeable warning ahead of time.
- **Virtual penguin world (optional):** a built-in game based on [Yukon](https://github.com/wizguin/yukon), running on the same server and port. Game assets are not included. Every friendspeak profile automatically gets a penguin, so nobody signs up for anything. You can stay in a voice channel while you play.

## Quick start

Requires Node.js 22.13+ (the game uses Node's built-in SQLite).

```bash
npm install
npm start
```

The server only hosts: it has no web UI. Everyone, including the host, uses the **desktop app** (below) and clicks **+** in the left rail to add the server. The server prints the addresses to use:

```
  Local address:     http://localhost:3000  (connect with the desktop app)
  Friends connect:   192.168.1.20:3000
```

## Desktop app

```bash
npm install
npm run desktop          # run it from source
npm run dist             # build installers for this OS into release/
npm run dist:mac         # or :win / :linux
npm run dist:all         # macOS, Windows and Linux at once (works from a Mac, no Wine needed)
```

`npm run dist:all` produces these files in `release/`:

| File | For |
|---|---|
| `friendspeak-<ver>-mac-arm64.dmg` / `-mac-x64.dmg` | Apple Silicon / Intel Macs (`.zip` versions are also built) |
| `friendspeak-<ver>-win-x64-setup.exe` | Windows installer (per-user, no admin rights needed) |
| `friendspeak-<ver>-win-x64-portable.exe` | Windows, runs without installing |
| `friendspeak-<ver>-linux-x86_64.AppImage` | Linux (`chmod +x`, then run) |

The game art is never included in these files (see [Game assets](#game-assets-host-only)).

**Code signing.** The builds are not signed with a paid certificate, so the first launch shows a warning:

- **macOS:** the app is signed ad-hoc but not notarized. On first launch, macOS says it "can't be opened". Go to **System Settings → Privacy & Security** and click **Open Anyway**. If macOS says the app "is damaged", run `xattr -dr com.apple.quarantine /Applications/friendspeak.app`. To remove the warning entirely you need an Apple Developer ID. With one, build with `npx electron-builder --mac -c.mac.identity="Developer ID Application: <Name> (<TEAMID>)" -c.mac.notarize=true` and set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.
- **Windows:** SmartScreen shows "Windows protected your PC". Click **More info → Run anyway**. A code-signing certificate (`CSC_LINK` / `CSC_KEY_PASSWORD`) removes this.

- The app is a **client only**. To host, run the server separately (`npm start` on any machine, or [Docker](#docker--portainer)) and connect to it with **+** in the left rail, like any other server.
- The UI runs from a private secure origin, so the microphone works for every server you connect to, including plain `http://IP:port` ones.
- Soundboard hotkeys that use Ctrl/Alt/Cmd, an F-key or the numpad are registered as **global shortcuts**, so they work while you're in a game. Push-to-talk still needs the friendspeak window (or the game view) to be focused, because Electron's global shortcuts can't detect key release.
- **Updates:** the app checks [GitHub Releases](https://github.com/nickolaiposs/friendspeak/releases) at launch and every few hours, and shows a banner with a **What's new** link (also in **Settings → About & updates**). On Windows (installer) and Linux (AppImage), **Update** downloads it and **Restart now** installs it. macOS builds aren't signed with an Apple Developer ID, so they can't replace themselves: **Download** opens the release page. Neither can the Windows portable exe.
- Profiles, sounds and trusted certificates are stored in the app's data folder. To run two copies side by side, e.g. for testing, set `FRIENDSPEAK_USER_DATA=/some/folder`.

## Virtual penguin world

The game is built into every friendspeak server. Click the 🐧 game under *Games* in the channel list.

Anyone on the server can turn it on or off in **Settings → Server → Games**. When it's off, or the server doesn't have the game assets, the *Games* section doesn't appear at all.

- You're logged straight in. Your penguin is created from your friendspeak profile the first time you play: its name comes from your display name, and its color is the closest penguin color to your profile color. It's saved on that server.
- Everyone on the server shares the same world (default name *Blizzard*), and the member list shows who's playing.
- The game keeps running while you switch to text channels, and voice keeps working. **Pop out** opens it in its own window.
- Push-to-talk and soundboard hotkeys keep working while the game has focus.

### Game assets (host only)

The Yukon code is open source (MIT), but the game's art, sounds and fonts are **not included**. These assets are third-party intellectual property, so only use them for private play with friends.

Only the **host** needs the assets. Friends load them from the server. Put a Yukon-compatible pack (one with `media/` and `fonts/` at the top level, and `media/crumbs/en/crumbs.json` containing `rooms`, `pets`, `widgets`, etc.) in `game/assets-pack/`.

Packs made for modified Yukon forks (with different crumbs such as `puffles`/`stamps` instead of `pets`, or no `igloos` folder) won't work with the upstream client used here.

Other places the server looks, if you'd rather merge the pack somewhere else:

- `game/client/assets/`, which matches Yukon's own instructions
- `<desktop data folder>/game-assets/` for the desktop app
- any folder you set with `GAME_ASSETS_DIR=/path/to/assets`

Then restart the server. The startup log shows `Penguin game: ready`. The game server and client are built automatically during `npm install`. If needed, rebuild them with `npm run build:game`.

## How friends connect (read this for voice to work)

The client is the **desktop app**; the server does not serve a web UI. Each friend installs the app, clicks **+** in the left rail, and enters the host's `IP:port`. Plain `http://` works, and the microphone always works in the app.

For an encrypted connection, the host runs the server with `npm run start:https` (or Docker, which defaults to HTTPS), and friends connect to `https://HOST-IP:PORT`. The first time a friend connects, the app shows the certificate's fingerprint and asks whether to trust it. The host can check it matches the `Certificate:` line the server printed on startup.

To play over the internet instead of a LAN, forward the TCP port on the host's router. Chat, voice signaling and the game all use that single port. Voice is peer-to-peer and uses public STUN servers, which covers most home networks. A few strict NATs may need a TURN server, which you can add to `ICE` in `public/js/voice.js`.

## Server options (environment variables)

| Variable        | Default       | Purpose                                                        |
|-----------------|---------------|----------------------------------------------------------------|
| `PORT`          | `3000`        | Port to listen on                                              |
| `SERVER_NAME`   | `friendspeak` | Initial server name (first start only; afterwards rename it in Settings → Server) |
| `PASSWORD`      | none          | Require a password to join                                     |
| `GIPHY_API_KEY` | none          | Lets everyone search GIFs without their own key                |
| `MAX_STORAGE`   | `2GB`         | Total size of all uploaded files (`500MB`, `10GB`, or bytes). Uploads that don't fit are refused |
| `HTTPS`         | off           | `1` = serve over HTTPS with an auto-generated self-signed cert |
| `DATA_DIR`      | `./data`      | Where channels, history, emojis, certs and the game database are stored |
| `GAME`          | on            | `off` = disable the game entirely (not served, not started, can't be turned on in Settings) |
| `GAME_ASSETS_DIR` | none        | Extra folder containing the Yukon asset pack                   |
| `GAME_WORLD`    | `Blizzard`    | Name of the game world                                        |
| `GAME_MAX_USERS`| `300`         | Player limit for the world                                     |
| `GAME_SPAWN`    | `100` (Town)  | Room new logins start in; `0` = random, like upstream Yukon    |
| `GAME_DEBUG`    | off           | `1` = log every game packet                                    |
| `AUTO_UPDATE`   | `off`         | `notify` = check for new releases and tell everyone on the server. `on` = also install them in the maintenance window (**Docker only**, see [Automatic updates](#automatic-updates)) |
| `MAINTENANCE_CRON` | `0 6 * * 0` | When updates are installed, in cron format (minute hour day month weekday) and the server's local time (`TZ`). Default: Sundays at 06:00 |
| `MAINTENANCE_WARN` | `24h`      | How long before the window users see the warning (`90m`, `2d`, …) |
| `GITHUB_TOKEN`  | none          | Lets the server read releases while the GitHub repo is private |

Example: `SERVER_NAME="Game Night" PASSWORD=hunter2 npm start`

## Docker / Portainer

The `Dockerfile` builds a self-contained server image: Node 24, the game prebuilt, only production dependencies, and a non-root user. `docker-compose.yaml` runs it with a named data volume, a health check, a read-only root filesystem and clean shutdown.

**1. The image.** Every release publishes `ghcr.io/nickolaiposs/friendspeak:<version>` and `:latest` (amd64 and arm64). That's the compose default. While the repo is private, log the Docker host in once with `docker login ghcr.io` (a GitHub token with `read:packages`). To build your own instead:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/<you>/friendspeak:1.1.0 --push .
# or build directly on the Docker host:  docker build -t friendspeak:latest .
```

**2. Create the stack.** In Portainer, go to **Stacks → Add stack → Web editor**, paste `docker-compose.yaml`, and set the environment variables (see `.env.example`). The most important ones:

| Variable | Default | Purpose |
|---|---|---|
| `FRIENDSPEAK_IMAGE` | `ghcr.io/nickolaiposs/friendspeak:latest` | The image from step 1 |
| `COMPOSE_PROFILES` + `WATCHTOWER_TOKEN` | none | Optional. `autoupdate` + a secret (`openssl rand -hex 32`) to install updates automatically |
| `AUTO_UPDATE` / `MAINTENANCE_CRON` / `TZ` | `on` / `0 6 * * 0` / `UTC` | See [Automatic updates](#automatic-updates) |
| `FRIENDSPEAK_PORT` | `3000` | Host port (TCP) friends connect to |
| `PASSWORD` | none | **Set this** if the port is reachable from the internet |
| `HTTPS` | `1` | `1` = self-signed HTTPS on the port. `0` = plain HTTP for use behind a TLS reverse proxy |
| `GAME_ASSETS_PATH` / `GAME_EXTRA_ASSETS_PATH` | `/opt/friendspeak/assets-*` | Absolute host paths of the game asset packs, mounted read-only |

`SERVER_NAME`, `GIPHY_API_KEY`, `MAX_STORAGE`, `GAME_WORLD` and `GAME_MAX_USERS` work as in the table above.

**3. Game assets (optional).** Copy the asset pack to the Docker host (e.g. `game/assets-pack` → `/opt/friendspeak/assets-pack`, and `game/assets-extra` → `/opt/friendspeak/assets-extra`). Without them, chat and voice work, and the game says its assets are missing.

**TLS.** With `HTTPS=1`, desktop-app users are asked once to trust the server's certificate fingerprint (printed in the container log). Alternatively, put the container behind a reverse proxy with a real certificate (Nginx Proxy Manager, Traefik, Caddy, …), set `HTTPS=0`, **enable WebSocket support** on the proxy, and stop publishing the port publicly.

**Data.** Everything lives in the `friendspeak-data` volume: `state.json` (channels, history, emojis, file list), `files/` (uploaded files), `game.sqlite` (penguins), `game-secret`, and the TLS key/cert. Back it up. If it's recreated, the certificate changes and desktop users see a "certificate changed" warning.

### Automatic updates

Optional. The compose file includes a second service, `watchtower` ([nickfedor/watchtower](https://github.com/nicholas-fedor/watchtower), the maintained fork), which runs only when you set `COMPOSE_PROFILES=autoupdate` and `WATCHTOWER_TOKEN` (`openssl rand -hex 32`). Without them, friendspeak runs normally and only announces new versions: users see "an update is available" and you update by hand. With them and `AUTO_UPDATE=on` (the compose default):

1. friendspeak checks GitHub for a new release every 6 hours.
2. When one appears, it's scheduled for the next maintenance window (`MAINTENANCE_CRON`, at least 10 minutes away). Everyone on the server gets a closeable warning `MAINTENANCE_WARN` before the window, and again 10 minutes before. **Settings → About & updates** shows the schedule.
3. At the window, friendspeak asks Watchtower to pull the new image and recreate the container. The server is offline for a minute or two, and clients reconnect by themselves. If it fails, it's retried at the next window.

friendspeak only schedules a window when Watchtower answers, so a missing or stopped sidecar never produces a maintenance warning that doesn't happen. It checks again every 6 hours. If your Portainer version ignores `COMPOSE_PROFILES`, delete the `profiles:` line instead.

Only the watchtower container gets the Docker socket, and it only touches containers labeled `com.centurylinklabs.watchtower.enable=true` (friendspeak). While the repo is private, also set `GITHUB_TOKEN` (friendspeak reads releases) and `GHCR_USER`/`GHCR_TOKEN` (watchtower pulls the image).

Examples: `0 4 * * *` is every day at 04:00. `30 3 * * 1-5` is weekdays at 03:30. `0 6 1 * *` is the 1st of each month.

To update by hand instead, set `AUTO_UPDATE=notify` (or pin `FRIENDSPEAK_IMAGE` to a version), then click **Update the stack** with "Re-pull image" checked. Hosts using `npm start` can use `AUTO_UPDATE=notify` and `git pull && npm install` themselves.

## GIFs

GIF search uses GIPHY, which requires a free API key from https://developers.giphy.com. You can supply it in either of two ways:
- each user pastes a key in **Settings → Integrations** (stored only in their browser), or
- the host sets `GIPHY_API_KEY`, and the server searches on everyone's behalf.

## Tips

- Right-click a channel to rename or delete it. Right-click a server icon to edit or remove it.
- Click someone in a voice channel to change their volume just for you.
- Sharing audio: Chrome/Edge share system audio when you share an entire screen on Windows, and tab or window audio elsewhere. The desktop app shares system audio on Windows and macOS 13+ (grant Screen Recording permission on macOS). Use headphones while sharing system audio from the desktop app, or friends may hear themselves.
- Press ↑ in an empty composer to edit your last message. Shift-click the trash icon to delete without confirming (messages and files).
- File links are unguessable but not password-protected: anyone you give a file's URL to can download it, like Discord attachments.
- To edit a sound, right-click it or use the pencil icon. Hotkeys and push-to-talk only work while the friendspeak window is focused (a browser limitation).
- Your profiles, saved servers, settings and sounds live in your browser's storage. Use **Settings → My profile → Export** to move a profile to another computer.

## Documentation for contributors

- [`AGENTS.md`](AGENTS.md): start here if you're changing the code (engineers and AI agents). It covers commands, rules, common tasks and gotchas.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): components, the socket protocol, storage, voice/audio, and the desktop app.
- [`docs/DECISIONS.md`](docs/DECISIONS.md): design decisions and their trade-offs.
- [`docs/GAME.md`](docs/GAME.md): the Yukon integration, the patch inventory, the extra rooms, and recipes.

## Project layout

```
server.js           Express + Socket.IO server: channels, history, emojis, voice signaling
public/index.html   App shell
public/css/         Styles
public/js/main.js   UI and app logic
public/js/voice.js  WebRTC mesh voice
public/js/dm.js     Peer-to-peer direct messages (WebRTC data channels)
public/js/audio.js  Web Audio graph: mic, mute/PTT gate, soundboard mixing, levels
public/js/store.js  Local profiles, servers, settings (localStorage), sounds and DMs (IndexedDB)
public/js/util.js   Helpers: markdown, avatars, formatting
desktop/main.js     Electron main process: secure app origin, certificate pinning, global hotkeys
desktop/preload.js  window.friendspeakDesktop bridge
game/index.js       Serves the game, starts the Yukon worlds, creates penguins for profiles
game/client/        Vendored Yukon client (wizguin/yukon @ 2f47b90, MIT) + friendspeak patches
game/server/        Vendored Yukon server (wizguin/yukon-server @ fead5f7, MIT) + friendspeak patches
scripts/build-game.js  Builds game/server/dist and game/client/dist
Dockerfile          Server image (multi-stage; game built inside, assets mounted at runtime)
docker-compose.yaml Production stack for Docker / Portainer (settings in .env.example)
docker/             Container health check
build/              Desktop app icon and macOS entitlements (electron-builder resources)
```

### Extra rooms and minigames

Upstream Yukon never built several rooms, so their doors were dead. friendspeak adds them (room code in `game/client/src/scenes/rooms/`, data in `src/engine/friendspeak/extras.js`, server entries in `game/server/data/rooms.json`):

Mine, Underground Mine, Recycling Plant, Boiler Room, Lighthouse, Beacon, Pizza Parlor, Stage, Migrator (ship), Ship Hold, Captain's Quarters, Crow's Nest, Hidden Lake, Underwater and Ninja Hideout. The Pet Shop's adoption counter now opens the adoption catalog.

Their art goes in `game/assets-extra/` (or `GAME_EXTRA_ASSETS_PATH` with Docker), in the same layout as the asset pack. Without it, those rooms don't load and everything else works.

Minigames in those rooms: Cart Surfer and Jet Pack Adventure (in the asset pack, but missing from upstream's server), plus Pizzatron 3000, DJ3K (the Night Club's "Mix" booth) and Puffle Rescue.

**Not implemented,** because they need server logic: the pizza-delivery job, Treasure Hunt, the Lighthouse band's layered music, stamps, and a few catalogs (music, telescope, Rockhopper). Those buttons do nothing, or show "closed for construction".

### Changes to the vendored Yukon code

- **Server:** it runs in-process on friendspeak's HTTP server (`/world/login`, `/world/<name>`) instead of separate ports under pm2. It uses SQLite through a small `node:sqlite` adapter for Sequelize (`src/database/sqliteDriver.js`, `schema.sqlite.sql`) instead of MySQL, and `bcryptjs` instead of `bcrypt`, so there are no native modules. Ban expiry checks were fixed to compare dates.
- **Client:** world addresses come from the server. `src/engine/friendspeak/friendspeak.js` handles token auto-login from the URL fragment, auto-joins when there's one world, and forwards keys to the parent app. Phaser is served locally, the JS obfuscator was removed, and "Create penguin" logs you in instead of opening a sign-up page.

Voice is a full mesh (everyone connects to everyone), which works well for friend-group sizes of roughly 8–10 people per channel.
