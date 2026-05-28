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
      backpack TEXT DEFAULT '[null, null]',
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

module.exports = { initDb, getOne, getAll, runSql, pool };
