const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'database.sqlite');
let db = null;

async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
    console.log('📦 Loaded existing database.');
  } else {
    db = new SQL.Database();
    console.log('📦 Created new database.');
  }

  // Create table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      avatar TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      xu INTEGER NOT NULL DEFAULT 0,
      last_online DATETIME,
      inventory_slots INTEGER NOT NULL DEFAULT 5,
      char_head_color TEXT DEFAULT '#ffccaa',
      char_hair_color TEXT DEFAULT '#8b4513',
      char_body_color TEXT DEFAULT '#3b82f6',
      char_legs_color TEXT DEFAULT '#1e293b',
      char_shoe_color TEXT DEFAULT '#000000',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_farms (
      user_id INTEGER PRIMARY KEY,
      level INTEGER DEFAULT 0,
      state TEXT DEFAULT 'idle',
      planted_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_inventory (
      user_id INTEGER,
      item_id TEXT,
      quantity INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, item_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Default settings
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('gkBaseSpeed', '1.2')`);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('goalWidth', '80')`);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('aimSpeed', '2.0')`);

  // Migrations
  for (const [col, def] of [
    ['avatar', 'TEXT'],
    ['role', "TEXT NOT NULL DEFAULT 'user'"],
    ['xu',   'INTEGER NOT NULL DEFAULT 0'],
    ['last_online', 'DATETIME'],
    ['inventory_slots', 'INTEGER NOT NULL DEFAULT 5'],
    ['char_head_color', "TEXT DEFAULT '#ffccaa'"],
    ['char_hair_color', "TEXT DEFAULT '#8b4513'"],
    ['char_body_color', "TEXT DEFAULT '#3b82f6'"],
    ['char_legs_color', "TEXT DEFAULT '#1e293b'"],
    ['char_shoe_color', "TEXT DEFAULT '#000000'"],
    ['backpack', "TEXT DEFAULT '[null, null]'"],
  ]) {
    try { db.run(`ALTER TABLE users ADD COLUMN ${col} ${def}`); console.log(`🔄 Migrated: added ${col} column to users.`); }
    catch { /* already exists */ }
  }

  try { db.run(`ALTER TABLE user_farms ADD COLUMN animals TEXT DEFAULT '[]'`); console.log(`🔄 Migrated: added animals column to user_farms.`); }
  catch { /* already exists */ }

  try { db.run(`ALTER TABLE user_farms ADD COLUMN cage_inventory TEXT DEFAULT '[null, null, null, null]'`); console.log(`🔄 Migrated: added cage_inventory column to user_farms.`); }
  catch { /* already exists */ }

  try { db.run(`ALTER TABLE user_farms ADD COLUMN animals_data TEXT DEFAULT '[]'`); console.log(`🔄 Migrated: added animals_data column to user_farms.`); }
  catch { /* already exists */ }

  try { db.run(`ALTER TABLE user_farms ADD COLUMN cage_products TEXT DEFAULT '[]'`); console.log(`🔄 Migrated: added cage_products column to user_farms.`); }
  catch { /* already exists */ }

  await seedUsers();
  persistDb();
  return db;
}

function persistDb() {
  if (!db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
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
    const exists = db.exec('SELECT id FROM users WHERE username = ?', [acc.username]);
    if (exists.length && exists[0].values.length) {
      console.log(`⏭️  User exists: ${acc.username}`);
      continue;
    }
    const hash = bcrypt.hashSync(acc.password, 10);
    db.run('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)',
      [acc.username, hash, acc.displayName, acc.role]);
    console.log(`✅ Seeded ${acc.role}: ${acc.username}`);
  }
}

function getOne(sql, params = []) {
  const res = db.exec(sql, params);
  if (!res.length || !res[0].values.length) return null;
  const cols = res[0].columns;
  return Object.fromEntries(cols.map((c, i) => [c, res[0].values[0][i]]));
}

function getAll(sql, params = []) {
  const res = db.exec(sql, params);
  if (!res.length) return [];
  const cols = res[0].columns;
  return res[0].values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
}

function runSql(sql, params = []) {
  db.run(sql, params);
  persistDb();
}

module.exports = { initDb, getOne, getAll, runSql };
