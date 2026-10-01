// friendspeak: a tiny sqlite3-compatible driver for Sequelize backed by
// Node's built-in `node:sqlite`. This avoids native modules (sqlite3), so the
// same code runs under plain Node and inside Electron without rebuilds.

const originalEmitWarning = process.emitWarning
process.emitWarning = function(warning, ...args) {
    if (String(warning).includes('SQLite is an experimental feature')) return
    return originalEmitWarning.call(process, warning, ...args)
}

const { DatabaseSync } = require('node:sqlite')

const CONSTRAINT_CODES = {
    19: 'SQLITE_CONSTRAINT',
    275: 'SQLITE_CONSTRAINT_CHECK',
    787: 'SQLITE_CONSTRAINT_FOREIGNKEY',
    1299: 'SQLITE_CONSTRAINT_NOTNULL',
    1555: 'SQLITE_CONSTRAINT_PRIMARYKEY',
    2067: 'SQLITE_CONSTRAINT_UNIQUE'
}

function wrapError(error) {
    if (error && typeof error.errcode === 'number') {
        error.code = CONSTRAINT_CODES[error.errcode] || 'SQLITE_ERROR'
    }
    return error
}

function toValue(value) {
    if (value === undefined) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    if (value instanceof Date) return value.toISOString()
    return value
}

// Sequelize binds numbered parameters ($1, $2...) as an array, or named
// parameters as an object. node:sqlite binds anonymous values by index, which
// would break if $2 appeared before $1, so numbered params become named ones.
function bind(sql, params) {
    if (Array.isArray(params)) {
        if (/\$\d/.test(sql)) {
            const named = {}
            params.forEach((value, i) => named[`$${i + 1}`] = toValue(value))
            return [named]
        }
        return params.map(toValue)
    }
    if (params && typeof params === 'object') {
        const named = {}
        for (const key of Object.keys(params)) {
            named[key.startsWith('$') ? key : `$${key}`] = toValue(params[key])
        }
        return [named]
    }
    return []
}

function normalize(params, callback) {
    if (typeof params === 'function') return [[], params]
    return [params, callback || (() => {})]
}

class Database {

    constructor(filename, mode, callback) {
        if (typeof mode === 'function') callback = mode
        this.filename = filename
        try {
            this.db = new DatabaseSync(filename)
            this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
            setImmediate(() => callback && callback(null))
        } catch (error) {
            setImmediate(() => callback && callback(wrapError(error)))
        }
    }

    serialize(fn) {
        // Every call is synchronous, so statements are already serialized.
        if (fn) fn()
    }

    run(sql, params, callback) {
        [params, callback] = normalize(params, callback)
        let result
        try {
            result = this.db.prepare(sql).run(...bind(sql, params))
        } catch (error) {
            return callback.call({}, wrapError(error))
        }
        callback.call({ lastID: Number(result.lastInsertRowid), changes: Number(result.changes) }, null)
    }

    all(sql, params, callback) {
        [params, callback] = normalize(params, callback)
        let rows
        try {
            rows = this.db.prepare(sql).all(...bind(sql, params)).map(row => ({ ...row }))
        } catch (error) {
            return callback.call({}, wrapError(error))
        }
        callback.call({}, null, rows)
    }

    get(sql, params, callback) {
        [params, callback] = normalize(params, callback)
        let row
        try {
            row = this.db.prepare(sql).get(...bind(sql, params))
        } catch (error) {
            return callback.call({}, wrapError(error))
        }
        callback.call({}, null, row ? { ...row } : undefined)
    }

    exec(sql, callback) {
        try {
            this.db.exec(sql)
        } catch (error) {
            return callback && callback(wrapError(error))
        }
        callback && callback(null)
    }

    close(callback) {
        try {
            this.db.close()
        } catch (error) {
            return callback && callback(wrapError(error))
        }
        callback && callback(null)
    }

}

module.exports = {
    Database,
    OPEN_READONLY: 1,
    OPEN_READWRITE: 2,
    OPEN_CREATE: 4,
    verbose() {
        return this
    }
}
