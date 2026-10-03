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

## D3: No accounts, client-owned identity · Active (spoofable ids superseded by D42; "anyone can manage" superseded by D43)
**Context:** the core requirement is "saved profiles with no signup anywhere".
**Decision:**
- A profile (uuid, name, color, avatar, status) is created and stored in the client, and it can be exported/imported.
- Servers trust the profile id they're sent.
- Access control is at most one shared server password.
- Anyone connected can manage channels and emojis. Only the author can edit or delete a message.

**Consequences:** zero friction. Identity is **spoofable**: anyone who knows your profile id could post as you. Fine for friends, not for public servers. Message history stores `author` (profile id) plus a name snapshot. Avatars live in `state.profiles` so history renders with current avatars.
**Alternatives:** keypair identities (sign `hello` with a local key), which is the natural upgrade path if spoofing matters. Direct messages took that path (D32), and servers followed (D42): a server now pins the key that first says hello as a profile id. Still no accounts.

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
- _Superseded by D36 (screen shares only; cameras still follow this):_ the capture asks for up to 4K at 120 fps (cameras default to 1080p60, same ceiling), with `contentHint = 'motion'`.
- _Superseded by D36 (the order is now probed per machine and mode; this one is the fallback):_ codec preference is H.264 High → H.264 → VP9 → AV1 → VP8 → H.265. A mesh runs one encoder per viewer, and H.264 is hardware-encoded almost everywhere (VideoToolbox, Quick Sync, NVENC, AMF). Negotiation falls through when a viewer can't decode one. Measured on an M4 Pro in Chrome 154: the default VP8 ran in software and dropped to 960×540, while H.264 used VideoToolbox at 1440p–4K and 120 fps. H.265 comes last because Chrome's WebRTC support for it is new and hardware-only, and H.264 already has hardware on the same machines.
- Each viewer reports how many device pixels it displays (`{ view }`, sent on resize and when its window is hidden). The sender sets `scaleResolutionDownBy`, `maxBitrate` (≈0.06 bits/pixel, capped at 50 Mbps) and `active` per viewer, so thumbnails and minimized windows cost almost nothing.
- No `x-google-start-bitrate` SDP munging. It was tried: with a mid-call share, starting the estimate at 8 Mbps made it collapse to its ~0.05 Mbps floor on both H.264 and H.265, while the default ramp reached the cap in about 9 s.

**Consequences:**
- Upload cost scales with the number of viewers, not the channel size. The server is still only a signaling relay.
- A viewer can watch several shares at once (the grid). Each costs its sender one encoder and one upload, sized to that viewer's tile.
- The sharer's upload is still roughly the sum of each viewer's stream, and a 4K120 share can use tens of Mbps per viewer on a good link. The per-viewer sizing above is the main mitigation (D36 now caps the default at 1440p60 and adds a ladder). Fixing that properly needs an SFU (encode once, the server forwards), which would put media through the server and need UDP ports (against rule 4 and D5).
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

## D26: The client ships only in the desktop app; the server hosts no UI · Active (amended by D34: the admin dashboard at /admin)
**Context:** every server also served `public/` over HTTP, so the client existed in two places (browsers and the desktop app). The browser route only gets a microphone on https or localhost (D7), and it blurred the line between hosting and using.
**Decision:** the server serves only the server: Socket.IO, the HTTP APIs (`/api/info`, `/api/files`, `/files`), and the game (`/game`, `/assets`, the worlds). `/` returns a plain-text notice, the emoji vendor routes are gone, and Socket.IO runs with `serveClient: false`. The client in `public/` is loaded only by the desktop app from `friendspeak://app` (D10), which bundles the emoji picker and `socket.io.js` itself. The Docker image no longer contains `public/`.
**Consequences:** everyone, including the host, needs the desktop app. D7's browser routes (localhost UI, self-signed HTTPS in a browser) no longer apply; the app is always a secure context. The game client is still served by the server, because its assets live there and it runs in an iframe from the server's origin (D15).
**Alternatives:** keeping the web client as an option (two supported surfaces, and the mic caveats of D7).

## D27: The offline list, removals and bans follow the "friends" trust model · Active (DMs superseded by D28; who may remove and ban by D43)
**Context:** friends asked for Discord-style direct messages, to see people who aren't online, and to keep someone out of the server. There are no accounts and profile ids are spoofable (D3), and every profile id is visible to everyone in `users` and `profiles`.
**Decision:**
- ~~**DMs** were threads in `state.dms`, relayed and stored by the server.~~ Replaced by peer-to-peer DMs (D28); old `state.dms` data is dropped on load.
- **Offline list:** every profile in `state.profiles` that isn't online or banned. Profiles now store `status` and `seen`.
- **Remove from server** (`member:remove`) disconnects someone and deletes their stored profile, so they leave the member list. It's a kick, not a ban: they can reconnect and reappear. Their old messages keep their name snapshot.
- **Bans** match the profile id and, optionally, the IP it last connected from (kept in memory only, and never sent to clients). The IP part is skipped when it's loopback or the same as the banner's IP, so a host behind a reverse proxy or friends on one LAN don't ban themselves. Anyone connected can ban or unban anyone, except themselves.

**Consequences:** a banned friend can come back with a new profile, and with an IP ban from another network. Someone malicious could ban everyone else. The host can then edit `bans` in `state.json`. Behind a reverse proxy every socket has the proxy's IP, so IP bans never apply there (the self-ban guard skips them).
**Alternatives:** end-to-end encrypted DMs and signed identities (keypairs, the D3 upgrade path); an admin role (needs identities that can't be spoofed first).

## D28: Direct messages are peer to peer, and servers are only meeting points · Active (encryption, offline delivery, images and reach extended by D32; outages by D39)
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
- **Server:** `updater.js` does the detection, scheduling (`MAINTENANCE_CRON`, a dependency-free 5-field cron), warnings (`server:update`) and the trigger. The swap itself is done by a Watchtower sidecar (the maintained `nickfedor/watchtower` fork) in HTTP-API-only mode, limited by label to the friendspeak container. The friendspeak container keeps its read-only filesystem and dropped capabilities: only the sidecar has the Docker socket. `AUTO_UPDATE=on` is Docker-only, and `npm start` hosts get at most `notify`. Watchtower is opt-in (compose profile `autoupdate`). Without it, the server runs normally and only announces updates, and it schedules a window only after Watchtower answers. The mode and the window are not environment-only: an admin can set them in the dashboard (D34).

**Consequences:** while the repo is private, servers need `GITHUB_TOKEN` (and Watchtower `GHCR_USER`/`GHCR_TOKEN`), and installed apps can't see releases at all: in-app updates start working when the repo goes public. Releases use GitHub Actions minutes, and macOS minutes count 10× on private repos. Watchtower recreates the container from the same config, so compose changes (new env vars) still need a stack redeploy. A server and its clients can briefly run different versions, which the protocol has to tolerate (add fields; don't repurpose them). An admin can also start the install from the dashboard (D34), with a two-minute warning, through the same Watchtower call; the container still never touches Docker.
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
- The first card seen is trusted. A server could hand out a wrong card for a member you have never talked to; a friend code swapped out of band avoids that. Chat on servers was unchanged at first: profile ids there were still spoofable (D3). D42 fixed that: a server profile's `card` is now one whose key proved itself to that server, though still only as trustworthy as the server.
- Presence and signaling are still by profile id, so someone can still *appear* as a friend or knock their `/dm` socket off (newest wins). They can't read or write that friend's DMs. (D42 closes this for profile ids with a key pinned on that server.)
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

## D34: The server hosts an admin dashboard at /admin, gated by admin keys · Active (roles as labels superseded by D43)
**Context:** hosts want to see health and logs (and, later, manage users) without shell access to the machine. D26 said the server has no UI. The dashboard shows IPs and the server log, so whoever can open it effectively controls the server. Profile ids are spoofable (D3), so admin rights can't hang on a profile.
**Decision:**
- **Where:** a web UI at `/admin` on the one port (D2). It is plain ES modules with no build step (D1), in `admin-ui/`, not `public/`, because `public/` ships only in the desktop app (D26). The one shared file is `public/js/util.js`, served as `/admin/js/util.js`. Every `/admin` response carries a strict CSP (`default-src 'self'`, no inline scripts or styles), `X-Frame-Options: DENY`, `nosniff`, `no-referrer` and `no-store`.
- **Local rule:** a request needs no key when the peer is loopback, the `Host` is `localhost`, `127.0.0.1` or `[::1]`, and there are no proxy headers (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`). `ADMIN_LOCAL=off` switches the rule off. The Docker image sets it off, because inside a container loopback is never the admin's own machine.
- **Admin keys:** generated by the server (`fsa_` plus 32 random bytes) and stored only as SHA-256 hashes in `DATA_DIR/admin.json`. On first boot, if no key exists, one is generated and printed once to stdout, outside the log buffer the dashboard shows. `ADMIN_KEY` (16+ characters) sets a key from the environment instead and deactivates the first-boot key. There can be several named keys, so one admin can be revoked without rotating the rest. Keys are separate from `PASSWORD`.
- **TLS:** a key is only accepted over TLS (directly, or `X-Forwarded-Proto: https` from a proxy), or on a direct loopback connection where it never leaves the machine.
- **Sessions:** an opaque random token, kept in memory as its hash. The cookie is `fs_admin`, `HttpOnly; SameSite=Strict`, `Secure` on TLS, scoped to `/admin`. A session lasts 12 h in total and 1 h idle. An open event stream counts as activity, and the 12 h limit still applies. Revoking a key ends its sessions at once.
- **API:** REST under `/admin/api`, plus one Server-Sent Events stream for the live log and "something changed" hints. Not a Socket.IO namespace.
- **CSRF and cross-site:** the API refuses any request whose `Sec-Fetch-Site` is `cross-site` or `same-site`. State-changing requests need `Content-Type: application/json` and an `Origin` whose host equals `Host`. This applies to local requests too, so a web page open in the host's browser can't drive the dashboard. There is no CORS on `/admin`.
- **Rate limit:** per IP, five free failed sign-ins, then a growing lockout (30 s doubling, up to 1 h). More than 100 failures in 10 minutes from anywhere also adds a 60 s global lock, which applies only to addresses that already have a failure on record. A lockout never covers a clean address, or anyone could keep the real admin out.
- **Audit log:** `DATA_DIR/admin-audit.log`, one JSON line per sign-in, failed sign-in, sign-out and key change, rotated at 5 MB. Shown in the dashboard.
- **Log capture:** `logbuffer.js` wraps the `console` methods and keeps the last 2000 lines in memory. It records what the server itself prints, which is what `docker logs` shows. It does not read from the Docker daemon.
- **Off switch:** `ADMIN=off` doesn't mount `/admin` at all.
- **Users:** the Users view lists who is online (with IP, connected since and what they are doing), offline profiles (last seen, last IP) and bans (with the real IP). It can remove a member, ban (optionally with their IP) and unban. These call the same `actions` in `server.js` as the app's `ban:add`, `member:remove` and `ban:remove`, so there is one set of rules. `users` entries carry `since` and `ip`, which are never sent to clients.
- **Roles:** the Roles view creates, renames, recolors, reorders and deletes roles (name and color) and assigns them to profiles. They are stored in `state.json` as `roles` and `memberRoles` (profile id to role ids), beside `profiles`. Limits: 50 roles, names of 1 to 32 characters (unique, case-insensitive), `#rrggbb` colors, 10 roles per profile. The app gets them in the `hello` ack and a `roles` event, and shows them as tags next to names. Both fields are optional, so old apps and old servers still work (D29).
- **Server views:** Channels (messages, files and voice occupants), Storage (usage by channel, the largest files, the data folder), Penguin game (availability, players) and Server settings (name, icon, game on or off, through the same `actions.updateServer` as the app) round out the server side. Channels and storage are read-only by choice: channels and files are managed in the app, where everyone can already do it (D3, D24).
- **Update now:** the Updates view shows the version, last check and whether Watchtower answers, and can check now or install. **Update now** probes Watchtower, schedules the install two minutes out and broadcasts the usual `server:update`, so everyone gets the existing warning. It can be cancelled during the countdown. It works whenever the Docker image has the Watchtower sidecar and its token, including with `AUTO_UPDATE=notify`, and never outside Docker. Without the sidecar the page shows the manual steps.
- **Update settings:** the Updates view can set the update mode (`off`, `notify`, `on`) and the maintenance window (cron, with a preview of the next runs) at runtime, with no restart. A value set there overrides `AUTO_UPDATE` / `MAINTENANCE_CRON` and is saved in `state.json` as `updateSettings` (never sent to clients), so it survives restarts and updates. Reset removes the override. `on` still needs the Docker image and `WATCHTOWER_TOKEN`, or the effective mode is `notify`.
- **Scope:** everything the issue asked for exists: overview, server log, users, bans, roles, channels, storage, game, updates, server settings, admin keys and the audit log.

**Consequences:**
- With `ADMIN_LOCAL` on (the default for `npm start`), anyone on the host machine, any local process or user, is an admin.
- Sessions live in memory, so they end on every restart, including after an update. Admins sign in again.
- The dashboard shares an origin with the game client and `/files`. Files are served with a sandbox CSP and the game is our own vendored code, but a script-injection bug in the game page would reach the admin API of a signed-in admin.
- Behind a reverse proxy every request has the proxy's address. Login lockouts are then shared by everyone, and the audit log shows the proxy's IP. Forwarded headers are never trusted, as with D27's IP bans, so rate-limit at the proxy, or put Cloudflare Access or Tailscale in front. The proxy must pass the original `Host` header, or the `Origin` check refuses every change.
- With `HTTPS=1` the browser shows a certificate warning, because there is no pin like the desktop app's (D20). The fingerprint is on the login page and in the server log, to compare.
- The log buffer is memory only (2000 lines) and starts empty after a restart.
- Once the mode or window is set in the dashboard, changing `AUTO_UPDATE` or `MAINTENANCE_CRON` in the compose file has no effect until it is reset there. The Updates page shows both the environment value and the active one, so this is visible.
- The in-app management actions (ban, remove, channels, emojis, files) are unchanged and still open to everyone (D3, D27), including the ban and remove the dashboard also offers. The dashboard adds a gated view of the server. It is not a permission system.
- Roles are labels only and enforce nothing. They attach to profile ids. Since D42 a profile id with a pinned key can't be copied, so a role is held by whoever holds that key; profile ids without a key (apps from before D42) can still be copied. Granting permissions through roles is now possible, but it is a separate decision.
- Assignments live in `memberRoles` and are dropped when a member is removed. Only the dashboard can change roles and assignments. It is the one management action that is not open to everyone in the app.

**Alternatives:** an admin panel inside the desktop app (it already has the pinned certificate and the socket, and no browser attack surface, but it isn't a web UI and needs the app installed); signed stateless session cookies (they survive restarts, but revoking a key couldn't end them at once); admin rights on a profile id (spoofable, D3) or on a DM keypair identity (D32; possible later, but servers still trust profile ids today); a Socket.IO namespace for the dashboard (a second auth path, and the client library to serve); reading container logs from the Docker socket (root on the host; `updater.js` leaves that to the Watchtower sidecar, D29); trusting `X-Forwarded-For`.

## D35: Mic processing: RNNoise in a worklet, a noise gate of our own, the browser's echo canceller · Superseded by D38
**Context:** voice relied on the browser's `echoCancellation` and `noiseSuppression` constraints alone (issue #21). Keyboards, fans and room noise came through, and friends on speakers echoed. Measured in the app on a recording of speech over fan noise and key clicks (speech at −20 dBFS, noise at −38 dBFS): the browser's suppression leaves the noise-only stretches at −51 dB, RNNoise at −68 to −71 dB, with the speech level unchanged. RNNoise adds 21 ms of delay and costs about 0.7% of one core.
**Decision:**
- **Noise reduction has levels**, not a checkbox: off, standard (the browser's), high (RNNoise). High is the default. With RNNoise in the graph the browser's suppression is switched off.
- **RNNoise** over DeepFilterNet: 150 KB of wasm, under 1% CPU and a fixed 10 ms frame. DeepFilterNet is a much larger model that the issue itself calls heavier; it was not measured here. The budget is a laptop that is also running a game or a screen share.
- **Vendored prebuilt**, not an npm dependency: `public/vendor/web-noise-suppressor/` holds the worklet and wasm from `@sapphi-red/web-noise-suppressor`, unchanged, because the client has no build step (D1) and ships only in the desktop app (D26). The server image doesn't get a dependency it never uses.
- **The audio graph runs at 48 kHz**, the only rate RNNoise works at, instead of resampling inside the worklet. Chromium resamples at the device, and WebRTC sends 48 kHz anyway.
- **The noise gate is ours** (`mic-worklet.js`), on the audio thread: manual threshold or automatic (a margin above the tracked noise floor), shown in Settings as a level bar with the threshold on it. It sits after RNNoise, so in High the gate sees an already quiet signal. Off by default: a gate clips quiet word endings, and High already silences most rooms.
- **Echo stays with Chromium's canceller.** Since voices moved into the graph (the per-user volume work), everything the app plays except screen share audio already leaves through one `AudioContext` on the chosen output device, which is the single reference the issue asked for. On top of that: Settings shows when the device or OS didn't apply a constraint, automatic gain control is a setting, and **speaker mode** (off by default) ducks the mic 18 dB while the app plays sound, a half-duplex fallback for people on speakers.

**Consequences:**
- High can thin out sounds that aren't speech: music, laughter, a clap. That is the trade for removing keyboards; Standard and Off are one select away. Soundboard clips don't pass through it.
- A saved "noise suppression off" from before carries over as Off; everyone else moves to High.
- On a 44.1 kHz device the browser resamples the whole graph. If a browser refuses a 48 kHz context, High quietly becomes Standard, and Settings says so.
- Speaker mode makes talking over each other one-sided, and screen share audio doesn't trigger it.
- The echo work here is not measured on real speakers and microphones (it can't be with fake devices): which setups still echo, and whether a non-default output device weakens the canceller, is still open. Chromium also offers `echoCancellation: 'all'` (cancel everything the system plays, not only the app), which is untried.
- The fake-mic test recipe needs `--disable-features=AudioServiceSandbox` for `--use-file-for-fake-audio-capture`, or the mic is silent (AGENTS.md).

**Alternatives:** DeepFilterNet (reportedly better on hard noise, but heavier); `@jitsi/rnnoise-wasm` with a worklet of our own (more code to own for the same model); an npm dependency served from `node_modules` like the emoji picker (puts client-only code in the server image); resampling in the worklet (keeps the device rate, adds delay and code); the gate on the main thread from the existing analyser (timer jitter, and throttled in a hidden window); a full acoustic echo canceller of our own in WASM (a large job that duplicates Chromium's, without access to its playout timing).

## D36: Tiers, modes and a per-viewer ladder; the codec is chosen per machine and mode · Active
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

## D37: Camera backgrounds are made on the sender's device, with MediaPipe · Active
**Context:** People wanted to hide the room behind them on camera, with a blur or a picture, and to see how they look before anyone else does.
**Decision:**
- The effect runs in the sender's app, before the camera reaches a peer connection (`background.js`). Viewers get an ordinary video track, so the mesh (D5, D22), DM calls (D33), the socket protocol and the server don't change, and older apps see the effect without knowing about it.
- People are found with MediaPipe Tasks Vision (`@mediapipe/tasks-vision`, Apache 2.0) and its selfie segmentation model (250 KB, committed in `public/models/`). The library is WebAssembly plus a prebuilt ES module, so it loads as-is from `node_modules` through the `friendspeak://` routes like the emoji picker: no build step (D1), nothing native. It loads on first use, and nothing is fetched from the internet.
- Frames come from the camera track (`MediaStreamTrackProcessor`), are composited on a canvas, and leave through a `MediaStreamTrackGenerator`. They don't depend on `requestAnimationFrame`, so the effect keeps running while the window is hidden.
- The compositor is the same for every background: the person from the mask, then a painter for whatever goes behind them. `BACKGROUNDS` in `background.js` lists the painters: `blur` (with a strength) and `image` (a picture scaled to cover the frame). A picture is cut out with a tighter mask than a blur, because a rim of the real room shows against a picture and not against its own blur.
- Pictures are either presets or your own. The presets are gradients drawn in code, so the app ships no image files. Your own are kept on the device in IndexedDB, scaled down to 1920×1080 JPEG when added, and are never uploaded: only the composited video leaves the machine.
- The camera never goes on unseen: turning it on opens a preview dialog first, every time, with the background choices. Nothing is sent until it is confirmed. The same dialog, opened while the camera is on, changes the live camera.
- A camera with a background is captured at 720p30 instead of the plain camera's size, because segmenting and compositing run on the UI thread for every frame.
- Switching between a background and none mid-call opens a new capture and swaps it in with `replaceMedia`, so viewers keep the same stream. Every other change (strength, picture, blur ↔ picture) applies to the running camera at once.
- If the effect can't start, the camera comes on without it and a toast says why.

**Consequences:**
- The desktop installers grow by about 12 MB (one WebAssembly build; the no-SIMD and module variants are excluded in `package.json` → `build.files`). The server image doesn't carry the package (`Dockerfile`).
- The first camera with a background takes a few seconds to appear while the WebAssembly compiles. After that the segmenter stays loaded until the app closes.
- The mask is 256 px wide and has no memory between frames: edges around hair and fast hands are rough, more visibly against a picture than against a blur. A blur shows a faint halo of the person's own colors.
- It costs CPU and GPU on the sender only. On a machine without WebGL the segmenter falls back to the CPU and may not hold 30 fps.
- Only people are kept: a pet or something you hold up away from your body may be hidden.
- Turning the camera on takes two clicks. The caller of a DM video call gets the dialog when the call connects, so their camera isn't on until they confirm.
- Your own pictures don't travel with a profile export, and are shared by every profile on the device.
- The viewer sees a picture the right way round; your own preview is mirrored, so text in it reads backwards to you only.

**Alternatives:** the same pipeline in a worker (keeps the UI thread free, but MediaPipe's loader uses `importScripts`, which module workers don't have, and a classic worker can't import the ES bundle without a build step); compositing in WebGL on MediaPipe's own context (no mask readback, but far more code for a 256 px mask); TensorFlow.js body-segmentation (wraps the same model with a bigger runtime); ONNX Runtime Web with MODNet or Robust Video Matting (cleaner edges, models of tens of MB and much more GPU); the operating system's effects (macOS Portrait, Windows Studio Effects: free where present, but hardware-dependent and missing on Linux); blurring on the viewer's side (the room would still leave the sender's machine); shipping stock photos as presets (licensing, and megabytes in every installer); a "don't show the preview again" switch (not asked for; the dialog is also where the background is chosen).

## D38: The mic is sent as captured, as the best Opus there is; servers can set a lower bitrate · Active (mic processing amended by D44; noise suppression replaced by D47)
**Context:** D35's processing (RNNoise, a noise gate, speaker mode, the browser's echo canceller and automatic gain) gave people many options and changed how they sounded in ways they didn't ask for (issue #44). Toggling noise reduction during a call was also reported to crash the app (#43). Voice used WebRTC's default Opus: mono, about 32 kbps, so soundboard clips and music sounded flat (#45). And the old "Test mic" only showed a level: you couldn't hear yourself, and not at all during a call (#48).
**Decision:**
- **One mic option:** the browser's (WebRTC's) noise suppression, on by default. Echo cancellation and automatic gain are explicitly off; there is no RNNoise, gate or speaker mode. `mic-worklet.js` is gone, and nothing in the app loads the vendored RNNoise files any more.
- **Opus at its best by default:** fullband stereo at 510 kbps (the codec's maximum), in-band FEC on, DTX off, VBR. It is written into both descriptions (`tuneOpus`), because a receiver's SDP decides what the sender encodes: that way an older app on either side still gets and sends it. The outgoing track is the Web Audio mix of mic and soundboard, so stereo is mostly for the soundboard; with two channels libwebrtc also uses Opus's music mode instead of its voice mode. Packets stay 20 ms.
- **A server can lower it:** Settings → Server → Voice quality (`low`, `standard`, `high`, `max`; also in the admin dashboard), stored in `state.audioQuality`. It is a `maxBitrate` cap each client puts on its own voice sender, so it changes live without renegotiating, and an old server (no field) means `max`. Like the server's name, anyone connected can change it (D3). DM calls ignore it: they are one-to-one and always `max`.
- **A real mic test:** it plays your mic back to you, silences friends' voices, your soundboard monitor and screen share audio, and keeps your mic from friends, who see you muted. It runs in or out of a call and always undoes itself (Stop, leaving the tab, closing Settings, the call ending).

**Consequences:**
- At `max`, each person uploads about 510 kbps per other person in a channel (measured 514 kbps), and downloads the same from each. A channel of 6 is about 2.5 Mbps up for everyone. Servers with big channels or slow uplinks should pick `high` (128 kbps). Libwebrtc doesn't adapt the audio bitrate to the bandwidth estimate, so this is constant while anyone speaks.
- Without echo cancellation, friends on speakers hear themselves. Headphones are now expected; Settings says so. The mic test on speakers feeds back.
- Keyboard and fan noise that the browser's suppression doesn't catch now reaches friends; RNNoise used to remove more of it.
- Friends on an older app still get their D35 processing, and send at `max` whatever the server says.
- #43 did not reproduce with fake devices (toggling Off/Standard/High eight times mid-call, before this change). The code it pointed at, rewiring the RNNoise and gate worklets, is gone; the new toggle only restarts `getUserMedia` and is tested live in voice channels and DM calls.
- SDP editing is a long-standing Chromium practice but not a standard: if a future Chromium refuses the edited description, `setLocal` falls back to the plain one (default Opus) and the call still connects.

**Alternatives:** keep D35 with fewer defaults (it was the number of automatic stages that was the problem); `setCodecPreferences` with an Opus `sdpFmtpLine` (Chromium only accepts the exact capability string, without stereo); a per-user quality setting (the sender's bitrate matters to everyone receiving it, so it belongs to the server); a lower default such as 128 kbps (no audible difference for speech, a quarter of the bandwidth, but the issue asked for the highest, and the server setting covers it).

## D39: An open DM connection is the source of truth; server presence is only a hint · Active
**Context:** when the only server two friends shared stopped (Ctrl-C, `docker stop`, a maintenance-window update), their open DM conversation stopped too (issue #55). On shutdown the server disconnects every `/dm` socket, and each disconnect sent `presence { online: false }` to the sockets still connected. Clients read "gone from every server" as "they closed the app" and closed a working data channel, then tried to mail what was queued, through the server that was going away. A hard crash sends no `presence` and the connection already survived it.
**Decision:**
- **Server:** once `close()` starts, `/dm` disconnects send no `presence`. Shutting down isn't anyone leaving.
- **Client:** `presence { online: false }` no longer closes an open connection by itself. If the friend is gone from every connected server, the app sends `{ t: 'ping', op }` over the channel and drops the connection only if nothing comes back within 4 s. The fast path for a friend who closed the app is still there; it just checks first. Apps from before this ack the ping as an op they've never seen, so the check works with them too. A channel that really closes is still caught by `dc.onclose` and the connection state, and its queue still goes to a mailbox.
- **Online** means connected directly, or reachable through a server we share. So a friend stays online (dot, calls) while the servers are down.
- **Several servers:** a server going down drops connections still being set up through it, and starts them again through another shared server. Open connections switch their `via` to a live server if there is one. A later reconnect always picks a server that's up (`via()`).

**Consequences:** a conversation that's open keeps going through a full outage of every shared server, including calls (D33). A new connection still needs a reachable server: there's no signaling without one, and no TURN (D5). An open connection can't be repaired without a server either, because the DM link is one-shot (D33). ICE restarts over the live channel would fix that and are left for later. When a friend closes the app without closing the channel (a crash), the mailbox takes over about 4 s later than before. An old server still sends `presence` on shutdown. New apps check it with the ping and keep the connection. Old apps on an old server still drop it.
**Alternatives:** ignoring `presence { online: false }` while a channel is open (no server change, but a friend who crashed would show online until the ICE consent check fails, about 30 s); telling clients the server is shutting down with a new event first (needs a protocol change and still breaks with old servers); a grace period before dropping (a timer only guesses, while the ping asks the peer).

## D40: UI size is the window's zoom, owned by a setting · Active
**Context:** issue #46 asked for a UI size control. Text size (D30) only scales `font-size`: header heights, the rail, icons and padding stay fixed, which is why that slider stops at 20px. The View menu's zoom already scaled everything, but it wasn't in Settings and the app forgot it on restart.
**Decision:**
- `settings.uiScale` is a percentage, one of `UI_SCALES` in `theme.js` (50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200: the levels a browser steps through). `applyAppearance()` applies it with `friendspeakDesktop.setZoom()`, which is `webFrame.setZoomFactor()` in the preload.
- The View menu's Zoom In, Zoom Out and Actual Size no longer use Electron's zoom roles in the app window. They send `desktop:zoom` (+1, -1 or 0) and the page steps the setting, so the slider, the menu and Ctrl/Cmd + and − always agree, and the size is kept per device like the other appearance settings. The game's pop-out window zooms like a browser.
- Text size stays: it changes reading size without changing the layout.

**Consequences:** the zoom covers the whole window, including the game iframe and video. At large sizes the window is narrower in CSS pixels, so the member list hides below 900px (the existing breakpoint) and at 200% the narrowest window is 470 CSS px wide. The client has no UI size outside the desktop app (it ships only there, D26).
**Alternatives:** CSS `zoom` on `<html>` (works in a browser too, but Chromium's CSS zoom still has edge cases with coordinates, canvases and iframes, and it would fight the menu's native zoom); a `--ui-scale` variable on every fixed size in the stylesheet (hundreds of rules to convert, and every new rule must remember it); keeping Electron's zoom roles and reading the level back (it's per origin, not persisted, and the roles have no event when they change it).

## D41: Notifications: mentions and DMs notify, server messages don't; pushed over /dm for servers not in view · Active
**Context:** issues #14 and #53. A chat with a few busy channels would be unusable if every message pinged, but missing a direct question is worse. The app only holds a chat socket to the server in view, so it can't hear about anything else.
**Decision:**
- Only DMs, incoming DM calls and mentions notify (OS notification plus a ping sound). Regular server messages keep only the unread dot. Mentions and DMs also show an unread badge even when muted.
- A mention is `@name`, `@role` or `@everyone` (names may contain spaces, longest wins, code spans ignored), or a reply to your message. The server computes it on send and stores `message.mentions`, so old messages and every client agree. Clients of an older server fall back to the same rules locally (`findMentions`).
- For servers that aren't in view, the server pushes a `mention` event over the `/dm` namespace, where the app already keeps a socket per bookmarked server (D28, D32). It goes to the mentioned profiles, the holders of mentioned roles, or the non-guest `members` room for `@everyone`, never to the author.
- **Same names and renames:** the server also stores where each mention sits (`mentions.spans`: position, length, kind, id). Clients draw it with the person's or role's current name, so renaming carries over to old messages without rewriting stored text, and older apps still see the text as written. People who share a name are told apart by a 4-character tag hashed from the profile id (`@Bob#k3f9`, `mentionTag()`, also repeated in `server.js`), shown in the member list and the `@` menu, which inserts the tagged form. An untagged shared name mentions all of them. Editing a message starts from today's names, so its mentions still resolve.
- The client decides whether to notify: master and per-type switches, muted people (anywhere) and muted servers (settings only, no server state).

**Consequences:** the matching rules exist twice (`util.js` and `server.js`, which is CommonJS); a comment on each says so. Muting is local and the sender can't tell. Mention pushes carry the first 300 characters of text to anyone whose profile id is mentioned, which is no more than they could read in the server. Old servers send no `mention` push, so background servers don't notify until they update.
Messages from before `spans` existed keep matching by text, so a rename doesn't carry over to them. Pushes aren't stored: a mention made while the app is closed only shows up as a highlighted message later. `@name` only resolves to profiles the server has seen (`state.profiles`), so someone who never visited a server can't be mentioned there.

**Alternatives:** notifying on every message with per-channel opt-out (noisy by default); a push service (needs accounts and an outside party, against D3); sending the mention over the chat socket (only open for one server at a time); matching on the client only (can't reach servers not in view).

## D42: Servers pin a key per profile id, and `hello` is signed · Active
**Context:** profile ids are made by the client and were trusted as sent (D3), so anyone who learned an id (it's in every message and member list) could post, edit and delete as that person, hold their roles, appear as them in DMs and knock them off. Since D32 every profile already has an Ed25519 key, and an exported profile file carries it. The ask: make a profile impossible to use without its exact profile file, which still has to work for switching devices or using several.
**Decision:**
- **Pinning:** a server keeps `pins` in `state.json`, profile id → Ed25519 public key, never sent to clients. The first `hello` that proves a key for an id pins it (trust on first use, like D20 and D32). Every later `hello` for that id must prove the same key, or it's refused. A state.json from before this pins, once, the key in each stored profile's self-signed card, so an update doesn't open a window for someone to claim existing profiles first.
- **Proof:** `hello` carries `proof`, a signature over `friendspeak-hello-v1|<socket id>|<host>`. The socket id is chosen by the server for this connection, so it's a fresh challenge with no extra round trip, and a proof can't be replayed on another connection. The host is the server as the app dialed it (`new URL(address).host`), checked against the `Host` header, so a malicious server can't pass on a hello its visitors signed to another server. The card in the hello must be signed by its own key. A proof that's sent and doesn't verify is refused, not treated as an old app.
- **Old apps** send no proof. They can still use a profile id that has no key pinned yet, and their card is only kept if it's validly signed. A pinned id refuses them with "Update friendspeak".
- **The card can't change during a session.** `profile:update` keeps the card checked at `hello`.
- **`/dm` (D28, D32):** a socket for a pinned id is nobody until it answers the existing `challenge` with `identify` using the pinned key. Until then it can use its mailbox, but it isn't present, its signals are dropped, it doesn't count as online, and it replaces no one (newest wins only among verified sockets). Guests can't use a pinned id without the password, as for stored profiles.
- **Several devices** use the same identity by importing the same profile file. Newest wins still applies: one chat session per profile at a time (unchanged).
- **Lost keys:** removing a member keeps the pin, because removal is open to everyone in the app (D27) and would otherwise let anyone free up someone's id and take it. The admin dashboard (D34) can **Reset key**, which drops the pin and the stored card. The next signed `hello` with that id claims it. The Users view shows the start of each pinned key.

**Consequences:**
- Copying a profile id is no longer enough. The profile file is the identity: whoever has it can be you on every server, and losing it (or deleting the profile without exporting it) loses the profile on every server that pinned it, unless an admin there resets it. The app says so in Settings → Profiles and when deleting a profile, and warns when an imported file has no keys (exports from before D32).
- Trust on first use: whoever first says hello with an id on a server owns it there. Ids are random, so in practice that's the person who made the profile. A profile that only ever connected with a pre-D32 app has no card to migrate, and the first new app to sign for it claims it. An admin can reset that.
- A reverse proxy must pass the original `Host` header (D34 already needed it for the dashboard), or every new app is refused with a message that says so. nginx's default `proxy_set_header Host $proxy_host` breaks it. Caddy and Traefik pass it by default.
- Each server pins on its own; there's no global registry, so a server you've never joined learns your key the first time you join it.
- Profile ids that only old apps use stay spoofable until their owner updates.
- No new keys: friend codes, mailboxes and DM sealing (D32) keep using the same key pairs, so nothing already stored changes.

**Alternatives:** the profile id becoming the key hash (rejected in D32 for the same reasons: it renames every profile and breaks history, bans and roles); a server-issued nonce event before `hello` (an extra round trip and a new event old servers don't send, where the socket id already is a fresh server-chosen value); keys on the server (accounts, against D3); refusing every unsigned `hello` (locks out old apps on profiles nobody can take from them anyway); trusting `X-Forwarded-Host` (a relaying server would set it to its own name); letting a removal drop the pin (anyone in the app could then take over a member's profile).

## D43: Roles carry permissions, with per-channel overrides; servers stay open until someone is an admin · Active
**Context:** issue #2. Anyone who knew the address (and password) could do everything: channels, emojis, the server's name and icon, files, removals and bans (D3, D27). Roles were labels set in the dashboard (D34). Since D42 a profile id with a pinned key can't be copied, so permissions can finally hang on a profile.
**Decision:**
- **Permissions:** `admin` (everything, ignores every other setting), `view`, `send` (message in text channels, join voice channels), `mentionRoles`, `mentionEveryone`, `kick` (remove from the server), `voiceKick`, `ban` (and unban), `forceMute`, `manageRoles`, `manageChannels`, `manageEmojis`, `manageFiles` (other people's files; your own you can always delete), `manageMessages` (delete other people's messages; your own you can always delete). The server's name, icon, voice quality and game switch, and the default permissions, are admin only.
- **Default role:** `state.defaultPerms`, every key as a boolean. It starts with `view`, `send` and both mention keys. Admins (and the dashboard) can change any of it, the admin toggle included, which makes everyone an admin.
- **Roles** keep their order (first = highest) and gain `perms`, holding only explicit settings (`true` or `false`; missing inherits), and `grantable`, the roles a holder of `manageRoles` may give out. For each key the highest held role that sets it wins, else the default. An admin role beats everything.
- **Channel overrides:** each channel may carry `overrides[roleId | 'everyone']` with `view`, `send` (join, for voice) and `manage` (rename, delete and edit its overrides; inherits from `manageChannels`). A held role's channel setting beats the everyone channel setting, which beats the server-wide result. Like Discord, a role that may see everything still doesn't see a channel whose everyone override hides it, unless that channel allows the role. Without `view` the server doesn't send the channel, its messages, typing or files, and mention pushes skip that person.
- **Moderators:** without admin, `manageRoles` only creates, edits, deletes and grants **aesthetic** roles (no permissions, nothing grantable), and only grants those in its grantable list. Only admins touch roles that carry any permission, reorder roles or edit the defaults. Nobody but an admin can kick, ban, voice-kick, force-mute or change the roles of an admin.
- **Force mute** is a server flag beside the person's own mute (`state.forceMuted`, persisted). While it is set the server reports them muted and their app keeps the mic closed, and other apps silence their audio, so a modified app isn't heard by unmodified ones. Lifting it only clears the flag and never unmutes someone who muted themselves. A force-muted person who has `forceMute` can lift their own.
- **Open until the first admin:** an updated or new server is open (`permissionsOn` false): everyone can do what they could before, and roles and permissions can only be set up in the dashboard, so nobody in the app can claim admin first. The first time someone holds a role with `admin` (or the default gets it), `permissionsOn` turns on for good.
- **Keys:** a role with any permission can only be held by a profile with a pinned key (D42). Old apps' ids are copyable, so they only get aesthetic roles, and permissions of a role an unpinned profile still holds don't count. **Reset key** in the dashboard also takes away the profile's roles that carry permissions, since whoever claims the id next may not be its owner.
- **Where:** the app's **Server settings** (Overview, Roles, Members, Emojis, Bans) replaces Settings → Server; channel overrides are under a channel's right-click **Permissions…**; roles and moderation actions are on a person's right-click menu everywhere they appear. The dashboard can do all of it regardless of permissions.
- **Version skew (D29):** every new field and event is optional. An app on an older server allows everything as before. An older app on a new server gets refusals in acks (events without an ack are silently ignored) and filtered channel lists.

**Consequences:** enforcement lives on the server, except voice: audio is peer to peer (D5), so a force-muted person with a modified app can still send audio. Unmodified receivers drop it. Hosts who never open the dashboard keep today's open server. Losing the only admin's profile file leaves the server without one until the dashboard grants it again (or resets the key, D42). A server run with `ADMIN=off` has no dashboard, so it stays open.
**Alternatives:** Discord's "allow wins" across roles (couldn't express a role that takes something away, as the issue asks); enforcing the defaults on update (locks hosts out of channel management until they find the dashboard); making the first person to connect admin (a race); separate "manage server" permission (the issue keeps server settings with admins).

## D44: The mic is sent mono at full level, with automatic gain on by default · Active
**Context:** after D38, two friends in a real call found everyone too quiet, even with both mics and each other's volume at the maximum, and heard each other mostly in the left ear with noise suppression off. Measured in the app with a fake mic playing speech on the left channel only (speech at −23.5 dBFS, peaks at −12): with no processing, Chromium delivers a two-channel track with the right channel silent, and D38 sent it like that. With noise suppression (or any processing) on, the track is mono with the channels averaged, so the voice arrived 6.3 dB quieter (−29.8 dBFS). Audio interfaces (input 1) and many headsets capture this way. D38 had also turned automatic gain off, so nothing brought a quiet mic up. Separately, the input device setting never took effect in the desktop app: Electron 44 returned the default mic for `deviceId: { ideal }` every time, while `exact` worked.
**Decision:**
- **Mono at full level:** the mic's two channels are summed (L + R, not averaged) into one before the mic volume. A one-sided raw capture is sent at its own level in both ears, and the processed mono track gets its 6 dB back. Measured after the change: −23.6 dBFS centred without processing and −23.7 with noise suppression, the same after an Opus loopback. The outgoing track stays stereo for the soundboard.
- **Automatic gain is back** as a setting (`settings.autoGain`), on by default, next to noise suppression. It is the browser's (WebRTC's) gain control. The desktop app disables `WebRtcAllowInputVolumeAdjustment`, so it only levels the signal digitally and leaves the system's mic volume alone. Measured on the same speech: −15.4 dBFS sent after 4 s, against −23.6 without it.
- **More headroom, limited:** mic volume goes to 400% (was 200%) and Voices to 200% (was 100%). One limiter sits after the mic volume and one after `voiceBus` (the same hard-knee settings the per-user limiter had), so boosting can't clip. The per-user limiter is gone: the bus one covers it.
- **Mic switching:** the device is asked for with `exact`, and the default stands in when it's unplugged. Right-click on a mute button lists the microphones, and switching restarts only the capture: the outgoing track stays, so a call doesn't renegotiate.

**Consequences:**
- A mic whose two channels are the same signal and that is sent unprocessed (both settings off) is 6 dB louder than before; the limiter keeps it from clipping, and the mic volume turns it down.
- Automatic gain is on for everyone, including people who had D38's plain mic. It can lift background noise in pauses less than a plain boost would, but it does change how a voice sounds over a sentence, which is what #44 disliked; it's one checkbox.
- The two limiters add the compressor's look-ahead (about 6 ms) to the mic and to incoming voices.
- Not measured on real devices: the fake device only shows how Chromium treats a one-sided stereo capture. Whether `WebRtcAllowInputVolumeAdjustment` still exists in Electron 44's Chromium was not checked (an unknown feature name is ignored). The camera picker also asks for its device with `ideal` and may have the same problem.

**Alternatives:** averaging the channels (keeps the 6 dB loss); detecting a silent channel and using only the live one (main-thread polling or a worklet for the same result in the common case); asking for `channelCount: 1` (Chromium's downmix then decides the level); our own compressor as the automatic gain (it raises noise in pauses, where WebRTC's gain control has a voice detector); raising the per-user maximum instead (fixes nothing for people who don't know to do it).

## D45: Shares can be captured, encoded and sent by a native sidecar, on standard WebRTC over the mesh · Active
**Context:** issue #57 asked for the fastest, best-looking streams the app can make. D36 found the limits of the browser engine's path: its screen capturer spends at most half its time capturing (28–33 fps in motion on a 1440p Windows share before two feature flags, 53–58 after), its hardware H.264 encoder falls back to software on odd frame sizes, and a mesh runs one encoder per viewer. An earlier idea (OS capture through FFI, no native binary) would still have passed every frame through JS and Chromium's encoder. The owner's scope for this change: keep the peer-to-peer mesh (no SFU), write it in Rust, make hardware encoding optional and on by default (D46), give mobile a way to *receive* streams and leave room for video calls from phones later, and keep friendspeak's own sound out of shared system audio (#49).
**Decision:**
- **A sidecar:** `friendspeak-media` (`native/`, Rust), a process the desktop app starts on first use and talks to in JSON lines on stdin/stdout (`desktop/main.js`, `native/src/proto.rs`). It captures with the OS's own APIs (ScreenCaptureKit and AVFoundation on macOS; Windows Graphics Capture and Media Foundation on Windows), encodes H.264 and sends it itself. Frames never pass through the page.
- **Standard WebRTC on the wire:** the sidecar speaks ICE, DTLS-SRTP, RTP and transport-wide congestion control through `str0m` (a sans-IO WebRTC library in Rust). No custom UDP or framing. Each viewer gets a connection of its own from the sidecar, offered `sendonly` with H.264 (Constrained Baseline and High, packetization mode 1) and, for a share with sound, Opus. The viewer's end is a plain `RTCPeerConnection`.
- **Still the mesh (D5), still opt-in per viewer (D22):** the server only relays signaling, unchanged: the new messages ride `rtc:signal` (and the DM call link, D33) as data it doesn't read. `{ watch, on, stream: 1 }` says a viewer can take a stream connection; the sharer answers `{ media, id, stream: 1 }` and `{ stream: kind, sdp | candidate }`; the viewer returns `{ viewing: kind, sdp | candidate }`. `{ view }` reports are unchanged.
- **Encoded once per layer, not once per viewer:** a stream has a ladder of rungs like D36's (`native/src/ladder.rs`; `smooth` lowers resolution first, `sharp` frame rate first). Each viewer sits on the rung their bandwidth estimate and tile size call for, and viewers on the same rung share one encoder. At most three layers run at once; a viewer who would need a fourth moves down to the next one. A layer spends what its slowest viewer's connection carries. This is what the mesh can offer in place of an SFU: the upload still grows with the viewers, the encoding doesn't.
- **Hardware first, software as the net:** a layer uses the platform's hardware encoder (VideoToolbox; Media Foundation's hardware encoders, which cover NVENC, AMF and Quick Sync), required to be hardware so the stats can't lie about it. Without one, with hardware acceleration off (D46), or if it fails mid-stream, the layer continues on OpenH264 in software (Constrained Baseline).
- **Cameras** go through the sidecar too, in the camera's own best mode up to 1440p at 60 fps (`NATIVE_CAMERA` in `voice.js`). A camera with a background stays on the browser engine, where the background is made (D37).
- **Share audio without friendspeak in it:** the sidecar captures the sound and sends it as Opus on the same connection as the video. On macOS a screen share's ScreenCaptureKit filter excludes the friendspeak application (its windows stay in the picture) and a window share carries that app's sound; on Windows it is WASAPI process loopback, excluding the app's process tree for a screen and including only the window's process for a window. Friends in the call no longer hear themselves back.
- **Your own tile** is one more viewer: a loopback connection from the sidecar to the page, pinned to a small size and never the reason for a layer when another exists.
- **The browser engine's path stays**, for everything the sidecar can't carry and as the fallback, chosen per share and per viewer:
  - no sidecar in the app (Linux today, or an installer built without one), `settings.nativeStreaming` off, or `FRIENDSPEAK_MEDIA=off`: the share starts the old way;
  - the sidecar can't start a capture (permission, a source it can't open): the share starts the old way;
  - a viewer who doesn't send `stream: 1` (an app from before this) gets the browser engine's capture of the same source, opened lazily for them (`VoiceClient.legacyCapture`), over the mesh connection as in D22;
  - a viewer whose stream connection fails asks again without `stream: 1`;
  - the sidecar dies or its capture ends by itself: the share restarts on the browser engine for everyone watching (`VoiceClient.onNativeLost`). After three unexpected exits the app stops using the sidecar until it is restarted.
- **Mobile (#13):** nothing mobile-specific was built, but the viewer's side is deliberately only a stock WebRTC endpoint: send `{ watch, on, stream: 1 }`, answer the offer on a receive-only connection, play H.264 (every phone decodes Constrained Baseline in hardware) and Opus. A phone could later *send* the same way, since the viewer doesn't care what made the offer: its platform WebRTC library offers a `sendonly` connection with the same messages. That is the pathway for mobile video calls; it isn't implemented.

**Consequences:**
- **Measured, on one Apple-silicon Mac (M-series, macOS 26), sidecar to Chrome 154 on the same machine, a moving test pattern:** 2560×1440 at 60 fps, VideoToolbox, H.264 High: 58–60 fps sent and decoded, no dropped frames, 8–16 ms per frame in the encoder; 1920×1080 at 60 fps on OpenH264: 60 fps at 4.5 ms per frame. A real camera (1080p30, the built-in one) ran through AVFoundation and VideoToolbox. In the desktop app, two instances in a voice channel: the viewer got 1080p60 with the share's audio on its own connection, the tier changed live, a viewer acting as an older app got the browser engine's capture, and killing the sidecar mid-share was reported to the app, which could start it again.
- **Not run:** a real screen or window capture (the development machine refused Screen Recording to a process started from a terminal, as in D36), so ScreenCaptureKit's frame delivery, the exclusion of friendspeak from share audio, and window audio are written to the documented API but unconfirmed. **None of the Windows code has been run:** it is compiled for Windows in CI and in a cross-compiling container, no more. Nothing was measured over a real network, with several viewers, or under packet loss; the ladder constants are starting values, as D36's were.
- **A native binary ships in the desktop app.** This reverses the earlier "no native binary" position for the desktop app only; rule 3 in AGENTS.md is about the server and still holds. Cost: Rust in the build (`npm run build:media`, CI on macOS and Windows), about 8 MB per installer, and a binary to sign once the app is signed (D21).
- **Not cross-built:** the sidecar uses OS frameworks and compiles C and C++ (OpenH264, the crypto library), so `npm run dist:all` on a Mac produces Windows and Linux installers *without* it. Those apps work, on the browser engine's path. Releases are built per OS in CI and carry it.
- **Linux has no sidecar yet** (PipeWire capture and VA-API encoding are not written). Linux apps share as before and can watch native streams.
- **One more connection per viewer and kind,** with its own ICE. Like the mesh it has only STUN (D5): the sidecar learns its public address with one STUN request and offers host and server-reflexive candidates, IPv4 only. Where that fails the viewer falls back to the mesh connection.
- **H.264 only.** AV1 and HEVC from the hardware encoders are not negotiated.
- **Audio and video of a share are synchronized by arrival, not by capture timestamps:** both are stamped when they reach the engine.
- **A viewer on an older app costs the sharer a second capture** of the same source (the browser engine's) and a per-viewer encoder, as before this change. On Windows a camera can usually be opened by only one of the two, so an older viewer may not get a native camera.
- **Changing what you share** (or the camera's background) stops the old stream and starts a new one for everyone watching, instead of D22's seamless track swap, whenever the sidecar is on either side of the change.

**Still open:** PipeWire and VA-API for Linux; AV1/HEVC; an upload budget across viewers; TURN (#10); running and tuning it on Windows and on real links. An SFU stays a separate, gated decision (D36).

**Alternatives:** an SFU on the server (encode and upload once, hides IPs, but puts media through the server and needs UDP ports, against D2, D5 and rule 4; explicitly out of scope here); libwebrtc in the sidecar (the reference implementation, but a very large C++ dependency to build for three OSes); GStreamer `webrtcbin` (does capture, encode and WebRTC, but ships a runtime of plugins per OS); `webrtc-rs` (async and peer-connection shaped, but no send-side bandwidth estimation to drive the ladder); ffmpeg for encoding (one API for every hardware encoder, at the cost of building and shipping it); one encoder per viewer as in the browser path (simplest, but hardware encoders allow few sessions and the cost grows with viewers); capture in the sidecar with frames handed to the page to encode (keeps one WebRTC stack, and keeps the ceiling this was meant to remove).

## D46: Hardware acceleration is one switch, on by default · Active
**Context:** issue #47 asked to "enable GPU acceleration" and to scope what that means. Electron already draws with the GPU and decodes video on it by default on macOS and Windows; what was missing was a way to turn it off when a driver misbehaves, and D45 adds encoders that can run on the GPU.
**Decision:**
- **Settings → Voice & video → Streaming → Hardware acceleration**, on by default, covers the three places a GPU is used: drawing the app, decoding the video you watch (both Chromium), and encoding the streams you share (the sidecar's hardware encoders, D45).
- It is stored by the main process (`userData/desktop-prefs.json`), not in the page's settings, because drawing has to be decided before there is a window: off, the app calls `app.disableHardwareAcceleration()` at start. The page reads and writes it through `friendspeakDesktop.prefs()`.
- **When it applies:** the sidecar is told with each share (`hw`), so the next share already follows the switch. Chromium's drawing and decoding follow it at the next start, and the settings page says so.
- The same place shows what is in effect: which encoder shares would use, and whether this run decodes and draws on the GPU (`app.getGPUFeatureStatus()`).

**Consequences:**
- One switch, not three: someone with a broken encoder driver also loses GPU drawing. The stream falls back to software by itself when a hardware encoder fails (D45), so the switch is for glitches that aren't failures.
- No Chromium flags were added for Linux hardware video (VA-API). They vary by driver and Chromium version and couldn't be tried; Linux keeps Electron's defaults.
- Off, 1440p60 is beyond what software encoding and drawing hold on most machines; the ladder (D45) settles lower.

**Alternatives:** separate switches for drawing, decoding and encoding (more precise, more to explain, and nobody asked); storing it in the page's settings and relaunching to apply (the main process can't read `localStorage` before the window exists); always on with no switch (the issue's reading, but leaves no way out of a bad driver).

## D47: Noise suppression is DeepFilterNet in a worklet, not the browser's · Active
**Context:** after D38 the one mic option was the browser's (WebRTC's) noise suppression. It is on or off, and it leaves a lot behind: D35 measured noise-only stretches at −51 dB with it, against −68 to −71 dB with RNNoise, which D38 removed because it changed how people sounded (#44). Issue #72 asked for DeepFilterNet instead, a fullband (48 kHz) speech enhancer that D35 had passed over as too heavy without measuring it, and asked for it to be measured first, with "no" as a possible outcome.

**Measured** (D35's method: speech at −20 dBFS over fan noise and key clicks at −38 dBFS, rendered offline through the worklet at 48 kHz and live with a fake mic; a recording of a person as well as D35's synthetic voice; Electron 44 on an Apple M4 Pro):

| | Browser (D35) | RNNoise (D35) | DeepFilterNet 3 |
|---|---|---|---|
| Noise left in noise-only stretches | −51 dB | −68 to −71 dB | −66 to −69 dB at full strength, −59 dB limited to 24 dB, −49 dB limited to 12 dB |
| Speech level | unchanged | unchanged | −0.3 dB, every band from 125 Hz to 12 kHz within 0.5 dB of the clean voice |
| Added delay | | 21 ms | 39 ms |
| CPU, offline render | | 0.7% of a core | 2.8% of a core |
| Size | | 150 KB | 22 MB (14 MB wasm, 8 MB model) |

Live, a frame takes 0.3 ms of each 10 ms with the machine busy (every core loaded), at most 1 ms. On an idle machine the same work reads as 1.1 to 1.4 ms a frame and 15% of a core, because the core is clocked down; that is not a cost under load. Starting the model blocks the audio thread once for about 70 to 150 ms.

**Decision:**
- **The "Noise suppression" checkbox now switches DeepFilterNet.** `getUserMedia` always asks for `noiseSuppression: false`. It is still the only mic processing besides automatic gain (D44), on by default, and a saved on or off carries over.
- **A strength slider** under it: the most the noise is turned down by, 6 to 40 dB, with "maximum" (no limit) at the top and as the default. It is libDF's attenuation limit, so it is exact: at 24 dB a noise is 24 dB quieter.
- **A worklet of our own** (`denoise-worklet.js`, about 100 lines) around upstream's wasm, between `micMono` and `micGain`. It goes into the graph the first time the setting is on and stays; switching and the slider are messages, so nothing is rewired per toggle (the area #43 pointed at) and the mic doesn't restart. Off, it is a wire with no delay.
- **Our own build of upstream, vendored** in `public/vendor/deepfilternet/` (`scripts/denoise/`, built in Docker from a pinned commit). No npm dependency and no bundler (D1); the server image gets nothing. It carries a patch, for two reasons found while measuring:
  - The wasm binding uses the library's default thresholds, which skip the deep-filtering stage above 20 dB local SNR. With them the voice came out 5 dB down (10 dB in places, 9 dB at 1 to 2 kHz) over noise at −38 dBFS: the kind of change #44 complained about. Upstream's own `deep-filter` program uses −15/35/35 dB and keeps the voice level; the patch uses those.
  - With the `tract` version upstream pins (0.21) the patched build cost 9.5% of a core. On 0.23 it costs 2.8% with the same output, so the patch also moves libDF to tract 0.23's API.
- **If it can't run** (no 48 kHz context, a file missing, the wasm failing) the mic is sent unprocessed and Settings says why. There is no fallback to the browser's suppression: one behaviour to reason about.

**Why this doesn't repeat D35/D38:** D35 added three kinds of processing with five options, and its RNNoise thinned voices. Here there is one switch and one slider, the speech level and spectrum were measured against the clean voice (−0.3 dB, 21.5 dB signal-to-distortion against 18 dB for the untouched noisy mic), and the one way found for it to change a voice was fixed in the build before shipping.

**Consequences:**
- The mic is 39 ms later with it on (30 ms in the model, 9 ms of queueing between 480-sample frames and 128-sample blocks), 18 ms more than RNNoise was.
- It removes what isn't speech. At full strength a clap came out 67 dB down and music played into the mic 50 dB down; with a limit they are down by exactly the limit. Laughter was not measured (there is no way to synthesize it) and is the open risk from #44: the slider and the checkbox are the remedies. Soundboard clips don't pass through it.
- Every installer grows by the 22 MB of wasm and model.
- CPU and delay were measured on one fast machine. An older laptop will pay more than 2.8% of a core, on the audio thread that also plays friends' voices; if that crackles under load, this needs revisiting (a worker, or off by default).
- The first switch-on in a session inserts the node and blocks the audio thread for about a tenth of a second, in a call if that is where it happens.
- Friends on an older app still send with the browser's suppression.
- The vendored wasm is ours to rebuild: upstream has had no release since 0.5.6 and its `main` doesn't compile against tract 0.23 without the patch.
- `mic-worklet.js` (D35's gate, unused since D38) is deleted.

**Alternatives:** the `deepfilternet3-noise-filter` npm package (its wasm is downloaded from the author's CDN at run time, is built from unpublished sources, and has the threshold problem: measured −24.6 dBFS speech from −19.5); upstream's wasm unpatched (same problem, and 2 to 3 times the CPU); upstream's low-latency model (10 ms instead of 30 ms in the model at about the same quality, but a 36 MB file); a limited default strength such as 24 dB (leaves key clicks audible, and what it would protect is equally gone at −24 dB); the model in a worker with shared buffers (keeps the audio thread free at the price of more delay and code; not needed at the measured cost); keeping the browser's suppression as a fallback or a second level (two behaviours, and D35's "levels" again); recording a "no" (the measured CPU and delay are four and two times RNNoise's, which is within what a call tolerates).
