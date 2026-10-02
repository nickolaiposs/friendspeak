# Changelog

Every release is built from the `prod` branch. Add a section for the new
version (matching `version` in package.json) before merging `dev` into `prod`:
the release workflow publishes it as the GitHub Release notes, and the app and
servers link to it. Newest first.

## Unreleased

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
