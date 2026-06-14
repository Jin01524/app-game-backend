const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const dns = require('dns');
require('dotenv').config();

// Force IPv4 DNS resolution - Render.com does not support IPv6 outbound connections
dns.setDefaultResultOrder('ipv4first');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres'
});

// Auto-convert SQLite '?' to Postgres '$1', '$2', etc.
function convertSql(sql) {
  let i = 1;
  return sql.replace(/\?/g, () => `$${i++}`);
}

async function getOne(sql, params = []) {
  try {
    const res = await pool.query(convertSql(sql), params);
    return res.rows.length > 0 ? res.rows[0] : null;
  } catch (err) {
    console.error('getOne error:', err, 'SQL:', sql, 'Params:', params);
    return null;
  }
}

async function getAll(sql, params = []) {
  try {
    const res = await pool.query(convertSql(sql), params);
    return res.rows;
  } catch (err) {
    console.error('getAll error:', err, 'SQL:', sql, 'Params:', params);
    return [];
  }
}

async function runSql(sql, params = []) {
  try {
    await pool.query(convertSql(sql), params);
  } catch (err) {
    console.error('runSql error:', err, 'SQL:', sql, 'Params:', params);
  }
}

async function initDb() {
  console.log('🔄 Initializing PostgreSQL Database...');
  
  await runSql(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      avatar TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      xu INTEGER NOT NULL DEFAULT 0,
      last_online TIMESTAMP,
      inventory_slots INTEGER NOT NULL DEFAULT 5,
      char_head_color TEXT DEFAULT '#ffccaa',
      char_hair_color TEXT DEFAULT '#8b4513',
      char_body_color TEXT DEFAULT '#3b82f6',
      char_legs_color TEXT DEFAULT '#1e293b',
      char_shoe_color TEXT DEFAULT '#000000',
      backpack TEXT DEFAULT '[null, null, null, null]',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runSql(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  await runSql(`
    CREATE TABLE IF NOT EXISTS user_farms (
      user_id INTEGER PRIMARY KEY,
      level INTEGER DEFAULT 0,
      state TEXT DEFAULT 'idle',
      planted_at TIMESTAMP,
      animals TEXT DEFAULT '[]',
      cage_inventory TEXT DEFAULT '[null, null, null, null]',
      animals_data TEXT DEFAULT '[]',
      cage_products TEXT DEFAULT '[]',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await runSql(`
    CREATE TABLE IF NOT EXISTS user_inventory (
      user_id INTEGER,
      item_id TEXT,
      quantity INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, item_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await runSql(`
    CREATE TABLE IF NOT EXISTS user_quests (
      user_id INTEGER NOT NULL,
      quest_key TEXT NOT NULL,
      progress INTEGER DEFAULT 0,
      completed BOOLEAN DEFAULT FALSE,
      claimed BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, quest_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await runSql(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL,
      recipient_id INTEGER,
      content TEXT NOT NULL,
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await runSql(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      action_type TEXT NOT NULL,
      details TEXT,
      xu_change INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runSql(`
    CREATE TABLE IF NOT EXISTS travel_groups (
      id SERIAL PRIMARY KEY,
      code VARCHAR(10) UNIQUE NOT NULL,
      name TEXT NOT NULL,
      leader_username TEXT NOT NULL,
      route_waypoints TEXT DEFAULT '[]',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runSql(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER REFERENCES travel_groups(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      status TEXT NOT NULL DEFAULT 'active',
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (group_id, username)
    )
  `);

  // Ensure is_read column exists in existing database
  await runSql(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE`);

  // Ensure character_type column exists in existing database
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS character_type TEXT DEFAULT 'FrogNinja'`);

  // Ensure energy and energy_updated_at columns exist
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS energy INTEGER DEFAULT 6`);
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS energy_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);

  // Ensure vehicle_skins and equipped_vehicle_skin columns exist
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_skins TEXT DEFAULT '["Motorcycle_orange"]'`);
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS equipped_vehicle_skin TEXT DEFAULT 'Motorcycle_orange'`);
  await runSql(`UPDATE users SET vehicle_skins = '["Motorcycle_orange"]' WHERE vehicle_skins IS NULL`);
  await runSql(`UPDATE users SET equipped_vehicle_skin = 'Motorcycle_orange' WHERE equipped_vehicle_skin IS NULL`);

  // Ensure movies and watch logs tables exist
  await runSql(`
    CREATE TABLE IF NOT EXISTS movies (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      cover_url TEXT,
      tags TEXT,
      country TEXT,
      genre TEXT,
      parts TEXT DEFAULT '[]',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runSql(`
    CREATE TABLE IF NOT EXISTS movie_watch_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      movie_id INTEGER REFERENCES movies(id) ON DELETE CASCADE,
      part_index INTEGER NOT NULL,
      episode_index INTEGER NOT NULL,
      watched_seconds INTEGER DEFAULT 0,
      last_position_seconds INTEGER DEFAULT 0,
      last_watched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, movie_id, part_index, episode_index)
    )
  `);

  // ── Performance Indexes ─────────────────────────────────────────────────────
  await runSql(`CREATE INDEX IF NOT EXISTS idx_users_username      ON users(username)`);
  await runSql(`CREATE INDEX IF NOT EXISTS idx_inventory_user_id   ON user_inventory(user_id)`);
  await runSql(`CREATE INDEX IF NOT EXISTS idx_farms_user_id       ON user_farms(user_id)`);
  await runSql(`CREATE INDEX IF NOT EXISTS idx_logs_created_at     ON activity_logs(created_at DESC)`);
  await runSql(`CREATE INDEX IF NOT EXISTS idx_logs_username       ON activity_logs(username)`);
  await runSql(`CREATE INDEX IF NOT EXISTS idx_messages_recipient  ON messages(recipient_id)`);
  await runSql(`CREATE INDEX IF NOT EXISTS idx_group_members_uname ON group_members(username)`);
  await runSql(`CREATE INDEX IF NOT EXISTS idx_watch_logs_user_movie ON movie_watch_logs(user_id, movie_id)`);

  // Default settings
  await runSql(`INSERT INTO settings (key, value) VALUES ('gkBaseSpeed', '1.2') ON CONFLICT (key) DO NOTHING`);
  await runSql(`INSERT INTO settings (key, value) VALUES ('goalWidth', '80') ON CONFLICT (key) DO NOTHING`);
  await runSql(`INSERT INTO settings (key, value) VALUES ('aimSpeed', '2.0') ON CONFLICT (key) DO NOTHING`);

  await seedUsers();
  console.log('✅ Database Initialization Complete.');
  return true;
}

const ACCOUNTS = [
  { username: 'ngocbinh', displayName: 'Ngọc Bình',  password: '123456', role: 'user' },
  { username: 'mynhung',  displayName: 'Mỹ Nhung',   password: '123456', role: 'user' },
  { username: 'davit',    displayName: 'Davit',       password: '123456', role: 'user' },
  { username: 'pmai',     displayName: 'P. Mai',      password: '123456', role: 'user' },
  { username: 'phuong',   displayName: 'Phương',      password: '123456', role: 'user' },
  { username: 'tuan',     displayName: 'Tuân',        password: '123456', role: 'user' },
  { username: 'ahuy',     displayName: 'Á Huy',       password: '123456', role: 'user' },
  { username: 'mtam',     displayName: 'M. Tâm',      password: '123456', role: 'user' },
  { username: 'admin',    displayName: 'Quản trị viên', password: '1234',  role: 'admin' },
  { username: 'agent',    displayName: 'Agent Test',  password: '1234',  role: 'user' },
];

async function seedUsers() {
  for (const acc of ACCOUNTS) {
    const user = await getOne('SELECT id FROM users WHERE username = ?', [acc.username]);
    if (user) {
      continue;
    }
    const hash = bcrypt.hashSync(acc.password, 10);
    await runSql('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?) ON CONFLICT (username) DO NOTHING',
      [acc.username, hash, acc.displayName, acc.role]);
    console.log(`✅ Seeded ${acc.role}: ${acc.username}`);
  }
}

async function logActivity(username, actionType, details = '', xuChange = 0) {
  try {
    await runSql(
      'INSERT INTO activity_logs (username, action_type, details, xu_change) VALUES (?, ?, ?, ?)',
      [username, actionType, details, xuChange]
    );
  } catch (err) {
    console.error('logActivity error:', err);
  }
}

async function decayUserEnergy(userId) {
  const user = await getOne('SELECT id, energy, energy_updated_at FROM users WHERE id = ?', [userId]);
  if (!user) return null;

  const now = new Date();
  const lastUpdate = new Date(user.energy_updated_at || now);
  const elapsedMs = now.getTime() - lastUpdate.getTime();
  
  const decayInterval = 2 * 60 * 1000; // 2 minutes
  const decayCount = Math.floor(elapsedMs / decayInterval);

  if (decayCount > 0) {
    const newEnergy = Math.max(0, (user.energy !== null ? user.energy : 6) - decayCount);
    const newUpdateTime = new Date(lastUpdate.getTime() + decayCount * decayInterval);
    
    await runSql('UPDATE users SET energy = ?, energy_updated_at = ? WHERE id = ?', [
      newEnergy,
      newUpdateTime,
      userId
    ]);
    return { energy: newEnergy, energy_updated_at: newUpdateTime };
  }
  
  return { energy: user.energy !== null ? user.energy : 6, energy_updated_at: user.energy_updated_at };
}

module.exports = { initDb, getOne, getAll, runSql, pool, logActivity, decayUserEnergy };
