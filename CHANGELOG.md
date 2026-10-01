# Changelog

Every release is built from the `prod` branch. Add a section for the new
version (matching `version` in package.json) before merging `dev` into `prod`:
the release workflow publishes it as the GitHub Release notes, and the app and
servers link to it. Newest first.

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
