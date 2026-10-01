// friendspeak integration for the Yukon client:
//  - game worlds live on the same host as the friendspeak server (/world/<name>)
//  - the friendspeak app opens the game with #u=<penguin>&t=<token> so players
//    are logged in automatically, with no game account to create.

import * as extras from './extras'

const params = new URLSearchParams(location.hash.slice(1))
const autoLogin = params.get('u') && params.get('t')
    ? { username: params.get('u'), token: params.get('t') }
    : null

if (autoLogin) {
    // Keep the token out of the address bar and history
    history.replaceState(null, '', location.pathname + location.search)
}

const friendspeak = {

    autoLogin,

    // Add rooms, games and strings for the extra rooms that the asset
    // pack doesn't know about
    applyExtraRooms(crumbs) {
        for (const kind of ['rooms', 'games', 'strings']) {
            crumbs[kind] = crumbs[kind] || {}

            for (const [id, value] of Object.entries(extras[kind])) {
                if (!(id in crumbs[kind])) crumbs[kind][id] = value
            }
        }
    },

    // Point the client at this server's worlds instead of the crumbs' defaults
    applyWorlds(crumbs) {
        const config = window.FRIENDSPEAK_GAME
        if (!config) return

        crumbs.worlds = {}

        for (const [id, world] of Object.entries(config.worlds)) {
            crumbs.worlds[id] = { ...world, host: location.origin }
        }
    },

    login(scene) {
        if (!autoLogin) return false

        scene.interface.showLoading(`Logging in ${autoLogin.username}`)
        scene.scene.stop()

        scene.network.lastLoginScene = null
        scene.network.connectLogin(false, false, () => {
            scene.network.send('token_login', { username: autoLogin.username, token: autoLogin.token })
        })

        return true
    },

    notify(event, data = {}) {
        if (window.parent !== window) {
            window.parent.postMessage({ source: 'friendspeak-game', event, ...data }, '*')
        }
    }

}

// Forward key presses to the friendspeak app hosting this iframe, so its
// push-to-talk and soundboard hotkeys keep working while the game has focus.
if (window.parent !== window) {
    const forward = (e) => friendspeak.notify(e.type, {
        code: e.code,
        key: e.key,
        repeat: e.repeat,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        typing: !!(e.target && e.target.closest && e.target.closest('input, textarea'))
    })

    window.addEventListener('keydown', forward, true)
    window.addEventListener('keyup', forward, true)
}

export default friendspeak
