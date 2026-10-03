// Exposes a small, explicit API to the friendspeak UI (window.friendspeakDesktop).
const { contextBridge, ipcRenderer, webFrame } = require('electron');

let registered = new Set();

contextBridge.exposeInMainWorld('friendspeakDesktop', {
  platform: process.platform,
  // Asks the user to trust a server's self-signed certificate (pinned after the first yes)
  trustServer: (address) => ipcRenderer.invoke('desktop:trust-server', address),

  // Soundboard hotkeys that also work while other apps are focused
  async setHotkeys(combos) {
    registered = new Set(await ipcRenderer.invoke('desktop:set-hotkeys', combos));
    return [...registered];
  },
  hasGlobalHotkey: (combo) => registered.has(combo),
  onHotkey: (cb) => ipcRenderer.on('desktop:hotkey', (_e, combo) => cb(combo)),

  // UI size (Settings → Appearance): the window's zoom factor. The View menu's
  // zoom items ask the page to step it, so the setting stays the source of truth.
  setZoom: (factor) => Number.isFinite(factor) && webFrame.setZoomFactor(Math.min(2, Math.max(0.5, factor))),
  onZoom: (cb) => ipcRenderer.on('desktop:zoom', (_e, step) => cb(step)),

  // Save a chat file (a normal link would open in the system browser)
  download: (url) => ipcRenderer.invoke('desktop:download', url),

  // Screen sharing: list screens/windows, then pick one right before getDisplayMedia()
  screenSources: () => ipcRenderer.invoke('desktop:screen-sources'),
  pickScreenSource: (pick) => ipcRenderer.invoke('desktop:screen-pick', pick),

  // App updates from GitHub Releases: { current, status, version, url, canInstall, progress, error }
  updateState: () => ipcRenderer.invoke('desktop:update-state'),
  onUpdate: (cb) => ipcRenderer.on('desktop:update', (_e, state) => cb(state)),
  checkForUpdates: () => ipcRenderer.invoke('desktop:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:update-download'), // or opens the release page where it can't install
  installUpdate: () => ipcRenderer.invoke('desktop:update-install'),
  openReleases: (version) => ipcRenderer.invoke('desktop:open-releases', version),
});
