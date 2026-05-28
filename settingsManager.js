const { getOne, getAll, runSql } = require('./db');

let settingsCache = {};

const defaultSettings = {
  farm_crop_growth_time: 30,
  farm_crop_yield_base: 8,
  farm_crop_yield_step: 4,
  farm_cow_straw_time: 900,
  farm_cow_milk_time: 1800,
  farm_cage_max_animals: 8,
  market_cow_price: 200,
  market_rom_price: 5
};

async function loadSettings() {
  const rows = await getAll('SELECT key, value FROM settings');
  rows.forEach(row => {
    settingsCache[row.key] = row.value;
  });
  
  // Set defaults for missing settings
  Object.keys(defaultSettings).forEach(async key => {
    if (settingsCache[key] === undefined) {
      settingsCache[key] = defaultSettings[key];
      await runSql('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [key, defaultSettings[key].toString()]);
    }
  });
  console.log('Settings loaded:', settingsCache);
}

function getSetting(key, def) {
  if (settingsCache[key] !== undefined) {
    const val = settingsCache[key];
    // try to parse as float if it looks like a number
    if (!isNaN(val)) return parseFloat(val);
    return val;
  }
  return def !== undefined ? def : defaultSettings[key];
}

async function setSetting(key, value) {
  settingsCache[key] = value.toString();
  await runSql('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value.toString()]);
}

function getAllSettings() {
  const result = {};
  Object.keys(defaultSettings).forEach(key => {
    result[key] = getSetting(key);
  });
  return result;
}

module.exports = {
  loadSettings,
  getSetting,
  setSetting,
  getAllSettings
};
