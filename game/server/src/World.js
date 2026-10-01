import Database from './database/Database'
import GameHandler from './handlers/GameHandler'
import LoginHandler from './handlers/LoginHandler'
import Server from './server/Server'


class World extends Server {

    constructor(id, db, config) {
        const world = config.worlds[id]
        console.log(`[${id}] Starting world ${id} on ${world.path || `port ${world.port}`}`)

        let users = {}

        let handler = (id == 'Login') ? LoginHandler : GameHandler
        handler = new handler(id, users, db, config)
        handler.logging = !!config.logging

        super(id, users, db, handler, config)
    }

}

// friendspeak: worlds are started from friendspeak's server instead of as
// separate pm2 processes. All worlds share one database connection.
export async function startWorlds(config) {
    const db = new Database(config.database)
    await db.ready

    // Make sure every game world has a population row
    for (const id of Object.keys(config.worlds)) {
        if (id != 'Login') {
            await db.worlds.upsert({ id: id, population: 0 })
        }
    }

    const worlds = {}
    for (const id of Object.keys(config.worlds)) {
        worlds[id] = new World(id, db, config)
    }

    return { db, worlds }
}

// Standalone usage (original yukon-server behaviour): node dist/World.js Login Blizzard
if (require.main === module) {
    const config = require('../config/config.json')
    const ids = process.argv.slice(2).filter(world => world in config.worlds)
    const selected = { ...config, worlds: Object.fromEntries(ids.map(id => [id, config.worlds[id]])) }

    startWorlds(selected)
}
