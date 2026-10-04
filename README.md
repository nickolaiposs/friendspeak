# friendspeak

A self-hosted Discord / Slack / TeamSpeak-style app for you and your friends.
No accounts or sign-up. Run a server, share your IP, and talk.

- **Text channels:** markdown (`# heading` / `##` / `###`, `-# small text`, `**bold**`, `*italic*`, `__underline__`, `~~strike~~`, `||spoiler||`, `- lists`, `1. lists`, `> quotes`, `` `code` ``, ```` ``` ```` blocks), replies, edits, deletes, reactions, @mentions, typing indicators, and history that persists on the server.
- **Direct messages:** peer to peer and end-to-end encrypted, separate from any server. Click anyone in a member list (or right-click them) and choose **Message**, or swap **friend codes** (the **+** under **DMs**) to message someone you share no server with. Conversations show up in their own collapsible **DMs** group at the top of the left rail, above your servers, and opening one doesn't disconnect you from the server or its voice channel. Text, images (up to 4 per message, 10 MB each), GIFs, replies, edits and reactions. Messages are stored only on your two devices. If your friend is offline, the message waits, still encrypted, in their mailbox on a server they use, and arrives the next time they open the app. Images come straight from your friend's device, so the full picture loads once you're both online (a small preview arrives with the message).
- **Notifications:** DMs, calls and @mentions (`@name`, `@role`, `@everyone`, or a reply to you) notify you, even for servers you aren't looking at. Ordinary server messages never do, they only mark the channel unread. Typing `@` in a server shows a pick list. Right-click a person or a server to mute its notifications, and choose which sounds play in **Settings → Notifications**.
- **Calls in DMs:** the phone and camera buttons at the top of a conversation start a voice or video call with that friend. During a call you can mute, turn on your camera, share your screen (with audio) and use the soundboard, like in a voice channel. Calls are peer to peer, like the messages. You can keep browsing servers and other conversations while you're in one; joining a voice channel hangs up, and starting or accepting a call leaves the voice channel.
- **Member list:** everyone online, plus an **Offline** section with everyone who has been on the server before (collapsible). Roles show as small tags next to names.
- **Roles and permissions:** Discord-style roles with a color and permissions: administrator, see channels, send messages and join voice, mention roles, mention @everyone, remove, kick from voice, ban, force mute, manage roles, channels, emojis and files, and delete other people's messages. Every role starts from the default permissions (see, send and mention), and the highest role that sets something wins. Each channel can override see, send/join and manage per role, from its right-click **Permissions…**; people who can't see a channel don't get it at all. Give someone a role from **Server settings → Members** or by right-clicking their name anywhere. Moderators with **Manage roles** can only hand out roles without permissions; anything with permissions is for admins. A server stays open, with everyone allowed everything as before, until the host makes someone an admin in the [admin dashboard](#admin-dashboard).
- **Remove from server:** right-click someone → **Remove from server…** to disconnect them and take them off the list. They can come back.
- **Bans:** right-click someone → **Ban…** to disconnect them and keep their profile (and optionally their IP) out. Unban in **Server settings → Bans**.
- **Moderation in voice:** right-click someone in a voice channel → **Kick from voice** or **Force mute**. A force mute can be lifted, but it never unmutes someone who muted themselves.
- **Files:** drop, paste or attach up to 10 files per message. Images, videos and audio play inline, and other files get a download card. A TeamSpeak-style **file browser** (the folder icon in the channel header, or next to the server name) lists the files of one channel or the whole server, with search, sorting and storage usage. You can delete your own files, and people with **Manage files** anyone's. The host caps total storage with `MAX_STORAGE` (default 2 GB).
- **Embeds:** links to YouTube, Vimeo, Streamable, Spotify, SoundCloud and direct image/video/audio files embed a player under the message. Wrap a link in `<angle brackets>` to post it without an embed.
- **Voice channels:** peer-to-peer WebRTC voice with mute, deafen (with optional shortcuts), push-to-talk, a master volume, per-user volume (0–300%) and mute, speaking indicators, device selection (switchable mid-call: right-click mute), automatic gain, echo cancellation, noise suppression that runs on your device (DeepFilterNet, with a strength slider), a noise gate with a level bar, a mic test that plays your mic back to you (and silences everyone else), and the highest Opus quality (stereo, up to 510 kbps; a server can lower it in Settings → Server). The call keeps going while you look at another server: the voice panel shows where it is and takes you back.
- **Screen sharing:** share an entire screen or a single window, with audio, at up to 1440p 60 fps, from the monitor button in the voice panel. Friends click the red **LIVE** badge to watch. Video is only sent to people who are watching. In the desktop app on macOS and Windows the share is captured and encoded by a native helper (on the graphics card when it can), and encoded once however many friends watch.
- **Cameras:** the camera button next to it turns on your webcam (up to 1440p 60 fps in the desktop app on macOS and Windows, 1080p 60 fps otherwise or with a background). Right-click it, or go to **Settings → Voice & video**, to pick a device. Before the camera goes on you get a preview, where you can blur your background (with a strength slider) or replace it with a picture: one that comes with the app, or your own. Right-click the camera button to change it mid-call. The background is replaced on your own computer, so the room behind you is never sent. Click the camera icon next to anyone in the channel to open the video view with every camera, plus the screen share you're watching.
- **Emojis:** a full searchable emoji picker, plus **custom server emojis** that you upload and use as `:name:`. Channel names can have emojis too: use the emoji button in the create/rename dialog.
- **GIFs:** GIPHY search built into the composer.
- **Saved profiles:** name, avatar (any image, an animated GIF, a GIPHY GIF, a link, or an emoji), a **profile background** (image, GIF or color, shown on your profile card when friends click your name), color and status, stored in your browser. You can keep several, switch between them, and export or import them as JSON. Each profile is its own account: it has its own server list and direct messages, and joins every server (password included) itself.
- **Themes:** **Settings → Appearance** has dark, light and high-contrast themes, 50 popular color schemes (Catppuccin, Dracula, Nord, Gruvbox, Tokyo Night, … from the [Gogh](https://github.com/Gogh-Co/Gogh) collection) with a preview of each, and a color picker for every color in the UI. You can also change the font, text size, density and the size of the whole UI. It's stored on your device and nobody else sees it.
- **Connect by IP:** save any number of servers in the left rail.
- **Invites:** joining a server takes an invite token (`K7QF-29XM-PA3T-Z6WH`), entered once. An invite can work until it is revoked, once, a set number of times, or for a set time. The server lists who made each invite, how often it was used, how long it has left and who joined with it, and administrators can copy a working invite again. Friends paste it into the **Invite** field of **Connect to a server**.
- **Server settings:** click the server name, or right-click the server → **Server settings…**, for the overview (name, icon, voice quality, game), roles, members, emojis and bans. Only admins and moderators (anyone whose roles let them moderate or manage something) can open it, and everyone while the server is still open. Admins can set the icon from any image (it's resized for you), an animated GIF, a GIPHY GIF or an https link. Everyone on the server sees it, like Discord.
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

The server only hosts: it has no chat web UI. Everyone, including the host, uses the **desktop app** (below) and clicks **+** in the left rail to add the server. The host can also open the [admin dashboard](#admin-dashboard) in a browser. The server prints the addresses to use:

```
  Local address:     http://localhost:3000  (connect with the desktop app)
  Friends connect:   http://192.168.1.20:3000
  Admin dashboard:   http://localhost:3000/admin  (no key needed from this machine)
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

### Logs and crash reports

The app keeps a log of errors and connection events, and a report for each crash, on your computer only. Nothing is sent anywhere. **Settings → About & updates → Logs and crash reports** shows them and can save or copy a report to send to whoever is helping you. The log never holds your messages, and passwords, keys and your home folder's name are removed from it. It is kept for 14 days.

## Virtual penguin world

The game is built into every friendspeak server. Click the 🐧 game under *Games* in the channel list.

An admin can turn it on or off in **Server settings → Overview**. When it's off, or the server doesn't have the game assets, the *Games* section doesn't appear at all.

- You're logged straight in. Your penguin is created from your friendspeak profile the first time you play: its name comes from your display name, and its color is the closest penguin color to your profile color. It's saved on that server. If you change your display name, your penguin is renamed the next time you open the game.
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

The client is the **desktop app**; the server does not serve a chat web UI. Each friend installs the app, clicks **+** in the left rail, and enters the host's address. An address without a scheme means `https://` (port 3000 unless one is given), so for a plain HTTP server (`npm start`) type `http://IP:port`. The microphone works in the app either way.

For an encrypted connection, the host runs the server with `npm run start:https` (or Docker, which defaults to HTTPS), and friends connect to `HOST-IP:PORT`. The first time a friend connects, the app shows the certificate's fingerprint and asks whether to trust it. The host can check it matches the `Certificate:` line the server printed on startup.

To play over the internet instead of a LAN, forward the TCP port on the host's router. Chat, voice signaling and the game all use that single port. Voice is peer-to-peer and uses public STUN servers, which covers most home networks. A few strict NATs may need a TURN server, which you can add to `ICE` in `public/js/voice.js`.

## Server options (environment variables)

| Variable        | Default       | Purpose                                                        |
|-----------------|---------------|----------------------------------------------------------------|
| `PORT`          | `3000`        | Port to listen on                                              |
| `SERVER_NAME`   | `friendspeak` | Initial server name (first start only; afterwards rename it in Settings → Server) |
| `GIPHY_API_KEY` | none          | Lets everyone search GIFs without their own key                |
| `MAX_STORAGE`   | `2GB`         | Total size of all uploaded files (`500MB`, `10GB`, or bytes). Uploads that don't fit are refused |
| `LOG_RETENTION_DAYS` | `14`     | How many days of the server's log are kept on disk (`data/logs/`) for the admin dashboard. `0` = keep the log in memory only |
| `LOG_MAX_SIZE`  | `50MB`        | Most disk space the log history may use; the oldest days are deleted first |
| `DM_GUESTS`     | on            | `off` = only members can use this server to reach its members by direct message. By default a friend of a member (someone holding their friend code) can pass encrypted DMs through it without having joined; they see nothing else |
| `HTTPS`         | off           | `1` = serve over HTTPS with an auto-generated self-signed cert |
| `DATA_DIR`      | `./data`      | Where channels, history, emojis, certs and the game database are stored |
| `GAME`          | on            | `off` = disable the game entirely (not served, not started, can't be turned on in Settings) |
| `GAME_ASSETS_DIR` | none        | Extra folder containing the Yukon asset pack                   |
| `GAME_WORLD`    | `Blizzard`    | Name of the game world                                        |
| `GAME_MAX_USERS`| `300`         | Player limit for the world                                     |
| `GAME_SPAWN`    | `100` (Town)  | Room new logins start in; `0` = random, like upstream Yukon    |
| `GAME_DEBUG`    | off           | `1` = log every game packet                                    |
| `AUTO_UPDATE`   | `off`         | `notify` = check for new releases and tell everyone on the server. `on` = also install them in the maintenance window (**Docker only**, see [Automatic updates](#automatic-updates)). The admin dashboard can change it, and then takes precedence |
| `MAINTENANCE_CRON` | `0 6 * * 0` | When updates are installed, in cron format (minute hour day month weekday) and the server's local time (`TZ`). Default: Sundays at 06:00. The admin dashboard can change it, and then takes precedence |
| `MAINTENANCE_WARN` | `24h`      | How long before the window users see the warning (`90m`, `2d`, …) |
| `GITHUB_TOKEN`  | none          | Lets the server read releases while the GitHub repo is private |
| `ADMIN_KEY`     | generated     | Admin key for the [admin dashboard](#admin-dashboard) (16+ characters). If unset, a key is generated and printed once on first start |
| `ADMIN_LOCAL`   | on (off in Docker) | `off` = even a request from the server's own machine needs a key |
| `ADMIN`         | on            | `off` = no admin dashboard at all |

Example: `SERVER_NAME="Game Night" npm start`

### Invites

Joining takes an invite. The first start prints one that never expires on the console (in Docker: `docker compose logs friendspeak`). A friend pastes it into the **Invite** field of **Connect to a server**. It is not kept in the log the dashboard shows; find it again under **Invites** in the dashboard.

Make more in the admin dashboard under **Invites**, or in the app under **Server settings → Invites**: one that never expires (until it is revoked), one use, a number of uses, or one that expires after a time. The list shows each working invite's token with a **Copy** button, who made it, its uses, the time it has left and who joined with it. The server keeps the tokens of working invites (in `state.json`), so they can be copied again at any time: the dashboard and administrators see all of them, other people with the permission the ones they made.

In the app only people with the **Create invites** permission see that page or any invite. The permission is off by default: give it to a role (or to everyone) under Roles. Until someone is an administrator, invites are made in the dashboard. Someone with the permission can revoke their own invites; administrators and the dashboard can revoke any.

An invite is needed once. After that the server knows a member by their profile's key, so losing or revoking an invite doesn't lock anyone out. A member who is removed needs a new invite to come back. **Require an invite to join** can be switched off in the dashboard or by an administrator in the app; then anyone who knows the address can join.

A server updated from a version with `PASSWORD`: the variable is ignored, everyone already on the server stays, and the first start after the update prints an invite as above.

## Admin dashboard

The server hosts a small web dashboard at `/admin`, on the same port. It is for the host, not for friends. Today it shows:

- **Overview:** version, uptime, memory, how it is hosted, who is online, storage used, the game and update status.
- **Users:** who is online (with their IP, since when, and what they are doing), everyone who has been on the server before (last seen, last IP) and the bans (with the real IP). You can remove someone, ban them (and their IP) and unban them.
- **Roles:** create, edit, order and delete roles, set their permissions and the default permissions, and assign them to anyone. Make someone an admin here to switch the server from open (everyone can do everything) to permissions. Roles with permissions need a profile with a key (any current app), since older apps' profile ids can be copied.
- **Channels:** each channel's message and file counts, and who is in each voice channel. Read-only: manage channels in the app.
- **Storage:** space used against `MAX_STORAGE`, usage by channel, the largest files and the size of the data files. Read-only.
- **Penguin game:** whether the game is available and on, the world, and how many players are in it.
- **Updates:** the current and latest version, when the server last checked, whether the Watchtower sidecar answers, **Check now** and **Update now**, and settings for the update mode and the maintenance window (see [Automatic updates](#automatic-updates)).
- **Server settings:** the server's name, icon and the game switch, like **Server settings** in the app.
- **Server log:** a live tail of the server's own output, and its history: the log is kept on disk for `LOG_RETENTION_DAYS` (14 by default), so it survives restarts. Filter by level and source (`[auth]`, `[mod]`, `[game]`, `[update]`), search the whole history, jump to a date range, and export what you see as a text file. The log records who did what (connections, refused sign-ins, moderation, failed uploads, errors), never message text, and secrets such as the server password and admin keys are removed before a line is stored.
- **Crash reports:** one report each time the server crashes, fails to start, or stops without shutting down (killed, out of memory, power loss), with the error, the version and the last log lines before it. Copy or download a report to send with a bug report.
- **Admin keys:** create a named key for each admin and revoke it.
- **Audit log:** who signed in, failed sign-ins, and key changes, with time and IP.


**Anyone who can open the dashboard should be treated as having full control of the server.** The admin key is separate from the invites friends join with. The dashboard ignores roles: it can do everything, whatever the app's permissions say.

### Getting in

| Where the server runs | Open | Key |
|---|---|---|
| `npm start` on your own machine | `http://localhost:3000/admin` | not needed from that machine. From another machine it needs HTTPS and a key |
| Docker / Portainer on a LAN | `https://<lan-ip>:3000/admin` | required |
| A public host | `https://your.domain/admin` | required, with a real certificate |

**1. `npm start` on your own machine.** Open `http://localhost:3000/admin`. A request counts as coming from your own machine when it arrives over loopback, to `localhost`, with no proxy headers. Any program or user on that machine gets in the same way. If that isn't what you want, start with `ADMIN_LOCAL=off`. From another machine, use `https://` (`npm run start:https`) and a key.

**2. Docker / Portainer on a LAN.** Open `https://<lan-ip>:3000/admin`. The image always asks for a key (`ADMIN_LOCAL=off`). On the first start the server generates one and prints it once in the container log (`docker logs friendspeak`, or Portainer's log view). Copy it then: only its hash is stored. Or set `ADMIN_KEY` (16+ characters) in the stack's environment instead. The certificate is self-signed, so the browser shows a warning. To check you are talking to your own server, compare the fingerprint shown on the login page with the `Certificate:` line in the log before you click through. A key is never accepted over plain HTTP from another machine.

**3. A public host.** Use a real certificate. A browser warning you click through on the public internet makes interception easy. Put a TLS reverse proxy in front, such as Caddy, and run friendspeak with `HTTPS=0`:

```
your.domain {
    reverse_proxy friendspeak:3000
}
```

- The proxy must pass the original `Host` header, or the app can't sign in ("Could not verify your profile key") and the dashboard refuses changes with a "Cross-origin request refused" error. Caddy does this by default. In nginx add `proxy_set_header Host $host;`. It must also set `X-Forwarded-Proto: https` (nginx: `proxy_set_header X-Forwarded-Proto $scheme;`; Caddy does it by default), or the server thinks the key would travel in clear text and doesn't offer sign-in.
- Leave `ADMIN_LOCAL` off here (it is off in the image). Behind a proxy every request comes from the proxy's address, and friendspeak never trusts `X-Forwarded-For`.
- For the same reason, sign-in lockouts are shared by everyone behind the proxy, and the audit log shows the proxy's address. Rate-limit `/admin` at the proxy if you want per-visitor limits.
- Optional extra layers that need no code: [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) (an email allowlist in front of `/admin`), [Tailscale](https://tailscale.com/) so the dashboard is only reachable on your private network, or an SSH tunnel: `ssh -L 3000:localhost:3000 host`. To a plain `npm start` on that host the tunnel counts as local: open `http://localhost:3000/admin`, no key. To a container it doesn't (the request reaches the server from Docker's network), so the key is still needed and so is TLS: with `HTTPS=1`, open `https://localhost:3000/admin`.

### Managing keys

- Make one key per admin in **Admin keys** and revoke it there when someone leaves. A revoked key's sessions end at once. A new key is shown once, so copy it.
- Signing in lasts up to 12 hours, or 1 hour without activity. Restarting the server signs everyone out.
- If you lose every key, set `ADMIN_KEY` and restart, or delete `admin.json` in the data folder and restart to get a new first-boot key in the log.
- Failed sign-ins are rate limited per address: five are free, then the wait grows up to an hour.
- The audit log is also a file, `admin-audit.log` in the data folder (it rotates at 5 MB).
- `ADMIN=off` turns the dashboard off completely.

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
| `ADMIN_KEY` | generated | Key for the [admin dashboard](#admin-dashboard). If empty, one is generated and printed once in the container log |
| `HTTPS` | `1` | `1` = self-signed HTTPS on the port. `0` = plain HTTP for use behind a TLS reverse proxy |
| `GAME_ASSETS_PATH` / `GAME_EXTRA_ASSETS_PATH` | `/opt/friendspeak/assets-*` | Absolute host paths of the game asset packs, mounted read-only |

`SERVER_NAME`, `GIPHY_API_KEY`, `MAX_STORAGE`, `GAME_WORLD` and `GAME_MAX_USERS` work as in the table above.

**3. Game assets (optional).** Copy the asset pack to the Docker host (e.g. `game/assets-pack` → `/opt/friendspeak/assets-pack`, and `game/assets-extra` → `/opt/friendspeak/assets-extra`). Without them, chat and voice work, and the game says its assets are missing.

**TLS.** With `HTTPS=1`, desktop-app users are asked once to trust the server's certificate fingerprint (printed in the container log). Alternatively, put the container behind a reverse proxy with a real certificate (Nginx Proxy Manager, Traefik, Caddy, …), set `HTTPS=0`, **enable WebSocket support** on the proxy, and stop publishing the port publicly.

**Data.** Everything lives in the `friendspeak-data` volume: `state.json` (channels, history, emojis, file list), `files/` (uploaded files), `mail.json` (DM mailboxes), `game.sqlite` (penguins), `game-secret`, the TLS key/cert, and for the [admin dashboard](#admin-dashboard) `admin.json` (the admin keys, as hashes) and `admin-audit.log`. Back it up. If it's recreated, the certificate changes and desktop users see a "certificate changed" warning.

### Automatic updates

Optional. The compose file includes a second service, `watchtower` ([nickfedor/watchtower](https://github.com/nicholas-fedor/watchtower), the maintained fork), which runs only when you set `COMPOSE_PROFILES=autoupdate` and `WATCHTOWER_TOKEN` (`openssl rand -hex 32`). Without them, friendspeak runs normally and only announces new versions: users see "an update is available" and you update by hand. With them and `AUTO_UPDATE=on` (the compose default):

1. friendspeak checks GitHub for a new release every 6 hours.
2. When one appears, it's scheduled for the next maintenance window (`MAINTENANCE_CRON`, at least 10 minutes away). Everyone on the server gets a closeable warning `MAINTENANCE_WARN` before the window, and again 10 minutes before. **Settings → About & updates** shows the schedule.
3. At the window, friendspeak asks Watchtower to pull the new image and recreate the container. The server is offline for a minute or two, and clients reconnect by themselves. If it fails, it's retried at the next window.

friendspeak only schedules a window when Watchtower answers, so a missing or stopped sidecar never produces a maintenance warning that doesn't happen. It checks again every 6 hours. If your Portainer version ignores `COMPOSE_PROFILES`, delete the `profiles:` line instead.

Only the watchtower container gets the Docker socket, and it only touches containers labeled `com.centurylinklabs.watchtower.enable=true` (friendspeak). While the repo is private, also set `GITHUB_TOKEN` (friendspeak reads releases) and `GHCR_USER`/`GHCR_TOKEN` (watchtower pulls the image).

Examples: `0 4 * * *` is every day at 04:00. `30 3 * * 1-5` is weekdays at 03:30. `0 6 1 * *` is the 1st of each month.

**From the dashboard.** With the Watchtower sidecar running and `WATCHTOWER_TOKEN` set, the **Updates** page has an **Update now** button when a newer version is out. It works with `AUTO_UPDATE=notify` too. Everyone on the server gets a two-minute warning, then the server updates as in step 3 above. You can cancel during the countdown. Without the sidecar the page shows the manual steps instead, and outside Docker the button isn't offered.

**Mode and window from the dashboard.** The **Updates** page also sets the update mode (off, notify or on) and the maintenance window (a cron expression, with a preview of the next runs and the server's time zone). It applies at once, with no restart. A value set there takes precedence over `AUTO_UPDATE` and `MAINTENANCE_CRON` and is kept across restarts, so changing the variable afterwards does nothing until you press **Reset** next to it, which brings back the environment value. The page shows both. `on` still needs the Docker image and `WATCHTOWER_TOKEN`; without them the server stays on notify.

To update by hand instead, set `AUTO_UPDATE=notify` (or pin `FRIENDSPEAK_IMAGE` to a version), then click **Update the stack** with "Re-pull image" checked. Hosts using `npm start` can use `AUTO_UPDATE=notify` and `git pull && npm install` themselves.

## GIFs

GIF search uses GIPHY, which requires a free API key from https://developers.giphy.com. You can supply it in either of two ways:
- each user pastes a key in **Settings → Integrations** (stored only in their browser), or
- the host sets `GIPHY_API_KEY`, and the server searches on everyone's behalf.

## Tips

- Right-click a channel to rename or delete it. Right-click a server icon to edit or remove it.
- Click someone in a voice channel to change their volume just for you, up to 300% for quiet friends, or to mute them. Double-click the slider to go back to 100%.
- Sharing audio: Chrome/Edge share system audio when you share an entire screen on Windows, and tab or window audio elsewhere. The desktop app shares system audio on Windows and macOS 13+ (grant Screen Recording permission on macOS). With native streaming (the default, **Settings → Voice & video → Streaming**) friendspeak's own sound is left out of it, so friends don't hear themselves; without it, use headphones while sharing system audio.
- Press ↑ in an empty composer to edit your last message. Shift-click the trash icon to delete without confirming (messages and files).
- File links are unguessable but not behind an invite: anyone you give a file's URL to can download it, like Discord attachments.
- To edit a sound, right-click it or use the pencil icon. Hotkeys and push-to-talk only work while the friendspeak window is focused (a browser limitation).
- Your profiles, saved servers, settings and sounds live in the app's storage on your computer. Each profile has its own saved servers and direct messages; settings and sounds are shared. Use **Settings → My profile → Export** to move a profile to another computer. The file holds the profile's keys: servers only let a profile in with the key they first saw for it, so keep the file private and don't lose it (a server admin can reset a lost key under **Users** in the admin dashboard).

## Documentation for contributors

- [`AGENTS.md`](AGENTS.md): start here if you're changing the code (engineers and AI agents). It covers commands, rules, common tasks and gotchas.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): components, the socket protocol, storage, voice/audio, and the desktop app.
- [`docs/DECISIONS.md`](docs/DECISIONS.md): design decisions and their trade-offs.
- [`docs/GAME.md`](docs/GAME.md): the Yukon integration, the patch inventory, the extra rooms, and recipes.

## Project layout

```
server.js           Express + Socket.IO server: channels, history, emojis, voice signaling
updater.js          Release check and maintenance-window updates
admin.js            Admin dashboard: access, sessions, JSON API and event stream
logbuffer.js        The server's log: in memory for the live view, on disk (data/logs) for history, secrets removed
crashlog.js         Crash reports (data/crashes)
admin-ui/           The admin dashboard's pages (plain ES modules, served at /admin)
public/index.html   App shell
public/css/         Styles
public/js/main.js   UI and app logic
public/js/voice.js  WebRTC mesh voice
public/js/dm.js     Peer-to-peer direct messages (WebRTC data channels, server mailboxes)
public/js/identity.js  Per-profile key pairs, end-to-end sealing, friend codes
public/js/call.js   Calls in direct messages (voice, camera, screen share)
public/js/background.js  Camera backgrounds (blur and pictures), with MediaPipe person segmentation
public/js/audio.js  Web Audio graph: mic, noise gate, mute/PTT gate, mic test, soundboard mixing, levels
public/js/store.js  Local profiles, servers, settings (localStorage), sounds, DMs and camera background pictures (IndexedDB)
public/js/theme.js  Themes, fonts, text size, density and UI size
public/js/gogh.js   The 50 bundled color schemes
public/js/util.js   Helpers: markdown, avatars, formatting
desktop/main.js     Electron main process: secure app origin, certificate pinning, global hotkeys
desktop/preload.js  window.friendspeakDesktop bridge
desktop/logs.js     The app's own log and crash reports, kept on this computer
public/js/log.js    Sends the page's errors and a few events to that log
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
