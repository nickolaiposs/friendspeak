# Design decisions

This is a lightweight decision record. Each entry covers the context, the decision, its consequences, and the alternatives we rejected. **Before changing something covered here, read its entry.** If you reverse a decision, update the entry rather than deleting it. Add new decisions at the end, with the next number.

Status legend: **Active**, **Superseded**, **Revisit** (known weak spot).

---

## D1: Vanilla JS client, no build step · Active
**Context:** a small app maintained by one person and AI agents, which should run from any friendspeak server without tooling.
**Decision:** `public/` is plain ES modules plus one CSS file. DOM is built with a tiny `h()` helper, and each region re-renders wholesale.
**Consequences:** `main.js` is large (~2k lines) but has no framework churn and no build to break. The same files work in browsers and Electron unchanged. Incremental rendering exists only where it matters (message append/replace).
**Alternatives:** React/Svelte plus a bundler (more structure, but a build step and a heavier desktop package).

## D2: One process, one port · Active
**Context:** friends connect by typing an IP. Every extra port is another thing to forward and explain.
**Decision:** chat, voice signaling, the static client, the game client and both Yukon worlds share one HTTP server. Game worlds are separate Socket.IO servers on paths (`/world/login`, `/world/<name>`), with `destroyUpgrade: false` so they don't kill each other's WebSocket upgrades.
**Consequences:** port-forwarding one TCP port is enough. The game crashing the process takes chat down too (acceptable at this scale).
**Alternatives:** Yukon's default of separate ports under pm2 behind a reverse proxy.

## D3: No accounts, client-owned identity · Active
**Context:** the core requirement is "saved profiles with no signup anywhere".
**Decision:**
- A profile (uuid, name, color, avatar, status) is created and stored in the client, and it can be exported/imported.
- Servers trust the profile id they're sent.
- Access control is at most one shared server password.
- Anyone connected can manage channels and emojis. Only the author can edit or delete a message.

**Consequences:** zero friction. Identity is **spoofable**: anyone who knows your profile id could post as you. Fine for friends, not for public servers. Message history stores `author` (profile id) plus a name snapshot. Avatars live in `state.profiles` so history renders with current avatars.
**Alternatives:** keypair identities (sign `hello` with a local key), which is the natural upgrade path if spoofing matters. Direct messages took that path (D30); servers still trust the profile id.

## D4: JSON file for server state · Active
**Decision:** `data/state.json`, rewritten with a debounced (500 ms) atomic write. History is capped at 500 messages per channel.
**Consequences:** trivial to inspect, back up and reset, with no DB dependency. It rewrites the whole file on each change, which is fine for friend-group traffic. Custom emojis are stored inline as data URLs (≤256 KB each), so the file grows with them.
**Alternatives:** SQLite. It's already present for the game and would be the move if history needs to be unbounded or searchable.

## D5: WebRTC full mesh, server only signals · Active · Revisit at >8–10 people
**Decision:**
- Every member of a voice channel connects to every other.
- The newcomer sends offers; per-peer promise chains serialize SDP and ICE.
- Only public STUN servers are used, with no TURN.

**Consequences:** no media server and the lowest latency on LANs. Upload bandwidth scales as N-1. Some strict NATs will fail to connect (the peer shows as "pending").
**Alternatives:** an SFU (mediasoup/LiveKit) for large channels, or a TURN server (coturn) for NAT problems. Add TURN URLs to `ICE` in `voice.js`.

## D6: Soundboard mixed into the outgoing track · Active
**Context:** TeamSpeak-style soundboards must be heard by everyone, using your own files.
**Decision:**
- Sound files live in the user's IndexedDB, never uploaded.
- Playback goes through a Web Audio graph whose destination stream *is* the track sent to peers.
- Mute/PTT is a gain node on the mic path only, so sounds still play while muted.
- A monitor gain lets you hear yourself.

**Consequences:** there's no server storage and no sync of sound files. Swapping the mic device doesn't renegotiate peers.
**Alternatives:** uploading sounds to the server and playing them on every client (more consistent volume, but storage and abuse concerns).

## D7: Secure-context strategy for the microphone · Superseded by D26
**Context:** browsers only allow `getUserMedia` on https or localhost. Friends typing `http://IP:3000` get no mic.
**Decision:** three supported routes:
1. The desktop app (preferred; see D10).
2. Run friendspeak locally and connect to the remote IP (the UI comes from localhost).
3. `HTTPS=1` with an auto-generated self-signed certificate.

Without a mic, users join **listen-only** instead of failing.
**Consequences:** a slightly awkward browser story, documented in the README. The desktop app makes it disappear.

## D8: GIFs via GIPHY, key per user or per server · Active
**Decision:** a user's own key is used client-side. Otherwise the server proxies the search over the socket (`gif:search`) using `GIPHY_API_KEY`.
**Consequences:** there's no shared default key. GIFs need one key somewhere. Proxying over the socket avoids CORS and keeps the server key private. Sent GIF URLs must be `https://`.

## D9: Emoji picker from npm, served locally · Active
**Decision:** use `emoji-picker-element` and its data, served from `node_modules` under `/vendor` (no CDN). Server custom emojis are data URLs in state, used as `:name:`.
**Consequences:** works offline and on LANs. Standard emoji shortcodes typed as text aren't converted; the picker inserts unicode.

## D10: Desktop app = Electron + a private secure scheme · Active (embedded server removed by D23)
**Decision:**
- The UI is served from `friendspeak://app/`, a privileged custom scheme (`standard`, `secure`, fetch/CORS).
- ~~The main process can run `startServer()` itself.~~ Removed; see D23.
- The renderer only gets a small preload bridge (`contextIsolation`, `sandbox: true`).

**Why a custom scheme:** a secure context means the mic always works. A *fixed* origin means `localStorage`/IndexedDB survive port changes; `http://localhost:<port>` would lose profiles whenever the port changed. And the scheme isn't subject to the https mixed-content rules, so connecting to `http://IP` servers and iframing their `/game/` works (verified against a LAN IP).
**Consequences:**
- (Historical) the embedded server had to run in Electron's Node, which drove D13 (no native modules). D13 still stands so `server.js` stays portable.
- Global soundboard hotkeys work via `globalShortcut`, but **push-to-talk can't be global** (no key-up events). A native hook such as `uiohook-napi` would be needed, which conflicts with D13.

**Alternatives:** Tauri (smaller binaries, but a Rust toolchain and no Node for the embedded server).

## D11: Vendor Yukon rather than depend on it · Active
**Context:** Yukon (client and server) isn't published as packages. It's two MIT repos with their own build setups, and we need to patch them.
**Decision:** copy them into `game/client` and `game/server`, pinned to recorded upstream commits (GAME.md). Build with the root package's toolchain (Babel, webpack). Mark every patch with `friendspeak:`.
**Consequences:** upstream updates are a manual merge, made easier by small, marked patches and the patch inventory in GAME.md. The client's obfuscator and the PHP account-creation page were dropped.
**Alternatives:** git submodules plus patch files (cleaner diffs, harder for agents and newcomers).

## D12: Game worlds run in-process on the shared server · Active
**Decision:** `startWorlds(config)` (a new export from the patched `World.js`) creates the Login world and one game world. Both attach to friendspeak's HTTP server and share one Database instance. The standalone `node dist/World.js Login Blizzard` path still works.
**Consequences:** no pm2 and no reverse proxy. Rate limiting is still enabled. Login hashes include client IP and user-agent, which stay consistent because both worlds are on the same host.

## D13: SQLite via `node:sqlite`, no native modules · Active
**Context:** Yukon expects MySQL (plus a `.sql` import with a trigger), `bcrypt` (native) and, by extension, `sqlite3` (native) if you switch dialects. Native modules would need separate builds for Node and Electron.
**Decision:**
- `game/server/src/database/sqliteDriver.js` is a ~150-line sqlite3-compatible driver over Node's built-in `node:sqlite`. It's passed to Sequelize as `dialectModule`.
- `schema.sqlite.sql` ports `yukon.sql`, including the new-user trigger and case-insensitive usernames.
- `bcrypt` is aliased to `bcryptjs` in `.babelrc`.
- Ban-expiry queries compare with `new Date()`; `Date.now()` numbers compare wrongly against SQLite text dates.

**Consequences:** it requires **Node ≥ 22.13** (unflagged `node:sqlite`). Electron 44 ships Node 24. The DB is one file in the data dir. MySQL still works if someone passes a MySQL config.

## D14: Accountless penguins via auth tokens · Active
**Decision:**
- On `game:login`, `game/index.js` maps the friendspeak profile id to a Yukon user through the `friendspeak_accounts(profileId, userId, baseName)` table, creating the user on first use.
  - The username is derived from the display name: 4–12 printable ASCII characters, unique (a number is appended if taken), and padded with " Penguin" if too short.
  - `baseName` stores the derived name before the uniqueness suffix. When a later `game:login` derives a different one, the penguin is renamed. Comparing derived names rather than usernames keeps a penguin from flipping between `Name` and `Name2`.
  - The penguin color is the nearest classic color to the profile color.
  - The password is random and never used.
- Each `game:login` then mints a Yukon auth token (`selector:validator`, with the validator bcrypt-hashed in `auth_tokens`) and deletes that user's older tokens.
- The client opens `/game/#u=<name>&t=<token>`. The game strips the fragment from the URL, then does Yukon's built-in `token_login`.

**Consequences:**
- It reuses Yukon's own "remember me" login path instead of inventing an auth bypass.
- The token is in the fragment, so it's never sent in HTTP requests or logs.
- A penguin belongs to a profile *per server*.
- Renaming a friendspeak profile renames the penguin the next time the game is launched, not in real time.

## D15: The game runs in an iframe, kept alive · Active
**Decision:**
- The game is an iframe of `<connected server>/game/`, so its origin is the server's. Its own `localStorage` and asset URLs just work.
- It lives in `#game-view`, a sibling of `#main`, and is hidden rather than destroyed when you switch channels.
- The game posts `{source: 'friendspeak-game', event: 'keydown'|'keyup', …}` to its parent. The app checks the origin before feeding these into the PTT and soundboard handlers.
- Presence is reported with `game:state`.

**Consequences:** voice continues while you play. "Pop out" opens a separate window with a fresh token. Hotkeys don't reach the app from a popped-out window.

## D16: Game assets are external; only upstream-compatible packs · Active
**Context:** the game's art and audio are third-party copyrighted material and aren't in the Yukon repos.
**Decision:**
- Never commit or bundle assets.
- The server searches, in order: `GAME_ASSETS_DIR`, `opts.gameAssetsDir` (desktop: `userData/game-assets`), `game/client/assets`, `game/assets-pack`, `game/assets-extra`. First match wins per file, so the client's own `styles/` and `scripts/` beat a pack's copies.
- The game is "available" only if some dir has `media/preload/preload-pack.json`.
- Asset dirs are also mounted at `/assets`, because Yukon loads some files from the site root.

**Pack compatibility (learned):** packs made for modified Yukon forks ship different crumbs (for example `puffles`/`stamps` instead of `pets`) and no igloos, so they don't load in the upstream client. Only upstream-compatible packs work: the 23 crumb files `build-crumbs` expects, every room scene, and igloos.
**Consequences:** installers ship without the game art (bundling it into installers was deliberately not done). Hosts add a pack themselves.

## D17: Add the rooms upstream never built, as isolated scenes · Active
**Context:** upstream Yukon leaves several doors as `null` (the Mine, Pizza Parlor, Lighthouse, …). Switching to a modified fork would mean leaving the upstream client and server, and its asset-pack format.
**Decision:**
- Each extra room is its own scene folder in our client (plus the small pieces they need: `RoomPin`, `ItemIconLoader`, `HoverAnimation`, `ZoneTrigger`, `dojo/mat`, the treasure-hunt table prefabs).
- Register the rooms in `server/data/rooms.json`.
- Merge client room, game and string data from `src/engine/friendspeak/extras.js` **only where the asset pack lacks them**.
- Their art lives in `game/assets-extra`, in the same layout as a pack.
- Add compat shims (`changeLayerMutes`, `rewindLayers`, `stampEarned` on RoomScene; `hasItem`, `hasItems`, `stampEarned` on ClientController) instead of changing the engine.
- Features that would need new server logic (the pizza job, Treasure Hunt, layered band music, stamps, some catalogs) are stubbed and listed in GAME.md.

**Consequences:** every door leads somewhere. The upstream engine stays intact, and each extra room is an isolated folder. Game ids avoid the pack's existing ones (for example Puffle Rescue is 955 because 927 is Mission 11).

## D18: Friends spawn together · Active
**Decision:** default `preferredSpawn` is the Town (100) instead of Yukon's random spawn room. `GAME_SPAWN=0` restores the upstream behaviour.

## D19: Dead doors explain themselves · Active
**Decision:** a trigger that is `null` shows "Sorry, this room is closed for construction!" instead of silently doing nothing. This is patched in `RoomScene.checkTrigger`.

## D20: Self-signed HTTPS with trust-on-first-use pinning in the desktop app · Active
**Context:** hosts port-forward over the internet without a domain, so there's no CA-signed certificate. Plain HTTP would send the password and chat in cleartext.
**Decision:**
- Servers serve HTTPS with the self-signed cert from `server.js` (`HTTPS=1`; the Docker compose file defaults to it).
- Desktop clients pin a server's certificate per hostname after the user confirms its fingerprint (SSH-style). A changed certificate triggers a louder warning.
- Prompts only happen when the user connects to a server (`trustServer` IPC), never from verify-proc callbacks. That way a chat image from a bad-cert host can't pop a trust dialog.

**Consequences:** traffic is encrypted, and it resists interception after the first connect (verify the fingerprint with the host out-of-band to cover that one too). Friends must type `https://` in the address, because scheme-less addresses still default to http. Deleting the server's `key.pem`/`cert.pem` (in `DATA_DIR`) regenerates the cert, and friends then see the "changed" warning.
**Alternatives:** blanket `certificate-error` acceptance, which would encrypt but allow trivial MITM; Let's Encrypt, which needs a domain.

## D21: Production packaging: Docker image + unsigned cross-platform installers · Active
**Decision:**
- **Docker:** a multi-stage `Dockerfile` builds the game in a build stage and ships only production dependencies, running as `node`. State goes in a `/data` volume. The game asset packs are bind-mounted read-only at `game/assets-pack` / `game/assets-extra`, never baked in (rule 2). The compose file defaults to `HTTPS=1` (self-signed, like D20) so a directly exposed port is never cleartext; `HTTPS=0` is for a TLS reverse proxy. The CLI handles SIGTERM, and `close()` flushes the debounced state save, so `docker stop` loses nothing.
- **Desktop:** `npm run dist:all` cross-builds macOS (arm64 + x64 dmg/zip), Windows (x64 NSIS + portable) and Linux (AppImage) from a Mac. macOS builds are ad-hoc signed with the hardened runtime and `build/entitlements.mac.plist` (mic, network, and `disable-library-validation`, which ad-hoc signing needs). Without a proper signature, arm64 downloads are reported as "damaged". No `.deb`, because it requires a project homepage.

**Consequences:** first launch shows Gatekeeper/SmartScreen warnings until a Developer ID / code-signing certificate is added (README → Desktop app). The image has to be built and pushed to a registry, because Portainer web-editor stacks can't `build:`.

## D22: Screen sharing and cameras are opt-in per viewer, over the voice mesh · Active
**Context:** a 1080p60 share is roughly 4–8 Mbps upstream per receiver. In a mesh, sending it to everyone in the channel would multiply that by the channel size, even for people who aren't looking.
**Decision:**
- Screen tracks travel on the existing voice `RTCPeerConnection`s, not a separate connection or an SFU.
- A sender only adds tracks for peers that sent `{ watch: kind, on: true }`, like Discord's "Go Live". Cameras use the same mechanism. Opening the video stage watches every camera in the channel, and closing it stops receiving all of them.
- Signaling moved to perfect negotiation so tracks can be added and removed mid-call from either side.
- _Superseded by D34 (screen shares only; cameras still follow this):_ the capture asks for up to 4K at 120 fps (cameras default to 1080p60, same ceiling), with `contentHint = 'motion'`.
- _Superseded by D34 (the order is now probed per machine and mode; this one is the fallback):_ codec preference is H.264 High → H.264 → VP9 → AV1 → VP8 → H.265. A mesh runs one encoder per viewer, and H.264 is hardware-encoded almost everywhere (VideoToolbox, Quick Sync, NVENC, AMF). Negotiation falls through when a viewer can't decode one. Measured on an M4 Pro in Chrome 154: the default VP8 ran in software and dropped to 960×540, while H.264 used VideoToolbox at 1440p–4K and 120 fps. H.265 comes last because Chrome's WebRTC support for it is new and hardware-only, and H.264 already has hardware on the same machines.
- Each viewer reports how many device pixels it displays (`{ view }`, sent on resize and when its window is hidden). The sender sets `scaleResolutionDownBy`, `maxBitrate` (≈0.06 bits/pixel, capped at 50 Mbps) and `active` per viewer, so thumbnails and minimized windows cost almost nothing.
- No `x-google-start-bitrate` SDP munging. It was tried: with a mid-call share, starting the estimate at 8 Mbps made it collapse to its ~0.05 Mbps floor on both H.264 and H.265, while the default ramp reached the cap in about 9 s.

**Consequences:**
- Upload cost scales with the number of viewers, not the channel size. The server is still only a signaling relay.
- A viewer can watch several shares at once (the grid). Each costs its sender one encoder and one upload, sized to that viewer's tile.
- The sharer's upload is still roughly the sum of each viewer's stream, and a 4K120 share can use tens of Mbps per viewer on a good link. The per-viewer sizing above is the main mitigation (D34 now caps the default at 1440p60 and adds a ladder). Fixing that properly needs an SFU (encode once, the server forwards), which would put media through the server and need UDP ports (against rule 4 and D5).
- Share audio is raw, with no echo cancellation. In Chrome, `restrictOwnAudio` keeps friends' voices out of the capture. Electron's loopback captures all system audio, so friends' voices in the call can be echoed back to them unless the sharer uses headphones or the share is muted.

**Alternatives:** always sending to everyone (simple, but wasteful); a separate peer connection per share (no renegotiation, but double ICE setup); an SFU (against the "no infrastructure" goal).

## D23: The desktop app is a client only; server name and icon live on the server · Active
**Context:** the desktop app used to embed `startServer()` and host by default. That mixed two roles in one process (a host's server died when they closed the window), made installers carry the whole game server, and gave each app its own `serverName` config. Bookmarks also had a per-user "nickname", so friends saw different names for the same server.
**Decision:**
- The desktop app never hosts. To host, run `server.js` (`npm start`) or the Docker image, and connect to it like any other server. Installers bundle only `desktop/` and `public/`.
- The server's name and icon are server state (`state.name`, `state.icon`), edited by anyone connected from Settings → Server (`server:update`), and broadcast to everyone (`server`). Bookmarks cache them (`serverName`, `serverIcon`) so the rail looks right offline. The per-bookmark nickname is gone.
- `SERVER_NAME` only names a new server. It no longer overrides the stored name on every start, or a rename from the UI would be undone on restart.

**Consequences:** hosting always needs Node or Docker on some machine. Anyone on the server can rename it or change the icon, like channels and emojis (D3).

## D24: Files on disk, uploaded over HTTP, one server-wide quota · Active
**Context:** friends want to share files in channels and manage them TeamSpeak-style, without the server growing without bound.
**Decision:**
- Files are stored as plain files in `dataDir/files/<random id>`, with metadata in `state.files`. They aren't data URLs in `state.json` like emojis (D4), because they're far bigger.
- Uploads are a raw-body `POST /api/files` on the same port (D2), not socket.io, which would buffer whole files in memory and needs `maxHttpBufferSize`. The uploader proves it is connected with its socket id; no cookies or extra tokens.
- Upload first, attach with `msg:send`. That keeps one message with several files and text atomic from everyone else's point of view, with per-file progress. Orphans are swept after an hour.
- One quota for the whole server (`MAX_STORAGE`, default 2 GB), counting uploads in flight. There's no per-user quota, because identities are spoofable (D3).
- Anyone connected can delete any file (the D3 trust model, like channels and emojis). Deleting a message deletes its files.
- File URLs are capability URLs: unguessable, but not behind the server password, so `<img>`/`<video>` work cross-origin without auth plumbing. Only a small allow-list of media types renders inline; everything else downloads, so an uploaded HTML file can't script the server's origin (which serves the game client).

**Embeds:** link embeds are decided client-side in `linkEmbed()` (`util.js`), with no server-side unfurling or metadata fetching. The supported providers are YouTube (click-to-play thumbnail, then `youtube-nocookie.com`), Vimeo, Streamable, Spotify and SoundCloud, plus direct https media. `<url>` suppresses the embed. The desktop app adds a `Referer` to YouTube embed requests, because the player refuses to play without one (error 153) and the `friendspeak://` origin sends none.

**Consequences:** backups need the whole data dir, not just `state.json`. Anyone holding a file URL can fetch it, even without the password. Message history is capped at 500 per channel (D4), but files outlive their message and stay in the file browser until deleted.
**Alternatives:** socket.io binary uploads (simpler auth, but memory-heavy); files inside SQLite (one more thing to vacuum); per-user quotas (meaningless with spoofable ids).

## D25: Profile images and server icons: uploads or https links, backgrounds kept out of `users` · Active
**Context:** friends want GIF avatars, profile backgrounds (Discord-style banners) and server icons made from any image. Browsers can't re-encode animation, so an animated GIF can only be kept byte-for-byte or flattened.
**Decision:**
- Avatars, profile backgrounds (`banner`) and the server icon are each either a **data URL** or an **https link** (≤1000 chars). The link is how GIPHY GIFs are used (the GIF picker hands back its URL), and it takes no space in `state.json` or `localStorage`. A background can also be a `#hex` color.
- Uploads go through `fileToDataUrl()`: any image the browser decodes is downscaled and re-encoded (PNG, else JPEG at falling quality). Animated GIF/WebP/APNG files that already fit are kept as-is, so they stay animated. Limits: avatar 384KB, background 640KB, icon 512KB (server-side, in `server.js`; the client aims slightly under). `maxHttpBufferSize` is 4 MB so `hello` fits both images.
- The `users` broadcast omits `banner`, because it is re-sent to everyone on every mute toggle. Backgrounds travel in `profiles` and `profile` events. Avatars stay in `users` so older clients keep working.
- Channel names allow emojis (48 chars). `:custom:` server emojis render as images via `channelNameEl()`, built with `h()`, never `innerHTML`.

**Consequences:** linked images are fetched by every client from a third party (GIPHY or wherever the link points), which reveals viewers' IPs to that host. Chat GIFs already work this way. `referrerpolicy="no-referrer"` keeps the friendspeak address out of those requests. Several profiles with big uploaded GIFs can fill the ~5 MB `localStorage` quota. Saving then fails with a toast that suggests GIPHY links instead.
**Alternatives:** storing profile images as files like D24 (smaller state, but profile images would need their own lifecycle and quota); server-side GIF resizing (needs an image library, against D13's no-native-modules rule).

## D26: The client ships only in the desktop app; the server hosts no UI · Active
**Context:** every server also served `public/` over HTTP, so the client existed in two places (browsers and the desktop app). The browser route only gets a microphone on https or localhost (D7), and it blurred the line between hosting and using.
**Decision:** the server serves only the server: Socket.IO, the HTTP APIs (`/api/info`, `/api/files`, `/files`), and the game (`/game`, `/assets`, the worlds). `/` returns a plain-text notice, the emoji vendor routes are gone, and Socket.IO runs with `serveClient: false`. The client in `public/` is loaded only by the desktop app from `friendspeak://app` (D10), which bundles the emoji picker and `socket.io.js` itself. The Docker image no longer contains `public/`.
**Consequences:** everyone, including the host, needs the desktop app. D7's browser routes (localhost UI, self-signed HTTPS in a browser) no longer apply; the app is always a secure context. The game client is still served by the server, because its assets live there and it runs in an iframe from the server's origin (D15).
**Alternatives:** keeping the web client as an option (two supported surfaces, and the mic caveats of D7).

## D27: The offline list, removals and bans follow the "friends" trust model · Active (DMs superseded by D28)
**Context:** friends asked for Discord-style direct messages, to see people who aren't online, and to keep someone out of the server. There are no accounts and profile ids are spoofable (D3), and every profile id is visible to everyone in `users` and `profiles`.
**Decision:**
- ~~**DMs** were threads in `state.dms`, relayed and stored by the server.~~ Replaced by peer-to-peer DMs (D28); old `state.dms` data is dropped on load.
- **Offline list:** every profile in `state.profiles` that isn't online or banned. Profiles now store `status` and `seen`.
- **Remove from server** (`member:remove`) disconnects someone and deletes their stored profile, so they leave the member list. It's a kick, not a ban: they can reconnect and reappear. Their old messages keep their name snapshot.
- **Bans** match the profile id and, optionally, the IP it last connected from (kept in memory only, and never sent to clients). The IP part is skipped when it's loopback or the same as the banner's IP, so a host behind a reverse proxy or friends on one LAN don't ban themselves. Anyone connected can ban or unban anyone, except themselves.

**Consequences:** a banned friend can come back with a new profile, and with an IP ban from another network. Someone malicious could ban everyone else. The host can then edit `bans` in `state.json`. Behind a reverse proxy every socket has the proxy's IP, so IP bans never apply there (the self-ban guard skips them).
**Alternatives:** end-to-end encrypted DMs and signed identities (keypairs, the D3 upgrade path); an admin role (needs identities that can't be spoofed first).

## D28: Direct messages are peer to peer, and servers are only meeting points · Active (encryption, offline delivery, images and reach extended by D32)
**Context:** DMs stored on the server (D27, first version) meant the host could read them and they only existed on one server. Friends wanted DMs that belong to the two people, reachable from anywhere in the app like a server, not inside one.
**Decision:**
- Messages travel over a WebRTC data channel between the two clients (DTLS-encrypted) and are stored only in each client's IndexedDB, per local profile. The server never sees or stores them.
- Signaling uses a separate Socket.IO namespace, `/dm`, on the same port (D2). Clients keep one `/dm` socket per **bookmarked** server, so two friends can reach each other through any server they both have saved, whichever server they're looking at. It needs the server password and honors bans, and it doesn't make you appear in `users`.
- Delivery is store-and-forward on the sender's device: every change (message, edit, delete, reaction) is an op in an outbox, resent until acked, and idempotent on the receiving side. A message to someone offline is delivered the next time both are online at once.
- DMs live in the rail's **DMs** group (collapsible, like **Servers**) and open in the chat view without disconnecting from the current server, so voice keeps going.
- Text, GIFs, replies, edits, deletes and reactions only. No files, since there's no server storage to hold them and large data-channel transfers need chunking.

**Consequences:**
- The host can't read DMs. The signaling server *could* impersonate someone or intercept the connection by forging the handshake, and anyone who knows a profile id can pretend to be that profile (D3). The chat intro says the second part. Signed identities (keypairs) would fix both.
- Both people must be online at the same time for anything to arrive. There's no server-side mailbox.
- Like voice (D5), there's no TURN server: two friends behind strict NATs may not connect, and their messages stay queued.
- History exists only on the two devices. Clearing browser data, or another device with the same profile, doesn't have it. "Delete conversation" removes only your copy.
- Each bookmarked server costs one extra socket in the background. Servers whose self-signed certificate isn't pinned yet simply fail to connect there, without a prompt (D20).

**Alternatives:** keep server-stored DMs (simple, offline delivery, but readable by the host and tied to one server); server relay of end-to-end encrypted messages (offline delivery, but needs key exchange and identities that can't be spoofed); a TURN server (against D2 and the "no infrastructure" goal).

## D29: Releases from `prod`, in-app client updates, server updates in a maintenance window · Active
**Context:** friends run installers they downloaded once, and hosts run a Docker image. Both need to learn about new versions and get them without the maintainer messaging everyone, and a server shouldn't restart in the middle of a voice call.
**Decision:**
- **Branches:** work lands on `dev` (default). Merging into `prod` releases `version` from package.json (`.github/workflows/release.yml`): a draft GitHub Release with the `CHANGELOG.md` section as notes, installers built on native macOS, Windows and Linux runners (`electron-builder --publish always`, with `latest*.yml`), and `ghcr.io/nickolaiposs/friendspeak:<version>` (amd64 + arm64, with the game build stage on the native platform). Only when all of that succeeds is the release published and the image tagged `:latest`, so apps and servers never see a half-finished release. A version that already exists fails the run: bump it first.
- **Client:** `electron-updater` with `autoDownload` off. A banner and Settings → About & updates show the new version with a link to its release notes. The Windows installer and the AppImage install in-app. Ad-hoc-signed macOS apps can't (Squirrel.Mac requires a Developer ID), so they get a download link until there's a signing identity. Connecting to a server newer than the app triggers a check.
- **Server:** `updater.js` does the detection, scheduling (`MAINTENANCE_CRON`, a dependency-free 5-field cron), warnings (`server:update`) and the trigger. The swap itself is done by a Watchtower sidecar (the maintained `nickfedor/watchtower` fork) in HTTP-API-only mode, limited by label to the friendspeak container. The friendspeak container keeps its read-only filesystem and dropped capabilities: only the sidecar has the Docker socket. `AUTO_UPDATE=on` is Docker-only, and `npm start` hosts get at most `notify`. Watchtower is opt-in (compose profile `autoupdate`). Without it, the server runs normally and only announces updates, and it schedules a window only after Watchtower answers.

**Consequences:** while the repo is private, servers need `GITHUB_TOKEN` (and Watchtower `GHCR_USER`/`GHCR_TOKEN`), and installed apps can't see releases at all: in-app updates start working when the repo goes public. Releases use GitHub Actions minutes, and macOS minutes count 10× on private repos. Watchtower recreates the container from the same config, so compose changes (new env vars) still need a stack redeploy. A server and its clients can briefly run different versions, which the protocol has to tolerate (add fields; don't repurpose them).
**Alternatives:** CI deploying over SSH on every push (no maintenance window, and CI would need credentials for every host); giving friendspeak the Docker socket (root-equivalent access for a chat server); Watchtower polling on its own schedule (no warnings, and no tie to a published release); a signed auto-updater for macOS (needs the $99/yr Apple Developer ID, so later).

## D30: Themes are sets of CSS variables, stored per device · Active
**Context:** issue #8 asked for themes, a custom palette, and font size and density. The stylesheet already drew almost everything from custom properties on `:root`, and the client has no build step (D1).
**Decision:**
- A theme is a value for each of the 17 color variables, and nothing else. `theme.js` sets them on `<html>`. There are three built-in themes (dark, which is the stylesheet's defaults, light and high contrast) and one custom palette in `settings.themeColors` with a color picker per variable. Hard-coded tints in the stylesheet became `color-mix()` of the variables, and text on a filled accent/green/red/yellow surface uses `--on-*`, which `theme.js` picks by contrast.
- Color schemes come from [Gogh](https://github.com/Gogh-Co/Gogh) (MIT or Apache-2.0): 50 well-known ones are copied into `gogh.js` as seven colors each. Gogh has no popularity data, so the 50 are a hand-picked list. They're terminal palettes, so the UI palette is derived: surfaces are shades of the background, the accent is the scheme's magenta, links are its blue, and any color that doesn't read on the background is pushed toward white or black until it does (Solarized's and One Dark's foregrounds are too dim for body text as published). Clicking a scheme fills the custom palette, so a scheme is a starting point you can edit and there's no "scheme" state to keep in sync.
- Text size multiplies every `font-size` (`--font-scale`), density multiplies row padding and line height (`--density`), and fonts are stacks of fonts that ship with operating systems, plus a free-text name for one the user has installed.
- It's all per device in `fs.settings`, like the other settings. Nothing is sent to the server, and other people's profile colors are theirs, not part of a theme.

**Consequences:** a new color in the stylesheet must be one of the variables or a `color-mix()` of them, or it will be wrong in light themes. A new `font-size` must use `calc(… * var(--font-scale))`. Fixed layout sizes (header heights, the rail) don't scale with text size, which is why the slider stops at 20px. No web fonts are bundled, so the font list depends on the OS. The game iframe, video stages and the Electron window's pre-load background keep their own fixed colors.
**Alternatives:** a stylesheet per theme (can't express a custom palette); fetching schemes from Gogh at runtime (the client would depend on a third-party host, and the app works offline on a LAN today); `zoom` or `webFrame.setZoomFactor` for text size (scales the whole layout, which the View menu's zoom already does); letting a server set a theme for everyone (it's a personal preference, and D3's trust model would let anyone change it).

## D31: A voice call keeps its own server connection · Active
**Context:** the client assumed one connected server: clicking another server in the rail closed the socket and with it the call (issue #9). Friends who share several servers want to stay in voice on one while reading another, like Discord.
**Decision:**
- Per-server state moved from `S` into connection objects (ARCHITECTURE.md → Connections). `S.conn` is the server in view and `S.call` the one the call is on. Leaving a server keeps its connection open only while the call is on it, so there are at most two.
- One call at a time, because there is one microphone and one outgoing audio graph (`audio.js`). Joining voice elsewhere hangs up first.
- The background connection carries voice only: it keeps `users`, channels and the server's name current for the voice panel and the stage, but ignores messages. Coming back loads history again, like a fresh connect.
- No server or protocol change. To the call's server you are simply still connected, and you appear online there.

**Consequences:** you show as online on the call's server while looking at another. Messages and mentions there aren't noticed until you return. Clicking the server you are already on while it reconnects still starts a fresh connection, which ends a call on it. Switching profiles ends a call on another server (the new identity has to reconnect).
**Alternatives:** stay connected to every bookmarked server (unread marks everywhere, but a socket and a presence per server, and a much larger change); move the call's signaling to its own socket (two sessions with one profile, which the server replaces by design: one session per profile).

## D32: DMs get keypair identities, end-to-end sealing, server mailboxes, friend codes and images · Active
**Context:** D28's DMs needed both people online at once and a server both had bookmarked, anyone who knew a profile id could pose as that profile, the signaling server could sit in the middle of the handshake, and there were no images (issues #5 and #6). Two devices behind home routers can't find each other or hold messages for each other without some third party, so the question was which one, and how little it has to be trusted.
**Decision:**
- **Identity:** every local profile gets an Ed25519 signing pair and an X25519 pair, made in the app with WebCrypto and stored in `fs.keys`, apart from the profile so they never reach a server. The public half is a signed **card**. A contact's card is pinned the first time it's seen (trust on first use, like D20), and a different key for the same profile id is refused and shown as "different key" until the user accepts it. Profile ids stay the names of conversations, so nothing stored had to move.
- **Sealing:** each pair of people derives one AES-256-GCM key from their X25519 keys. Every op and every image chunk is sealed with it, on the data channel as well as in a mailbox, with the direction in the additional data. Only the two key holders can produce or read it, which authenticates the sender without a signature per message. The last 400 op ids per contact are remembered, so a relay can't replay an old edit.
- **Offline delivery:** servers keep **mailboxes** on `/dm`. A mailbox is filed under the hash of its owner's signing key and handed only to a socket that signs the server's nonce with that key, so there's nothing to register and nothing to squat. Senders leave sealed blobs there: at once when the friend is offline, and after 8 s when a direct connection doesn't come up, which also covers strict NATs (D28 had no answer for those). Mail is deleted when collected, after 30 days, or when the mailbox is full (500 blobs, 8 MB). It's stored in `data/mail.json`, not in `state.json`.
- **Outside shared servers:** a **friend code** carries a card and the addresses of the owner's bookmarked servers (their relays); `hello` and every mailed op keep that list current. A client connects to a contact's relays as a **guest**: no password, no member list, no mailbox of its own, and presence only for profile ids it names. Guests can signal and leave mail for people whose id or address they already hold. A guest can't use the profile id of one of the server's stored profiles. `DM_GUESTS=off` turns guests away.
- **Images:** the message carries a small thumbnail per image, so it fits in a mailbox like any other op. The image stays on the sender's device and is pulled over the sealed data channel when both are online (16 KB chunks, `bufferedAmount` backpressure), then stored in IndexedDB (`dmFiles`). Png, jpeg, gif and webp, 10 MB each, 4 per message. Nothing needs a transfer outbox: the receiver keeps a list of what it lacks and asks again on the next connection.
- **Old apps:** a peer that shows no card is answered in plain, as before, unless a key is already pinned for that profile. Old servers have no `challenge`, so there are no mailboxes there and delivery works as in D28.

**Consequences:**
- The host of a relay sees who leaves mail for whom, when, and how big it is (the sender's card is on the blob), but never the content. It can drop or delay mail.
- The keys are long-lived and there is no ratchet: someone who steals a profile's keys (or an exported profile file, which contains them) can read mail they recorded earlier. No forward secrecy.
- The first card seen is trusted. A server could hand out a wrong card for a member you have never talked to; a friend code swapped out of band avoids that. Chat on servers is unchanged: profile ids there are still spoofable (D3), and `card` in a server profile is only as trustworthy as that server.
- Presence and signaling are still by profile id, so someone can still *appear* as a friend or knock their `/dm` socket off (newest wins). They can't read or write that friend's DMs.
- A friend code tells its holder which servers you use, and makes the app open a socket to each of a contact's relays (at most 8 guest relays in total). A server with a self-signed certificate that isn't pinned yet fails silently there (D20), as for bookmarked servers.
- By default a password-protected server accepts sealed DM traffic from people without the password. They can't see or join anything; the caps above bound what they can store.
- **One device at a time.** An exported profile carries its keys, so the same identity works on a second device, but the two don't sync: mail goes to whichever device collects it first, history stays where it was received, and `/dm` still lets only the newest socket per profile stay connected. Real multi-device needs per-device mailbox cursors and a way to send your own messages to your other devices.
- An image is only fetched while both are online, and it's gone for good if the sender deleted the conversation first (the thumbnail stays, marked "no longer available").

**Alternatives:** a DHT or public WebRTC trackers for discovery (third-party infrastructure the project would depend on, and no offline delivery without storing data on strangers' machines); mutual friends' clients as relays and mailboxes (no server change, but it only works while a mutual friend is online and every client would have to hold connections to all its contacts); the profile id becoming the key hash (cleaner, but it would rename every profile and break history and bans); a Signal-style double ratchet (forward secrecy, at the cost of per-message state that an op queue with resends and two delivery paths makes fragile); images through the mailbox (works offline, but megabytes of other people's data on a host's disk); mailbox cursors per device instead of delete-on-collect (the first step to multi-device, costing storage for the whole retention period).

## D33: Calls in DMs are signaled over the DM link and reuse the voice-channel media code · Active
**Context:** Friends wanted to call each other from a conversation, with camera and screen sharing, without meeting in a server's voice channel.
**Decision:**
- A call is between the two people in a DM, one call at a time. Ringing and the WebRTC handshake travel over the DM data channel (D28) as `{ t: 'call', d }`, sealed end to end like messages (D32) and only accepted from a friend whose key is known. The server isn't involved beyond the DM rendezvous, and there are no server changes.
- The media uses its own peer connection, not the DM one. The DM connection never renegotiates and is dropped and rebuilt freely; a call adds and removes tracks all the time.
- That connection is driven by the existing `VoiceClient`, through an adapter that looks like the chat socket. Mute, push-to-talk, the soundboard, cameras, screen shares, codec preferences and per-viewer encoder sizing are shared with voice channels (D5, D22) instead of written twice.
- With one viewer there is nothing to save by opting in, so each side receives whatever the other shares.
- A call and a voice channel don't run together: there is one microphone graph (D31). Starting or accepting a call leaves the voice channel, and joining a voice channel hangs up.
- The call view lives in the conversation. Elsewhere in the app the call goes on, with a panel in the sidebar; the video is paused for you until you come back.
- Results are written into the thread as local-only notes ("Call · 4:05", "Missed call"), each side writing its own.

**Consequences:**
- Calls inherit the DM link's limits: both people online, reachable through a shared bookmarked server, no TURN (D5), and the caller is as certain as the sender of a message is (D32). A friend on an app without keys can't be called.
- An app from before calls ignores the ring, so the caller hears ringing and then "didn't answer".
- If the DM link drops mid-call, the media usually keeps flowing. Signals (camera on, a new share) wait in a queue until the link is back. The call ends after 20 s without media.
- You can't be called while offline, and a call that rang while your app was closed leaves no trace on your side.
- No group calls: that's what voice channels are for.

**Alternatives:** renegotiating media onto the DM peer connection (one connection, but DM reconnects would kill calls and its negotiation is deliberately one-shot); relaying call signaling through `/dm` on the server (works without the data channel, but adds server protocol and lets the server see and forge the handshake, which sealing now rules out); a temporary private voice channel on a shared server (reuses everything, but ties a call to one server and shows it to the host).

## D34: Tiers, modes and a per-viewer ladder; the codec is chosen per machine and mode · Active
**Context:** GitHub issue #11 reported low frame rate and bitrate on screen shares. D22 asked for up to 4K120 with one fixed codec order and sized each viewer only from its display size. Discord-style apps differ in four ways: fixed quality tiers, fitting resolution and frame rate to the available bitrate, separate settings for motion and for text, and a codec picked for the machine.
**Decision:**
- Screen shares have a **tier** (`TIERS`: `auto`, `720p30`, `1080p60`, `1440p60`). `auto`, the default, tops out at 2560×1440 at 60 fps, and no tier goes higher: the first version had a `source` tier (4K at 120 fps), removed after the real share below, where a 120 fps track delivered 30–57 fps. A saved `source` setting falls back to `auto`. The tier is set in the share picker, changeable while live, saved in `settings.shareTier`, and enforced both in the capture constraints and as an encoder ceiling.
- A **mode** (`MODES`, `settings.shareMode`): `smooth` (`contentHint = 'motion'`, `maintain-framerate`) and `sharp` (`detail`, `maintain-resolution`, 30 fps cap). Cameras are always `smooth` with their previous ceiling.
- Per viewer, a **ladder** of rungs (height, fps), moved once a second from the sender's own stats. `smooth` lowers resolution first and `sharp` lowers frame rate first. It steps down when the target bitrate doesn't cover the rung (`DOWN_FIT`) and the encoder is really using its budget (`USING_BUDGET`), or when the encoder is overloaded (`LOAD_FPS`). It steps up on bitrate headroom (`UP_HEADROOM`) or when the stream is application-limited (`APP_LIMITED`). `maxBitrate` stays at the ceiling's value so the bandwidth estimate can grow. A new viewer starts on the lowest rung until its first target sample. The constants sit at the top of the ladder block in `voice.js`.
- `evenScale` nudges `scaleResolutionDownBy` so the encoded width and height are both even.
- The codec is **probed**, not fixed: `mediaCapabilities.encodingInfo({ type: 'webrtc' })` per size bucket when a share starts or its quality changes. `smooth` prefers hardware codecs (H.264 High, H.264, AV1, H.265, VP9), then software ones, software H.264 last. `sharp` prefers AV1 when smooth, then hardware H.264/H.265, then VP9. D22's fixed order is the fallback until a probe resolves. A live mode switch changes `encodings[0].codec` through `setParameters`, with no renegotiation. A runtime guard overrules the probe, per kind, when H.264 turns out to be software. Each rung's bitrate need is scaled per codec (`CODEC_EFFICIENCY`, starting values, not measured); the ceiling is not.
- `VoiceClient` samples its own senders once a second while it sends any media, and a "Stream stats" panel (stage header readout) shows sender and receiver numbers, with a Copy button for the last 60 samples.
- Signaling is unchanged. Everything is sender-side, so old and new clients interoperate.

**Consequences:**
- Measured, on one Apple-silicon Mac over loopback: Chromium's hardware H.264 encoder (VideoToolbox) fell back to software OpenH264 whenever the encoded width or height was odd, at any size (853×480, 1707×960 and 1671×940 were software; 640×360, 1280×720, 1600×900, 1920×1080 and 2560×1440 were hardware). This was in Chrome 154 with a fake display source. It was not tested with a real display source, nor on Windows or Linux. Before D34 the per-viewer scale came straight from the viewer's display size, so odd sizes were common. This is the most likely explanation found so far for the low frame rate and bitrate in #11, but it is **not confirmed on a real share**.
- Measured on the same machine: with low-entropy content the bandwidth estimate did not grow while the encoder was application-limited (about 1.6 Mbps available with 0.27 Mbps sent). That is why the ladder treats application-limited streams as free to climb.
- Measured: `mediaCapabilities` for `type: 'webrtc'` accepts RTP mime types with fmtp parameters and rejects MSE-style strings, and a bare `video/H264` is judged as baseline. Hence the per-profile H.264 probes. `degradationPreference` and `encodings[0].codec` are accepted by Electron 44 (Chromium 152).
- Measured: lowering the tier on a live share did not shrink a fake display capture (`applyConstraints` raised size and changed fps but did not lower size). The encoder ceiling still applied, which is why the tier is enforced in both places.
- Measured on a real share (2026-10-02, one viewer on a Mac, same LAN, receiver-side stats only): every received size was even (640×360 up to 2162×1216) and decoded in hardware, with no loss, NACKs or PLIs. The stream took 25 s to reach the viewer's full size, and sat at 720p for 12 s while receiving 6–15 Mbps. The frames arrived at about 35 fps while the rung timing matched a 120 fps ladder (`source` tier), so each rung was costed at about 3.4 times what it needed. Rungs are now costed at the source's real frame rate (`NEED_MIN_FPS`, `SRC_FPS_DECAY`); replaying the same bitrates reaches the top rung in 7 s. The viewer also saw four short freezes (0.9 s in total) and a 100–150 ms jitter buffer on a 3 ms path.
- Measured on the sender of that share (Windows, NVIDIA, a 2560×1440 monitor, `source` tier, `smooth`): H.264 was hardware encoded (`MediaFoundationVideoEncodeAccelerator`, NVIDIA MFT) at 2162×1216, never limited by CPU or bandwidth, with the target at its 18.8 Mbps ceiling and 23–41 Mbps available. The capture was the limit: the track reported 120 fps but delivered about 50 fps on a still screen and 28–33 fps in motion, dipping to 18–24 fps. The encoder sent every frame it was given. This fits Chromium's desktop capturer, which spends at most half its time capturing (`kDefaultMaximumCpuConsumptionPercentage = 50` in `desktop_capture_device.cc`): 10 ms per capture gives 50 fps and 16 ms gives 32 fps. The dips line up with jumps in encode time and in the viewer's jitter, so the freezes most likely start at the capture too. Chromium 152 has a texture path for Windows Graphics Capture (`WebRtcAllowWgcUsingTexture`, screens on Windows 11 24H2 or later) and `ZeroCopyDesktopCapture`.
- Measured on the same sender a few minutes later, taken to be launched with `--enable-features=WebRtcAllowWgcUsingTexture,ZeroCopyDesktopCapture` (the dump does not record the launch flags): the capture delivered 53–58 fps in motion instead of 28–33, and encode time fell from 13–16 ms to 5–8 ms a frame at 360p–720p (11 ms at 1080p). The desktop app now sets both features on Windows (`desktop/main.js`; `FRIENDSPEAK_LEGACY_CAPTURE=1` turns them off). One machine, one run: which of the two features did it is not known, the run ended on the 1080p rung so the top rung was not compared, and neither a machine with two GPUs (another Electron project reports the texture path breaks there) nor AMD or Intel was tried.
- Not exercised: the desktop app's own screen picker with a real screen (macOS refused screen-recording permission to the dev Electron), a real bandwidth-limited or CPU-bound link (the ladder was driven with synthetic samples), Windows and Linux encoders, runs with several viewers, and DM calls with video. The ladder constants and `CODEC_EFFICIENCY` are untuned starting values.
- Screen shares are capped at 1440p60 instead of D22's 4K120, with no way to ask for more. Cameras keep D22's ceiling.
- Because the sender alone decides, a mixed-version call still works; older senders just keep D22's behaviour.

**Still open (issue #11, phase 3):** Electron background/occlusion switches, a start-bitrate floor, and an upload budget across viewers. All wait for measurements with real shares. An SFU for more than about 3–4 viewers stays a gated later step. It would need its own decision as an exception to D2, D5 and rule 4 in AGENTS.md.

**Alternatives:** keeping D22's fixed ceiling and codec order (the status quo, and what #11 complained about); fixed quality presets only, with no ladder (simple, but a viewer on a thin link or a loaded encoder gets a stalled stream); fitting by bitrate alone without a mode (can't tell text from motion); an SFU now (fixes upload for many viewers, but puts media through the server and needs UDP ports).
