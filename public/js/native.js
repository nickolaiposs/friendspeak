// The native media sidecar (D45), as the desktop app exposes it: a process of
// its own that captures a screen, window or camera with the OS's APIs, encodes
// it (in hardware where it can) and sends it to each viewer over standard
// WebRTC. This module is the thin client for it; voice.js decides when a share
// goes through it and relays its signaling. Without the desktop app, or where
// the sidecar isn't there or keeps failing, `can()` is false and shares use
// the browser engine as before.
import { log } from './log.js';
import { settings } from './store.js';

const bridge = window.friendspeakDesktop?.media || null;
const handlers = { screen: null, camera: null };
let caps = null; // { sources: [...], hardware: [...], audio } once the sidecar has answered; false when there is none
let asked = null;

bridge?.on((ev) => {
  // The sidecar went away: every share it carried has stopped
  if (ev.ev === 'exit') {
    log.warn(`native media process exited${ev.gone ? ' for good' : ''}`);
    caps = ev.gone ? false : null;
    asked = null;
    for (const kind of Object.keys(handlers)) handlers[kind]?.({ ev: 'stopped', kind, reason: 'the native media process stopped' });
    return;
  }
  handlers[ev.kind]?.(ev);
});

export const nativeMedia = {
  // Ask the sidecar what it can do (starts it). Resolves to its capabilities, or false.
  load() {
    if (!bridge) return Promise.resolve(false);
    asked ||= bridge
      .caps()
      .then((c) => (caps = c || false))
      .catch(() => (caps = false));
    return asked;
  },
  get caps() {
    return caps;
  },
  // Whether a share from this kind of source ('screen', 'window', 'camera') can go through the sidecar now
  can(source) {
    return !!caps && settings.get().nativeStreaming && caps.sources.includes(source);
  },
  send(cmd) {
    bridge?.send(cmd);
  },
  // One listener per kind: the VoiceClient that is sharing it
  claim(kind, handler) {
    handlers[kind] = handler;
  },
  release(kind, handler) {
    if (handlers[kind] === handler) handlers[kind] = null;
  },
};
