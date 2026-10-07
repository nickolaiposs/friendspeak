# friendspeak

A self-hosted Discord / Slack / TeamSpeak-style app for you and your friends.
No accounts or sign-up. Run a server, share your IP, and talk.

- **Text channels:** markdown (`# heading` / `##` / `###`, `-# small text`, `**bold**`, `*italic*`, `__underline__`, `~~strike~~`, `||spoiler||`, `- lists`, `1. lists`, `> quotes`, `` `code` ``, ```` ``` ```` blocks), replies, edits, deletes, reactions, @mentions, typing indicators, and history that persists on the server.
- **Search:** the search field at the top right (Ctrl/Cmd+F) finds messages in a server's text channels, or only the one you're in, and in a DM. Narrow it down with filters, typed or picked from the chips under the field: `from:name`, `in:channel`, `has:image` (or `file`, `gif`, `link`), `before:2026-10-04`, `after:yesterday`, `on:today`. Pick a result to jump to that message, even in another channel or far back. You only find what you can read; DMs are searched on your own device.
- **Links to channels and messages:** type `#` and a channel's name to link it (there's a pick list); the link follows a rename. **Copy message link** on any server message gives a link you can paste in a channel or a DM: it shows a small preview and takes you to the message. A friend who isn't on that server, or can't read that channel, sees "Message Unavailable".
- **Direct messages:** peer to peer and end-to-end encrypted, separate from any server. Click anyone in a member list (or right-click them) and choose **Message**, or swap **friend codes** (the **+** under **DMs**) to add someone with their key before the first message. Two people reach each other through a server they both use. Conversations show up in their own collapsible **DMs** group at the top of the left rail, above your servers, and opening one doesn't disconnect you from the server or its voice channel. Text, images (up to 4 per message, 10 MB each), GIFs, replies, edits and reactions. Messages are stored only on your two devices. If your friend is offline, the message waits, still encrypted, in their mailbox on a server they use, and arrives the next time they open the app. Images come straight from your friend's device, so the full picture loads once you're both online (a small preview arrives with the message).
- **Notifications:** DMs, calls and @mentions (`@name`, `@role`, `@everyone`, or a reply to you) notify you, even for servers you aren't looking at. Ordinary server messages never do, they only mark the channel unread. Typing `@` in a server shows a pick list. Right-click a person or a server to mute its notifications, and choose which sounds play in **Settings → Notifications**.
- **Calls in DMs:** the phone and camera buttons at the top of a conversation start a voice or video call with that friend. During a call you can mute, turn on your camera, share your screen (with audio) and use the soundboard, like in a voice channel. Calls are peer to peer, like the messages. You can keep browsing servers and other conversations while you're in one; joining a voice channel hangs up, and starting or accepting a call leaves the voice channel.
- **Member list:** everyone online, plus an **Offline** section with everyone who has been on the server before (collapsible). Roles show as small tags next to names.
- **Roles and permissions:** Discord-style roles with a color and permissions: administrator, see channels, send messages and join voice, mention roles, mention @everyone, remove, kick from voice, ban, force mute, manage roles, channels, emojis and files, and delete other people's messages. Every role starts from the default permissions (see, send and mention), and the highest role that sets something wins. Each channel can override see, send/join and manage per role, from its right-click **Permissions…**; people who can't see a channel don't get it at all. Give someone a role from **Server settings → Members** or by right-clicking their name anywhere. Moderators with **Manage roles** can only hand out roles without permissions; anything with permissions is for admins. A server stays open, with everyone allowed everything as before, until the host makes someone an admin in the [admin dashboard](#admin-dashboard).
- **Remove from server:** right-click someone → **Remove from server…** to disconnect them and take them off the list. They can come back.
- **Bans:** right-click someone → **Ban…** to disconnect them and keep their profile (and optionally their IP) out. Unban in **Server settings → Bans**; they then need an invite to rejoin.
- **Moderation in voice:** right-click someone in a voice channel → **Kick from voice** or **Force mute**. A force mute can be lifted, but it never unmutes someone who muted themselves.
- **Files:** drop, paste or attach up to 10 files per message. Images, videos and audio play inline, and other files get a download card. A TeamSpeak-style **file browser** (the folder icon in the channel header, or next to the server name) lists the files of one channel or the whole server, with search, sorting and storage usage. You can delete your own files, and people with **Manage files** anyone's. The host caps total storage with `MAX_STORAGE` (default 2 GB).
- **Embeds:** links to YouTube, Vimeo, Streamable, Spotify, SoundCloud and direct image/video/audio files embed a player under the message. Wrap a link in `<angle brackets>` to post it without an embed.
- **Voice channels:** peer-to-peer WebRTC voice with mute, deafen (with optional shortcuts), push-to-talk, a master volume, per-user volume (0–300%) and mute, speaking indicators, device selection (switchable mid-call: right-click mute), automatic gain, echo cancellation, noise suppression that runs on your device (DeepFilterNet, with a strength slider), a noise gate with a level bar, a mic test that plays your mic back to you (and silences everyone else), and the highest Opus quality (stereo, up to 510 kbps; a server can lower it in Settings → Server). The call keeps going while you look at another server: the voice panel shows where it is and takes you back.
- **Screen sharing:** share an entire screen or a single window, with audio, at up to 1440p 60 fps, from the monitor button in the voice panel. Friends hover the voice channel or the person and click **Start watching**, or click the red **LIVE** badge; either joins the channel first if needed. Video is only sent to people who are watching. **Pop out** moves the whole video view, with every stream and camera you are watching, to a window of its own that you can keep on top of other apps while you chat or play. In the desktop app on macOS and Windows the share is captured and encoded by a native helper (on the graphics card when it can), and encoded once however many friends watch.
- **Cameras:** the camera button next to it turns on your webcam (up to 1440p 60 fps in the desktop app on macOS and Windows, 1080p 60 fps otherwise or with a background). Right-click it, or go to **Settings → Voice & video**, to pick a device. Before the camera goes on you get a preview, where you can blur your background (with a strength slider) or replace it with a picture: one that comes with the app, or your own. Right-click the camera button to change it mid-call. The background is replaced on your own computer, so the room behind you is never sent. Click the camera icon next to anyone in the channel to open the video view with every camera, plus the screen share you're watching.
- **Emojis:** a full searchable emoji picker, plus **custom server emojis** that you upload and use as `:name:`. Channel names can have emojis too: use the emoji button in the create/rename dialog.
- **GIFs:** GIPHY search built into the composer.
- **Saved profiles:** name, avatar (any image, an animated GIF, a GIPHY GIF, or an emoji), a **profile background** (image, GIF or color, shown on your profile card when friends click your name), color and status, stored in your browser. You can keep several, switch between them, and export or import them as JSON. Each profile is its own account: it has its own server list and direct messages, and joins every server (password included) itself.
- **Themes:** **Settings → Appearance** has dark, light and high-contrast themes, 50 popular color schemes (Catppuccin, Dracula, Nord, Gruvbox, Tokyo Night, … from the [Gogh](https://github.com/Gogh-Co/Gogh) collection) with a preview of each, and a color picker for every color in the UI. You can also change the font, text size, density and the size of the whole UI. It's stored on your device and nobody else sees it.
- **Connect by IP:** save any number of servers in the left rail.
- **Invites:** joining a server takes an invite token (`K7QF-29XM-PA3T-Z6WH`), entered once. An invite can work until it is revoked, once, a set number of times, or for a set time. The server lists who made each invite, how often it was used, how long it has left and who joined with it, and administrators can copy a working invite again. Friends paste it into the **Invite** field of **Connect to a server**.
- **Server settings:** click the server name, or right-click the server → **Server settings…**, for the overview (name, icon, voice quality, game), roles, members, emojis and bans. Only admins and moderators (anyone whose roles let them moderate or manage something) can open it. The first person to join a new server is its admin. Admins can set the icon from any image (it's resized for you), an animated GIF, a GIPHY GIF or an https link. Everyone on the server sees it, like Discord.
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
  Admin dashboard:   http://localhost:3000/admin-5c1e…  (admin key and authenticator code required, or the local link below)

  Local link (the dashboard without a key, from this computer only, until the server stops):

    http://localhost:3000/admin-5c1e…/?local=…
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
- **Checking a download:** every release after 1.1.8 carries signed build provenance, which says the file was built from this repository by its release workflow. With the [GitHub CLI](https://cli.github.com): `gh attestation verify <file> --repo nickolaiposs/friendspeak`, and for the server image `gh attestation verify oci://ghcr.io/nickolaiposs/friendspeak:<version> --repo nickolaiposs/friendspeak` ([SECURITY.md](SECURITY.md)).
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

The client is the **desktop app**; the server does not serve a chat web UI. Each friend installs the app, clicks **+** in the left rail, and enters the host's address. An address without a scheme means `https://` (port 3000 unless one is given), so for a plain HTTP server (`npm start`) type `http://IP:port`. The microphone works in the app either way. Plain HTTP is not encrypted: the app says so when you type such an address and shows "Not encrypted" under the server's name while you are on it. Use it on a network you trust.

For an encrypted connection, the host runs the server with `npm run start:https` (or Docker, which defaults to HTTPS), and friends connect to `HOST-IP:PORT`. The first time a friend connects, the app shows the certificate's fingerprint and asks whether to trust it. The host can check it matches the `Certificate:` line the server printed on startup.

To play over the internet instead of a LAN, forward the TCP port on the host's router, or host it on a domain with a real certificate ([Deploy on a domain](#deploy-on-a-domain-docker--caddy)). Chat, voice signaling and the game all use that single port. Voice is peer-to-peer and uses public STUN servers, which covers most home networks. A few strict NATs may need a TURN server, which you can add to `ICE` in `public/js/voice.js`.

## Server options (environment variables)

| Variable        | Default       | Purpose                                                        |
|-----------------|---------------|----------------------------------------------------------------|
| `PORT`          | `3000`        | Port to listen on                                              |
| `SERVER_NAME`   | `friendspeak` | Initial server name (first start only; afterwards rename it in Settings → Server) |
| `GIPHY_API_KEY` | none          | Lets everyone search GIFs without their own key                |
| `MAX_STORAGE`   | `2GB`         | Total size of all uploaded files (`500MB`, `10GB`, or bytes). Uploads that don't fit are refused |
| `LOG_RETENTION_DAYS` | `14`     | How many days of the server's log are kept on disk (`data/logs/`) for the admin dashboard. `0` = keep the log in memory only |
| `LOG_MAX_SIZE`  | `50MB`        | Most disk space the log history may use; the oldest days are deleted first |
| `HTTPS`         | off           | `1` = serve over HTTPS with an auto-generated self-signed cert |
| `PUBLIC_URL`    | none          | The address people reach the server at when it's behind a reverse proxy, e.g. `https://chat.example.com`. Only changes the addresses the server prints at start |
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
| `ADMIN_LOCAL`   | on (off in Docker, and when `PUBLIC_URL` is set) | `off` = no local link: even the server's own machine needs a key |
| `TRUST_PROXY`   | off (on in the [domain stack](#deploy-on-a-domain-docker--caddy)) | `1` = behind a reverse proxy, take each person's address from the proxy (the last address in `X-Forwarded-For`) for bans, sign-in limits and the audit log. Only when nothing but the proxy can reach friendspeak's port: anyone who can reach it directly could claim any address |
| `ADMIN_MFA`     | on            | `off` = an admin key alone signs in, with no code from an authenticator app |
| `ADMIN_PATH`    | generated     | The dashboard's path. If unset, a random one (`/admin-…`) is made on the first start and printed at every start. `off` = the plain `/admin`; or a path of your own, such as `/backoffice` |
| `ADMIN`         | on            | `off` = no admin dashboard at all |

Example: `SERVER_NAME="Game Night" npm start`

### Invites

Joining takes an invite. The first start prints one that never expires on the console (in Docker: `docker compose logs friendspeak`). A friend pastes it into the **Invite** field of **Connect to a server**. It is not kept in the log the dashboard shows; find it again under **Invites** in the dashboard.

Make more in the admin dashboard under **Invites**, or in the app under **Server settings → Invites**: one that never expires (until it is revoked), one use, a number of uses, or one that expires after a time. The list shows each working invite's token with a **Copy** button, who made it, its uses, the time it has left and who joined with it. The server keeps the tokens of working invites (in `state.json`), so they can be copied again at any time: the dashboard and administrators see all of them, other people with the permission the ones they made.

In the app only people with the **Create invites** permission see that page or any invite. The permission is off by default: give it to a role (or to everyone) under Roles. Until someone is an administrator, invites are made in the dashboard. Someone with the permission can revoke their own invites; administrators and the dashboard can revoke any.

An invite is needed once. After that the server knows a member by their profile's key, so losing or revoking an invite doesn't lock anyone out. A member who is removed needs a new invite to come back. **Require an invite to join** can be switched off in the dashboard or by an administrator in the app; then anyone who knows the address can join.

A server updated from a version with `PASSWORD`: the variable is ignored, everyone already on the server stays, and the first start after the update prints an invite as above.

## Admin dashboard

The server hosts a small web dashboard on the same port, at a random path it makes on the first start (`/admin-` and 32 characters). It is for the host, not for friends. Today it shows:

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
- **Admin keys:** create a named key for each admin, revoke it, and reset its 2-step sign-in.
- **Audit log:** who signed in, failed sign-ins, and key changes, with time and IP.


**Anyone who can open the dashboard should be treated as having full control of the server.** The admin key is separate from the invites friends join with. The dashboard ignores roles: it can do everything, whatever the app's permissions say.

### Getting in

**The address.** The dashboard's path is random, so someone who only knows the server's address can't find the sign-in page: `/admin` answers like any page that doesn't exist. The server prints the full address on the `Admin dashboard:` line every time it starts (`docker logs friendspeak`, or Portainer's log view). The path is kept in `admin.json` in the data folder and stays the same across restarts and updates, so bookmark it. It is left out of the log the dashboard stores. `ADMIN_PATH` sets a path of your own, and `ADMIN_PATH=off` goes back to `/admin`. The path is a second lock, not the lock: the key and the code below are what keep people out.

**2-step sign-in.** The first time a key signs in, the dashboard shows a QR code. Scan it with an authenticator app (Google Authenticator, Aegis, 1Password, …) and type the 6-digit code the app shows. From then on that key needs its app's code at every sign-in. Each key has its own. `ADMIN_MFA=off` turns this off for the whole server. Until a key has signed in once, whoever has the key can set this up, so sign in soon after making one.

**Updating from 1.1.5 or older:** `/admin` stops working from another machine. Read the new address from the server's output, and expect the QR code at your next sign-in. To keep things as they were, set `ADMIN_PATH=off` and `ADMIN_MFA=off`.

| Where the server runs | Open | Key |
|---|---|---|
| `npm start` on your own machine | the **Local link** the server prints when it starts | not needed with that link. From another machine it needs HTTPS, a key and its code |
| Docker / Portainer on a LAN | `https://<lan-ip>:3000/admin-…` | key and code |
| A public host | `https://your.domain/admin-…` | key and code, with a real certificate |

**1. `npm start` on your own machine.** Open the **Local link** from the server's output. It carries a token made for that run of the server, and it works only from the machine itself: over loopback, to `localhost`, with no proxy headers. It signs that browser in without a key until the server stops; the next start prints a new link. The address alone is not enough, because a tunnel running on the machine (`ssh -R`, ngrok, playit and the like) reaches the server over loopback too. Any program or user on the machine that can read the server's output gets in the same way. If that isn't what you want, start with `ADMIN_LOCAL=off`. Without the link, `localhost` asks for a key like anywhere else. From another machine, use `https://` (`npm run start:https`) and a key.

**2. Docker / Portainer on a LAN.** Open `https://<lan-ip>:3000` followed by the path from the container log. The image always asks for a key (`ADMIN_LOCAL=off`). On the first start the server generates one and prints it once in the container log (`docker logs friendspeak`, or Portainer's log view). Copy it then: only its hash is stored. Or set `ADMIN_KEY` (16+ characters) in the stack's environment instead. The certificate is self-signed, so the browser shows a warning. To check you are talking to your own server, compare the fingerprint shown on the login page with the `Certificate:` line in the log before you click through. A key is never accepted over plain HTTP from another machine.

**3. A public host.** Use a real certificate. A browser warning you click through on the public internet makes interception easy. [Deploy on a domain](#deploy-on-a-domain-docker--caddy) sets all of this up. To do it yourself, put a TLS reverse proxy in front, such as Caddy, and run friendspeak with `HTTPS=0`:

```
your.domain {
    reverse_proxy friendspeak:3000
}
```

- The proxy must pass the original `Host` header, or the app can't sign in ("Could not verify your profile key") and the dashboard refuses changes with a "Cross-origin request refused" error. Caddy does this by default. In nginx add `proxy_set_header Host $host;`. It must also set `X-Forwarded-Proto: https` (nginx: `proxy_set_header X-Forwarded-Proto $scheme;`; Caddy does it by default), or the server thinks the key would travel in clear text and doesn't offer sign-in.
- Leave `ADMIN_LOCAL` off here (it is off in the image, and `PUBLIC_URL` turns it off): behind a proxy there is no browser of your own on the server's machine to give a local link to.
- Behind a proxy every request comes from the proxy's address. Unless told otherwise friendspeak doesn't believe `X-Forwarded-For`, so wrong-invite and sign-in lockouts are shared by everyone, the audit log shows the proxy's address and an IP ban only bans the profile. Set `TRUST_PROXY=1` to take addresses from the proxy instead, but only if the proxy is the only thing that can reach friendspeak's port (not published, or firewalled), and it adds the caller's address at the end of `X-Forwarded-For` (Caddy and nginx's `$proxy_add_x_forwarded_for` do). Otherwise anyone could claim any address.
- Optional extra layers that need no code: [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) (an email allowlist in front of the dashboard's path; set `ADMIN_PATH` to one you can write in a rule), [Tailscale](https://tailscale.com/) so the dashboard is only reachable on your private network, or an SSH tunnel: `ssh -L 3000:localhost:3000 host`. To a plain `npm start` on that host the tunnel looks local, so the server's local link works through it; without the link it asks for a key. To a container it doesn't (the request reaches the server from Docker's network), so the key is still needed and so is TLS: with `HTTPS=1`, open `https://localhost:3000` and the dashboard's path.

### Managing keys

- Make one key per admin in **Admin keys** and revoke it there when someone leaves. A revoked key's sessions end at once. A new key is shown once, so copy it.
- Signing in lasts up to 12 hours, or 1 hour without activity. Restarting the server signs everyone out.
- If an admin loses the phone with their authenticator app, another admin clicks **Reset 2-step** next to their key, and the key sets it up again at its next sign-in. If it was the only key: on the server's own machine the local link from the server's output needs no key (`npm start`), a changed `ADMIN_KEY` counts as a new key, and deleting `admin.json` starts over with a new key and a new path.
- If you lose every key, set `ADMIN_KEY` and restart, or delete `admin.json` in the data folder and restart to get a new first-boot key in the log.
- Failed sign-ins are rate limited per address: five are free, then the wait grows up to an hour. Wrong codes are also counted per key.
- The audit log is also a file, `admin-audit.log` in the data folder (it rotates at 5 MB).
- `ADMIN=off` turns the dashboard off completely.

## Deploy on a domain (Docker + Caddy)

The easy way to host for friends over the internet: friendspeak behind [Caddy](https://caddyserver.com/) on a domain of yours, with a real HTTPS certificate that Caddy gets and renews by itself. Friends connect to `https://chat.example.com` and nobody sees a certificate warning. It works on a rented server (a DigitalOcean droplet, Hetzner, …) and on a machine at home. Everything is in [`deploy/`](deploy/).

You need a machine that runs Docker and is reachable from the internet, and a domain (or a subdomain of one you have). Without a domain, use [Docker / Portainer](#docker--portainer) below, which serves a self-signed certificate.

### 1. Point the domain at the server

At the company where the domain is registered (or wherever its DNS is managed), add a record:

| To use | Type | Name / host | Value |
|---|---|---|---|
| a subdomain, `chat.example.com` | `A` | `chat` | the server's public IPv4 address |
| the domain itself, `example.com` | `A` | `@` | the server's public IPv4 address |

Add an `AAAA` record with the IPv6 address too, but only if the server really answers on IPv6. A record that points nowhere makes some connections fail. Leave the TTL at its default. A new record is usually live within minutes; check with `dig +short chat.example.com` (or `nslookup chat.example.com`), which should print the server's address.

- **A subdomain is the better choice** if the domain already has a website: the two don't get in each other's way.
- **Cloudflare:** set the record to **DNS only** (the grey cloud). Proxied (orange) can work, but uploads over 100 MB are refused and port 3000 isn't passed on.
- **At home:** the value is your router's public address (search "what is my IP"). Forward TCP ports 80 and 443 on the router to the machine. If the address changes, use a dynamic DNS service, or your DNS provider's updater. Some providers block these ports or share one address between customers (CGNAT); then this setup can't get a certificate, and a tunnel (Cloudflare Tunnel, Tailscale Funnel) in front of the plain [Docker stack](#docker--portainer) with `HTTPS=0` is the way.

### 2. Open the ports

| Port | For |
|---|---|
| 80 TCP | getting the certificate, and forwarding `http://` to `https://` |
| 443 TCP | everything: chat, voice signaling, files, the game, the admin dashboard |
| 443 UDP | optional: HTTP/3 |
| 3000 TCP | optional: lets friends type `chat.example.com` without `https://` (the app reads that as port 3000) |

Open them in the provider's firewall (DigitalOcean: **Networking → Firewalls**), if there is one. On the server itself Docker opens what it publishes, `ufw` included. Voice is peer to peer, so it needs no ports here.

### 3. Run the installer

On the server:

```bash
curl -fsSL https://raw.githubusercontent.com/nickolaiposs/friendspeak/prod/deploy/install.sh -o install.sh
sudo bash install.sh
```

It installs Docker if it's missing (after asking), asks for the domain, the server's name and whether to install updates automatically, writes the stack to `/opt/friendspeak` and starts it. Then it shows the server's first lines, which have everything you need:

```
  Friends connect:   https://chat.example.com
  Admin dashboard:   https://chat.example.com/admin-5c1e…  (admin key and authenticator code required)
```

plus, on the first start only, the **admin key** and the **first invite**. Copy the key then: it is shown once. Open the dashboard's address, sign in with the key and set up the 2-step code ([Admin dashboard](#admin-dashboard)). Friends install the desktop app, click **+**, enter `https://chat.example.com` and paste an invite.

Without questions: `sudo bash install.sh --domain chat.example.com --name "Game Night" --yes` (`--help` lists the options). While the repo and image are private, give it tokens: `sudo GITHUB_TOKEN=… GHCR_USER=… GHCR_TOKEN=… bash install.sh`.

**By hand instead:** copy `deploy/docker-compose.yaml`, `deploy/Caddyfile` and `deploy/.env.example` (as `.env`) into one folder, set `DOMAIN` in `.env`, and run `docker compose up -d && docker compose logs friendspeak`.

### HTTPS

There is nothing to switch on. When the stack starts, Caddy asks [Let's Encrypt](https://letsencrypt.org/) for a certificate for `DOMAIN`, proves it controls the domain over port 80 or 443, and serves HTTPS on 443. It renews the certificate in the background, about a month before it runs out. friendspeak itself runs plain HTTP inside the stack (`HTTPS=0`) and isn't reachable from outside; only Caddy is.

If `https://chat.example.com` doesn't answer after a minute or two, `docker compose logs caddy` says why. The usual causes:

- the DNS record isn't live yet, or points somewhere else. Caddy keeps trying, so it fixes itself once the record is right
- port 80 or 443 is closed in a firewall, or another web server on the machine already has them. In that case use your existing proxy instead: run the plain [Docker stack](#docker--portainer) with `HTTPS=0` and point the proxy at it
- too many certificates were asked for (Let's Encrypt limits it per domain per week). Don't delete the `caddy-data` volume, which holds the certificate

### Day to day

Run these in the stack's folder (`/opt/friendspeak`):

| | |
|---|---|
| Change a setting | edit `.env` (all of them are in `deploy/.env.example`), then `docker compose up -d` |
| Logs | `docker compose logs -f friendspeak` (or `caddy`) |
| Update | automatic if you said yes ([Automatic updates](#automatic-updates)). By hand: `docker compose pull && docker compose up -d` |
| Change the domain | add the new DNS record, change `DOMAIN` in `.env`, `docker compose up -d`. Friends add the server again under the new address; they stay members |
| Game assets | put the packs in `assets-pack/` and `assets-extra/` in the stack's folder ([Game assets](#game-assets-host-only)), then `docker compose restart friendspeak` |
| Back up | the `friendspeak_friendspeak-data` volume (chat, files, keys) |
| Edit the proxy | `Caddyfile`, then `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile` |

**Coming from the self-signed stack on the same machine?** Both stacks are named `friendspeak` and use the same data volume, so nothing is lost: `docker compose down` the old one, then run the installer. Friends add the server again under its new `https://` address and stay members, because the server knows them by their key.

**The admin dashboard behind the proxy.** Sign-in works as it is: Caddy passes the original `Host` header and `X-Forwarded-Proto`. Every request reaches friendspeak from Caddy's address, so the stack sets `TRUST_PROXY=1`: friendspeak takes each person's address from what Caddy reports, for the audit log, the user list, sign-in and wrong-invite lockouts and IP bans. A stack installed before this needs that line added to its `docker-compose.yaml` (under `HTTPS: "0"`); until then everyone counts as one address. See [A public host](#admin-dashboard) for more layers.

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
| `FRIENDSPEAK_MEMORY` | `1g` | Most memory the server's container may use. Past it Docker restarts the server, so raise it on a big server rather than removing it |
| `ADMIN_KEY` | generated | Key for the [admin dashboard](#admin-dashboard). If empty, one is generated and printed once in the container log |
| `ADMIN_PATH` / `ADMIN_MFA` | generated / `on` | The dashboard's path (printed in the container log at every start; `off` = `/admin`) and 2-step sign-in (`off` = key only) |
| `HTTPS` | `1` | `1` = self-signed HTTPS on the port. `0` = plain HTTP for use behind a TLS reverse proxy |
| `GAME_ASSETS_PATH` / `GAME_EXTRA_ASSETS_PATH` | `/opt/friendspeak/assets-*` | Absolute host paths of the game asset packs, mounted read-only |

`SERVER_NAME`, `GIPHY_API_KEY`, `MAX_STORAGE`, `GAME_WORLD` and `GAME_MAX_USERS` work as in the table above.

**3. Game assets (optional).** Copy the asset pack to the Docker host (e.g. `game/assets-pack` → `/opt/friendspeak/assets-pack`, and `game/assets-extra` → `/opt/friendspeak/assets-extra`). Without them, chat and voice work, and the game says its assets are missing.

**TLS.** With `HTTPS=1`, desktop-app users are asked once to trust the server's certificate fingerprint (printed in the container log). Alternatively, put the container behind a reverse proxy with a real certificate (Nginx Proxy Manager, Traefik, Caddy, …), set `HTTPS=0`, **enable WebSocket support** on the proxy, and stop publishing the port publicly. With a domain, [Deploy on a domain](#deploy-on-a-domain-docker--caddy) is that, ready made.

**Data.** Everything lives in the `friendspeak-data` volume: `state.json` (channels, roles, invites, file list), `profiles/`, `messages/` and `emojis.json` (members, history, emojis), `files/` (uploaded files), `mail/` (DM mailboxes), `game.sqlite` (penguins), `game-secret`, the TLS key/cert, and for the [admin dashboard](#admin-dashboard) `admin.json` (the admin keys, as hashes, the dashboard's path and the 2-step secrets) and `admin-audit.log`. Back it up. If it's recreated, the certificate changes and desktop users see a "certificate changed" warning.

### Automatic updates

Optional. The compose file includes a second service, `watchtower` ([nickfedor/watchtower](https://github.com/nicholas-fedor/watchtower), the maintained fork), which runs only when you set `COMPOSE_PROFILES=autoupdate` and `WATCHTOWER_TOKEN` (`openssl rand -hex 32`). Without them, friendspeak runs normally and only announces new versions: users see "an update is available" and you update by hand. With them and `AUTO_UPDATE=on` (the compose default):

1. friendspeak checks GitHub for a new release every 6 hours.
2. When one appears, it's scheduled for the next maintenance window (`MAINTENANCE_CRON`, at least 10 minutes away). Everyone on the server gets a closeable warning `MAINTENANCE_WARN` before the window, and again 10 minutes before. **Settings → About & updates** shows the schedule.
3. At the window, friendspeak asks Watchtower to pull the new image and recreate the container. The server is offline for a minute or two, and clients reconnect by themselves. If it fails, it's retried at the next window.

friendspeak only schedules a window when Watchtower answers, so a missing or stopped sidecar never produces a maintenance warning that doesn't happen. It checks again every 6 hours. If your Portainer version ignores `COMPOSE_PROFILES`, delete the `profiles:` line instead.

Only the watchtower container gets the Docker socket, and it only touches containers labeled `com.centurylinklabs.watchtower.enable=true` (friendspeak). The socket is root on the machine, so the container around it is kept small: pinned to a version by digest, a read-only filesystem, no Linux capabilities, and its API only answers with the token. While the repo is private, also set `GITHUB_TOKEN` (friendspeak reads releases) and `GHCR_USER`/`GHCR_TOKEN` (watchtower pulls the image).

Examples: `0 4 * * *` is every day at 04:00. `30 3 * * 1-5` is weekdays at 03:30. `0 6 1 * *` is the 1st of each month.

**From the dashboard.** With the Watchtower sidecar running and `WATCHTOWER_TOKEN` set, the **Updates** page has an **Update now** button when a newer version is out. It works with `AUTO_UPDATE=notify` too. Everyone on the server gets a two-minute warning, then the server updates as in step 3 above. You can cancel during the countdown. Without the sidecar the page shows the manual steps instead, and outside Docker the button isn't offered.

**Mode and window from the dashboard.** The **Updates** page also sets the update mode (off, notify or on) and the maintenance window (a cron expression, with a preview of the next runs and the server's time zone). It applies at once, with no restart. A value set there takes precedence over `AUTO_UPDATE` and `MAINTENANCE_CRON` and is kept across restarts, so changing the variable afterwards does nothing until you press **Reset** next to it, which brings back the environment value. The page shows both. `on` still needs the Docker image and `WATCHTOWER_TOKEN`; without them the server stays on notify.

To update by hand instead, set `AUTO_UPDATE=notify` (or pin `FRIENDSPEAK_IMAGE` to a version), then click **Update the stack** with "Re-pull image" checked. Hosts using `npm start` can use `AUTO_UPDATE=notify` and `git pull && npm install` themselves.

## Steam

While a Steam game is running on your computer, the app shows its name next to yours (🎮): in the member list of your servers and to the people you have a DM open with. The app reads it from Steam on your computer: there is no Steam sign-in, and only games installed through Steam are named. Turn it off under **Settings → Integrations**.

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
- Your profiles, saved servers, settings and sounds live in the app's storage on your computer. Each profile has its own saved servers and direct messages; settings and sounds are shared. Use **Settings → My profile → Export** to move a profile to another computer. The file holds the profile's keys: servers only let a profile in with the key they first saw for it, and whoever has them can read and write your direct messages. Export asks for a passphrase that seals them; keep the file private either way, and don't lose it (a server admin can reset a lost key under **Users** in the admin dashboard).

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
admin-ui/           The admin dashboard's pages (plain ES modules)
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
deploy/             The stack for a domain: friendspeak behind Caddy with real HTTPS, and its install script
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
