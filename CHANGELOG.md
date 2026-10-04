# Changelog

Every release is built from the `prod` branch. Add a section for the new
version (matching `version` in package.json) before merging `dev` into `prod`:
the release workflow publishes it as the GitHub Release notes, and the app and
servers link to it. Newest first.

## 1.1.6 - 2026-10-04

- Admin dashboard: it moves from `/admin` to a random path, printed when the
  server starts, and signing in with a key takes a code from an authenticator
  app, set up at the first sign-in. **Updating:** `/admin` stops working from
  another machine. Read the new address from the server's output, and expect
  the QR code at your next sign-in. `ADMIN_PATH=off` and `ADMIN_MFA=off` keep
  things as they were
- Search in channels and DMs, with `from:`, `in:`, `has:`, `before:`, `after:`
  and `on:` filters; picking a result jumps to the message
- `#channel` links that follow renames, with a pick list in the composer, and
  **Copy message link**, which shows a preview to people who can read the
  message
- Streams: hovering a voice channel or a person who is streaming opens a card
  with Start watching, which joins the channel first when needed
- Banned people, and people who remove the server from their list, need an
  invite to come back
- A Docker stack for a domain in `deploy/`: friendspeak behind Caddy with real
  HTTPS, and an install script. `PUBLIC_URL` makes the server print the
  addresses people use
- DMs: a message sent just before yours and delivered after it no longer shows
  under your name
- Shorter descriptions in the app and the dashboard

## 1.1.5 - 2026-10-03

- Invites replace the server password: people join with an invite token, made
  in the admin dashboard or in Server settings → Invites (never expiring, one
  use, a number of uses, or expiring after a time), and revoked there. Members
  come back without one. **Updating:** `PASSWORD` is ignored; members stay, and
  new people need an invite. The first invite is printed when the server starts
  and listed in the dashboard. A server that had no password becomes
  invite-only: switch **Require an invite to join** off to keep it open
- Roles carry permissions, with per-channel overrides and a Server settings
  window (Overview, Roles, Members, Emojis, Bans, Invites). A server stays open
  until the host makes someone an admin in the dashboard. Only admins and
  moderators can open Server settings once it isn't
- Screen, window and camera shares can be captured, encoded and sent by a
  native media program, with a hardware acceleration switch
- Voice: noise suppression is DeepFilterNet with a strength slider, echo
  cancellation and a noise gate with a level bar are on by default, the mic is
  sent mono at full level with automatic gain, and the mic can be switched
  mid-call. The soundboard is fixed
- Logs: the dashboard keeps the server log's history with search and shows
  crash reports; the app keeps its own log and crash reports. Nothing is sent
  anywhere
- Profiles: each has its own server list, last server and unread mentions
- Connect: addresses default to https

## 1.1.4 - 2026-10-03

- Notifications: only DMs, incoming DM calls and mentions notify. Mentions
  cover `@name`, `@role`, `@everyone` and replies, with `@` autocomplete, red
  badges on channels and servers, a dock badge, and a tag to tell apart people
  who share a name. Mentions follow renames in old messages
- Settings → Notifications: master switches, muted people and servers, and a
  switch, volume and preview for every sound
- Voice: one noise suppression toggle (RNNoise, the noise gate and speaker mode
  are gone), highest-quality Opus by default with a per-server voice quality
  setting, and a mic test that silences everything else while it runs
- UI size: whole-window zoom in Settings → Appearance, also driven by the View
  menu and shortcuts, and kept across restarts
- Servers pin one key per profile id and `hello` is signed, so a copied profile
  id can't be used without its keys. The admin dashboard can reset a key.
  Reverse proxies must pass the original `Host` header. Your profile file is
  your identity: keep it safe
- DMs keep an open connection when a shared server goes down or restarts

## 1.1.3 - 2026-10-02

- Admin dashboard at `/admin`: access, overview, server log, users, bans and
  roles, updates, storage, channels, game and server settings, update mode and
  maintenance window
- Master volume, per-user boost and mute, and mute/deafen shortcuts
- Voice: RNNoise noise reduction, a noise gate with a level display, and
  speaker mode
- Camera: background blur made on the sender's device, a preview before going
  live, and picture backgrounds
- Screen share quality: pick a tier (Auto, 720p30, 1080p60 or 1440p60)
  and what to optimize for (smooth motion or sharp text) when you share, and
  change both while live from the share button
- Screen shares now stop at 1440p 60 fps instead of 4K 120 fps: no screen
  capture tested came near 120 fps
- Each viewer's stream now adapts to its connection and your computer: it drops
  resolution (smooth) or frame rate (sharp) when needed and climbs back up
- A share now reaches full resolution sooner when the screen updates slower
  than the tier's frame rate (about 7 s instead of 25 s in one test)
- Windows: screen capture keeps frames on the GPU, which raised a 1440p share
  from about 30 to about 57 fps in motion in one test. If a share comes out
  black or frozen, start the app with `FRIENDSPEAK_LEGACY_CAPTURE=1`
- The encoded picture size is kept even, and the video codec is chosen for your
  machine and mode. This may fix low frame rates on shares where hardware
  encoding was being skipped, but it isn't confirmed yet
- Stream stats: click the quality readout in the video view to see encoder and
  connection numbers, and copy them to report a problem. Works for both sides
- Works with friends on older versions

## 1.1.2 - 2026-10-01

- Calls in direct messages: voice and video calls with a friend, with screen
  sharing, from the phone and camera buttons at the top of a conversation
- Direct messages are end-to-end encrypted, and each profile has its own keys.
  A message to someone who is offline waits for them in a mailbox on a server
  you share (the server must run 1.1.2 too)
- Images in direct messages (up to 4 per message, 10 MB each)
- Friend codes: message someone you share no server with (the **+** under DMs)
- Stay in a voice channel while you look at another server
- Themes: light, dark and high contrast, 50 color schemes, a custom palette,
  and font, text size and density settings
- Renaming your profile renames your penguin
- Fixed: a direct message connection that never opened was not retried
- New server option `DM_GUESTS` (default on): lets people without the server
  password pass encrypted direct messages through it. Set it to `off` to
  refuse them

## 1.1.1 - 2026-10-01

- Fixed: the server name field in Server settings didn't accept typing

## 1.1.0 - 2026-10-01

First published release.

- Text channels with markdown, replies, edits, reactions, files and embeds
- Peer-to-peer direct messages
- WebRTC voice with push-to-talk, soundboard, screen sharing and cameras
- Optional virtual penguin world built on Yukon (game assets not included)
- Desktop app for macOS, Windows and Linux that checks for updates (installs
  them in-app on Windows and Linux; macOS links to the download)
- Server auto-updates for Docker: `AUTO_UPDATE=on` installs new releases in a
  maintenance window (`MAINTENANCE_CRON`, default Sunday 06:00) after warning
  everyone on the server
