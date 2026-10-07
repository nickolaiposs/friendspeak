// Glue between friendspeak and the vendored Yukon client/server (a virtual penguin world).
//
//   /game/*          the Yukon client (game/client/dist + game/client/assets)
//   /world/login     Yukon login world  (socket.io on friendspeak's own port)
//   /world/<name>    Yukon game world
//
// Players never create a game account: each friendspeak profile is
// mapped to a penguin, and the app logs in with a token minted here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER_DIST = path.join(__dirname, 'server/dist/World.js');
const CLIENT_DIST = path.join(__dirname, 'client/dist');
const CLIENT_ASSETS = path.join(__dirname, 'client/assets');
// Default place for the asset pack
const PACK_ASSETS = path.join(__dirname, 'assets-pack');
// Art for the extra rooms, in the same layout as an asset pack
const EXTRA_ASSETS = path.join(__dirname, 'assets-extra');
const PHASER_DIST = path.dirname(require.resolve('phaser/dist/phaser.min.js'));

// Classic penguin colors (item ids 1-13), used to pick a color close to the
// friendspeak profile color.
const PENGUIN_COLORS = {
  1: '#003366', 2: '#009900', 3: '#ff3399', 4: '#333333', 5: '#cc0000', 6: '#ff6600', 7: '#ffcc00',
  8: '#660099', 9: '#996600', 10: '#ff6666', 11: '#006600', 12: '#0099cc', 13: '#8ae302',
};

function nearestColor(hex) {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return 1;
  const [r, g, b] = rgb(hex);
  let best = 1;
  let bestDist = Infinity;
  for (const [id, c] of Object.entries(PENGUIN_COLORS)) {
    const [r2, g2, b2] = rgb(c);
    const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
    if (d < bestDist) [best, bestDist] = [Number(id), d];
  }
  return best;
}

let extraAssetsDir = null;

function assetDirs() {
  // First match wins: the client's own styles/scripts come before the pack's
  return [process.env.GAME_ASSETS_DIR, extraAssetsDir, CLIENT_ASSETS, PACK_ASSETS, EXTRA_ASSETS].filter(Boolean);
}

function hasAssets() {
  return assetDirs().some((d) => fs.existsSync(path.join(d, 'media/preload/preload-pack.json')));
}

function loadSecret(dataDir) {
  const file = path.join(dataDir, 'game-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

// enabled(): whether the game is switched on right now (Settings → Server); the worlds refuse connections while it isn't
async function startGame({ app, express, httpServer, dataDir, assetsDir, enabled = () => true }) {
  extraAssetsDir = assetsDir || null;
  const worldName = (process.env.GAME_WORLD || 'Blizzard').replace(/[^\w -]/g, '').slice(0, 20) || 'Blizzard';
  const worldPath = '/world/' + worldName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  if (!fs.existsSync(SERVER_DIST) || !fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
    return { available: false, reason: 'The game is not built on this server (run `npm run build:game`).' };
  }

  // Serve the client even without assets, so the host can see what's missing.
  app.get('/game/friendspeak.js', (_req, res) => {
    res.type('js').send(
      `window.FRIENDSPEAK_GAME = ${JSON.stringify({
        worlds: { Login: { path: '/world/login', login: true }, [worldName]: { path: worldPath } },
      })};`
    );
  });
  app.use('/game/lib', express.static(PHASER_DIST));
  app.use('/game', express.static(CLIENT_DIST));
  for (const dir of assetDirs()) {
    app.use('/game/assets', express.static(dir));
    // Yukon loads some files (clothing sprites, icons, igloo floors) from the site root
    app.use('/assets', express.static(dir));
  }

  if (!hasAssets()) {
    return {
      available: false,
      reason: 'The game assets are missing on this server. The host needs to add the Yukon asset pack (see the README).',
    };
  }

  const { startWorlds } = require(SERVER_DIST);
  const config = {
    crypto: { secret: loadSecret(dataDir), rounds: 10, loginKeyExpiry: 300 },
    database: { dialect: 'sqlite', storage: path.join(dataDir, 'game.sqlite'), database: 'yukon', debug: false },
    socketio: { https: false },
    cors: { origin: '*' },
    rateLimit: {
      enabled: true,
      addressConnectsPerSecond: 5,
      addressEventsPerSecond: 50,
      userEventsPerSecond: 10,
      ipAddressHeader: false,
    },
    worlds: {
      Login: { path: '/world/login', httpServer },
      [worldName]: { path: worldPath, httpServer, maxUsers: Number(process.env.GAME_MAX_USERS) || 300 },
    },
    cooldowns: { send_emote: 250, send_frame: 250 },
    // Spawn everyone in the Town so friends start together (0 = random, Yukon's default)
    game: { preferredSpawn: process.env.GAME_SPAWN !== undefined ? Number(process.env.GAME_SPAWN) || 0 : 100, iglooIdOffset: 2000 },
    logging: process.env.GAME_DEBUG === '1',
  };
  const { db, worlds } = await startWorlds(config);
  const bcrypt = require('bcryptjs');
  // The worlds are socket.io servers of their own on friendspeak's port: nothing friendspeak
  // decides reaches them unless it is done here.
  for (const world of Object.values(worlds)) world.server.use((_socket, next) => (enabled() ? next() : next(new Error('The game is turned off on this server'))));

  await db.sequelize.query(
    'CREATE TABLE IF NOT EXISTS friendspeak_accounts (profileId TEXT PRIMARY KEY, userId INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, baseName TEXT)'
  );
  // baseName (added later): the name the penguin's username was last derived from
  const [columns] = await db.sequelize.query('PRAGMA table_info(friendspeak_accounts)');
  if (!columns.some((c) => c.name === 'baseName')) {
    await db.sequelize.query('ALTER TABLE friendspeak_accounts ADD COLUMN baseName TEXT');
  }

  function baseUsername(name) {
    // Yukon: 4-12 printable ASCII characters
    let base = String(name || '').replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);
    if (base.length < 4) base = `${base} Penguin`.trim().slice(0, 12);
    return base;
  }

  // ownId: the penguin being renamed, whose current username counts as free
  async function uniqueUsername(base, ownId) {
    for (let i = 0; i < 1000; i++) {
      const suffix = i === 0 ? '' : String(i + 1);
      const candidate = (base.slice(0, 12 - suffix.length).trim() + suffix).padEnd(4, '0');
      const taken = await db.users.findOne({ where: { username: candidate } });
      if (!taken || taken.id === ownId) return candidate;
    }
    return 'P' + crypto.randomBytes(5).toString('hex').slice(0, 11);
  }

  // A profile name is user input: no control characters in a log line
  const logName = (name) => String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 32) || 'anon';

  async function login(profile) {
    const [rows] = await db.sequelize.query('SELECT userId, baseName FROM friendspeak_accounts WHERE profileId = ?', {
      replacements: [profile.id],
    });
    let user = rows[0] ? await db.users.findOne({ where: { id: rows[0].userId } }) : null;
    const base = baseUsername(profile.name);

    if (!user) {
      user = await db.users.create({
        username: await uniqueUsername(base),
        // Random password nobody knows: logins go through friendspeak tokens
        password: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10),
        color: nearestColor(profile.color),
      });
      await db.sequelize.query('INSERT OR REPLACE INTO friendspeak_accounts (profileId, userId, baseName) VALUES (?, ?, ?)', {
        replacements: [profile.id, user.id, base],
      });
      console.log(`[game] created penguin "${user.username}" for ${logName(profile.name)}`);
    } else if (rows[0].baseName !== base) {
      // The profile was renamed. Comparing the derived name, not the username,
      // keeps a penguin from flipping between "Name" and "Name2".
      const username = await uniqueUsername(base, user.id);
      if (username !== user.username) {
        const previous = user.username;
        await user.update({ username });
        console.log(`[game] renamed penguin "${previous}" to "${username}" for ${logName(profile.name)}`);
      }
      await db.sequelize.query('UPDATE friendspeak_accounts SET baseName = ? WHERE profileId = ?', {
        replacements: [base, profile.id],
      });
    }

    const selector = crypto.randomUUID();
    const validator = crypto.randomBytes(24).toString('hex');
    await db.authTokens.destroy({ where: { userId: user.id } });
    await db.authTokens.create({ userId: user.id, selector, validator: await bcrypt.hash(validator, 10) });

    return { username: user.username, token: `${selector}:${validator}`, path: '/game/' };
  }

  // Someone stopped being a member (removed, banned or left): their sign-in tokens go and their
  // penguin is disconnected. The penguin itself stays, for when they are let back in.
  async function revoke(profileId) {
    const [rows] = await db.sequelize.query('SELECT userId FROM friendspeak_accounts WHERE profileId = ?', { replacements: [profileId] });
    if (!rows[0]) return;
    const userId = rows[0].userId;
    await db.authTokens.destroy({ where: { userId } });
    await db.users.update({ loginKey: null }, { where: { id: userId } });
    for (const world of Object.values(worlds)) for (const user of Object.values(world.users)) if (user.id === userId) user.close();
  }

  // The game was switched off: everyone in the worlds is disconnected
  function closeAll() {
    for (const world of Object.values(worlds)) for (const user of Object.values(world.users)) user.close();
  }

  // Everyone connected to the game world (not the login world), for the admin dashboard
  const maxUsers = config.worlds[worldName].maxUsers;
  const players = () => Object.keys(worlds[worldName].users).length;
  return { available: true, worldName, login, revoke, closeAll, players, maxUsers };
}

module.exports = { startGame };
