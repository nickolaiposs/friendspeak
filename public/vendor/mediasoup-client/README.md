# mediasoup-client

The app's side of the server's SFU (`public/js/sfu.js`, D70):
[mediasoup-client](https://github.com/versatica/mediasoup-client) by Iñaki
Baz Castillo and José Luis Millán, which drives an `RTCPeerConnection` to
publish to and consume from a mediasoup router. ISC licence (`LICENSE`).

| File | What it is | SHA-256 (as committed, LF line endings) |
|---|---|---|
| `mediasoup-client.js` | mediasoup-client 3.24.5 and its dependencies as one ES module | `749875f8a2d2d11a2963222a9d1849fd0ee08e4683b65fc7173bb3b0356cdc4b` |
| `LICENSE` | its licence, copied from the package | |

It ships inside the desktop app, so the client keeps loading its files as they
are, with no build step (D1).

## Where the build comes from

`scripts/build-mediasoup-client.js` (`npm run build:mediasoup-client`) bundles
the `mediasoup-client` devDependency, pinned in `package.json` and
`package-lock.json`, with esbuild (also pinned), for Chrome 120 and later. It
names the exports the app uses (`Device`, `version`, `detectDevice`,
`detectDeviceAsync`, `parseScalabilityMode`): the package is CommonJS, and a
bare `export *` would give a module with none. Its `debug` logging is compiled
out (`process.env.DEBUG` is undefined). Nothing else is changed.

To move to another version: change both pins (mediasoup-client must stay
compatible with the server's `mediasoup`), `npm install`, run the script, and
put the hash it prints in the table above.
