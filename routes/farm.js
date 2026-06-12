const express = require('express');
const { getOne, getAll, runSql, logActivity } = require('../db');
const settingsManager = require('../settingsManager');
const { parseJSON, removeFromBackpack, getBackpackItemCount, addToBackpack } = require('../utils');
const { simulateCowProgress } = require('../cowSimulation');
const questManager = require('../questManager');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Chưa đăng nhập' });
  next();
}

function getUpgradeCost(level) {
  if (level < 1) return 100; // buy cost
  if (level === 1) return 10;
  
  let a = 10; // L1->L2
  let b = 20; // L2->L3
  if (level === 2) return b;
  
  for (let i = 3; i <= level; i++) {
    let temp = a + b;
    a = b;
    b = temp;
  }
  return b;
}

function getYield(level) {
  if (level < 1) return 0;
  const base = settingsManager.getSetting('farm_crop_yield_base', 8);
  const step = settingsManager.getSetting('farm_crop_yield_step', 4);
  return base + (level - 1) * step;
}

// ── GET /api/farm/visit/:username ──────────────────────────────────────────────
router.get('/visit/:username', requireAuth, async (req, res) => {
  const targetUsername = req.params.username;
  const targetUser = await getOne('SELECT id, display_name, username FROM users WHERE username = ?', [targetUsername]);
  
  if (!targetUser) return res.status(404).json({ error: 'Không tìm thấy người dùng' });
  
  let farm = await getOne('SELECT * FROM user_farms WHERE user_id = ?', [targetUser.id]);
  if (!farm) {
    farm = { level: 0, state: 'idle', animals: '[]' };
  }
  
  if (farm.state === 'growing' && farm.planted_at) {
    const diff = (new Date() - new Date(farm.planted_at + 'Z')) / 1000;
    const growthTime = settingsManager.getSetting('farm_crop_growth_time', 30);
    if (diff >= growthTime) {
      farm.state = 'ready'; // Visually ready for visitor
    }
  }

  res.json({
    user: { username: targetUser.username, displayName: targetUser.display_name || targetUser.username },
    farm: {
      level: farm.level,
      state: farm.state,
      plantedAt: farm.planted_at,
      yield: getYield(farm.level),
      animals: JSON.parse(farm.animals || '[]'),
      animals_data: JSON.parse(farm.animals_data || '[]'),
      cage_inventory: JSON.parse(farm.cage_inventory || '[null, null, null, null]')
    }
  });
});

// ── GET /api/farm ────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const userId = req.user.id;
  
  // Create farm record if not exists
  let farm = await getOne('SELECT * FROM user_farms WHERE user_id = ?', [userId]);
  if (!farm) {
    await runSql("INSERT INTO user_farms (user_id, level, state) VALUES (?, 0, 'idle')", [userId]);
    farm = await getOne('SELECT * FROM user_farms WHERE user_id = ?', [userId]);
  }
  
  // Calculate if ready
  if (farm.state === 'growing' && farm.planted_at) {
    const diff = (new Date() - new Date(farm.planted_at + 'Z')) / 1000;
    const growthTime = settingsManager.getSetting('farm_crop_growth_time', 30);
    if (diff >= growthTime) {
      await runSql("UPDATE user_farms SET state = 'ready' WHERE user_id = ?", [userId]);
      farm.state = 'ready';
    }
  }

  const inventory = await getAll('SELECT item_id, quantity FROM user_inventory WHERE user_id = ?', [userId]);
  
  const user = await getOne('SELECT xu, inventory_slots FROM users WHERE id = ?', [userId]);

  res.json({
    farm: {
      level: farm.level,
      state: farm.state,
      planted_at: farm.planted_at,
      yield: getYield(farm.level),
      upgradeCost: getUpgradeCost(farm.level),
      maxLevel: 50,
      animals: JSON.parse(farm.animals || '[]'),
      animals_data: JSON.parse(farm.animals_data || '[]'),
      cage_inventory: JSON.parse(farm.cage_inventory || '[null, null, null, null]'),
      cage_products: JSON.parse(farm.cage_products || '[]')
    },
    inventory,
    xu: user.xu,
    inventory_slots: user.inventory_slots || 5
  });
});

// ── POST /api/farm/buy ───────────────────────────────────────────────────────
router.post('/buy', requireAuth, async (req, res) => {
  const userId = req.user.id;
  // JOIN users + user_farms trong một round-trip
  const row = await getOne(
    'SELECT u.xu, f.level FROM users u LEFT JOIN user_farms f ON f.user_id = u.id WHERE u.id = ?',
    [userId]
  );
  const user = row;
  const farm = row;

  if (farm && farm.level > 0) return res.status(400).json({ error: 'Đã sở hữu ruộng' });
  if (!user || user.xu < 100) return res.status(400).json({ error: 'Không đủ xu (Cần 100 xu)' });
  
  await runSql('UPDATE users SET xu = xu - 100 WHERE id = ?', [userId]);
  await runSql("UPDATE user_farms SET level = 1, state = 'idle' WHERE user_id = ?", [userId]);
  
  // Log activity
  try {
    await logActivity(req.user.username, 'farming_buy_farm', 'Mua mảnh ruộng đầu tiên', -100);
  } catch (e) {}
  
  // Update quest progress for buying land
  await questManager.updateQuestProgress(userId, 'mua_ruong', 1);

  res.json({ message: 'Đã mua mảnh ruộng', farm: { level: 1, state: 'idle', planted_at: null }, xu: user.xu - 100 });
});

// ── POST /api/farm/upgrade ───────────────────────────────────────────────────
router.post('/upgrade', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const row = await getOne(
    'SELECT u.xu, f.level FROM users u LEFT JOIN user_farms f ON f.user_id = u.id WHERE u.id = ?',
    [userId]
  );
  const user = row;
  const farm = row;

  if (!farm || farm.level < 1) return res.status(400).json({ error: 'Chưa sở hữu ruộng' });
  if (farm.level >= 50) return res.status(400).json({ error: 'Ruộng đã đạt cấp tối đa' });
  
  const cost = getUpgradeCost(farm.level);
  if (user.xu < cost) return res.status(400).json({ error: `Không đủ xu (Cần ${cost} xu)` });
  
  await runSql('UPDATE users SET xu = xu - ? WHERE id = ?', [cost, userId]);
  await runSql('UPDATE user_farms SET level = level + 1 WHERE user_id = ?', [userId]);
  
  // Log activity
  try {
    await logActivity(req.user.username, 'farming_upgrade', `Nâng cấp ruộng lên Cấp ${farm.level + 1}`, -cost);
  } catch (e) {}
  
  res.json({ message: 'Nâng cấp thành công', farm: { level: farm.level + 1 }, xu: user.xu - cost });
});

// ── POST /api/farm/plant ─────────────────────────────────────────────────────
router.post('/plant', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const row = await getOne(
    'SELECT u.xu, f.level, f.state FROM users u LEFT JOIN user_farms f ON f.user_id = u.id WHERE u.id = ?',
    [userId]
  );
  const user = row;
  const farm = row;

  if (!farm || farm.level < 1) return res.status(400).json({ error: 'Chưa sở hữu ruộng' });
  if (farm.state !== 'idle') return res.status(400).json({ error: 'Ruộng đang không trống' });
  if (!user || user.xu < 10) return res.status(400).json({ error: 'Không đủ xu gieo hạt (Cần 10 xu)' });
  
  await runSql('UPDATE users SET xu = xu - 10 WHERE id = ?', [userId]);
  await runSql("UPDATE user_farms SET state = 'growing', planted_at = CURRENT_TIMESTAMP WHERE user_id = ?", [userId]);
  
  // Log activity
  try {
    await logActivity(req.user.username, 'farming_plant', 'Gieo hạt lúa', -10);
  } catch (e) {}
  
  // Update quest progress for planting (stage 1 of gieo_thu_hoach, cap at 1)
  await questManager.updateQuestProgress(userId, 'gieo_thu_hoach', 1, 1);

  // Lấy planted_at vừa ghi để trả về cho frontend cập nhật countdown
  const updatedFarm = await getOne("SELECT state, planted_at FROM user_farms WHERE user_id = ?", [userId]);
  res.json({ message: 'Đã gieo hạt', farm: { state: 'growing', planted_at: updatedFarm ? updatedFarm.planted_at : new Date().toISOString() } });
});

// ── POST /api/farm/harvest ───────────────────────────────────────────────────
router.post('/harvest', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const farm = await getOne('SELECT level, state, planted_at FROM user_farms WHERE user_id = ?', [userId]);
  
  if (!farm || farm.level < 1) return res.status(400).json({ error: 'Chưa sở hữu ruộng' });
  
  let isReady = farm.state === 'ready';
  if (farm.state === 'growing' && farm.planted_at) {
    const diff = (new Date() - new Date(farm.planted_at + 'Z')) / 1000;
    const growthTime = settingsManager.getSetting('farm_crop_growth_time', 30);
    if (diff >= growthTime) isReady = true;
  }
  
  if (!isReady) return res.status(400).json({ error: 'Lúa chưa chín' });
  
  const amount = getYield(farm.level);
  const user = await getOne('SELECT backpack FROM users WHERE id = ?', [userId]);
  
  let backpack = parseJSON(user.backpack, [null, null]);
  const addResult = addToBackpack(backpack, 'lua', amount, 2);
  
  if (!addResult.success) {
    return res.status(400).json({ error: 'Balo đã đầy!' });
  }
  
  // Gộp 2 UPDATE thành parallel execution
  await Promise.all([
    runSql("UPDATE users SET backpack = ? WHERE id = ?", [JSON.stringify(addResult.backpack), userId]),
    runSql("UPDATE user_farms SET state = 'idle', planted_at = NULL WHERE user_id = ?", [userId]),
  ]);
  
  // Log activity
  try {
    await logActivity(req.user.username, 'farming_harvest', `Thu hoạch thành công ${amount} lúa`);
  } catch (e) {}
  
  // Update quest progress for harvesting (stage 2 of gieo_thu_hoach, cap at 2)
  await questManager.updateQuestProgress(userId, 'gieo_thu_hoach', 1, 2);

  res.json({ message: `Thu hoạch thành công ${amount} lúa!`, backpack: addResult.backpack, farm: { state: 'idle', planted_at: null } });
});

// ── POST /api/farm/buy-slot ──────────────────────────────────────────────────
router.post('/buy-slot', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const user = await getOne('SELECT xu FROM users WHERE id = ?', [userId]);
  
  if (user.xu < 250) return res.status(400).json({ error: 'Không đủ xu (Cần 250 xu)' });
  
  await runSql('UPDATE users SET xu = xu - 250, inventory_slots = COALESCE(inventory_slots, 5) + 1 WHERE id = ?', [userId]);
  
  // Log activity
  try {
    await logActivity(req.user.username, 'farming_upgrade_backpack', 'Mua thêm 1 ô balo', -250);
  } catch (e) {}
  
  res.json({ message: 'Đã mua 1 ô túi đồ mới!' });
});

// ── POST /api/farm/place-animal ──────────────────────────────────────────────────
router.post('/place-animal', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { animal } = req.body;
  if (!animal) return res.status(400).json({ error: 'Vui lòng chọn vật nuôi' });
  
  const user = await getOne('SELECT backpack FROM users WHERE id = ?', [userId]);
  let backpack = parseJSON(user.backpack, [null, null]);
  let hasInBackpack = getBackpackItemCount(backpack, animal) > 0;
  
  let hasInInventory = false;
  if (!hasInBackpack) {
    const invItem = await getOne('SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, animal]);
    if (invItem && invItem.quantity > 0) hasInInventory = true;
  }
  
  if (!hasInBackpack && !hasInInventory) {
    return res.status(400).json({ error: 'Không có vật nuôi này trong balo hoặc kho' });
  }
  
  const farm = await getOne('SELECT level, animals, animals_data FROM user_farms WHERE user_id = ?', [userId]);
  if (!farm || farm.level < 1) return res.status(400).json({ error: 'Bạn cần mua ruộng trước khi thả vật nuôi' });
  
  let currentAnimals = parseJSON(farm.animals, []);
  const maxAnimals = settingsManager.getSetting('farm_cage_max_animals', 8);
  if (currentAnimals.length >= maxAnimals) {
    return res.status(400).json({ error: `Chuồng đã đầy (Tối đa ${maxAnimals} con)` });
  }
  
  let animalsData = parseJSON(farm.animals_data, []);
  currentAnimals.push(animal);
  animalsData.push({ type: animal, lastUpdateTime: Date.now(), milkProgress: 0, strawTimeRemaining: 0 });
  
  if (hasInBackpack) {
    backpack = removeFromBackpack(backpack, animal, 1).backpack;
    await runSql('UPDATE users SET backpack = ? WHERE id = ?', [JSON.stringify(backpack), userId]);
  } else {
    await runSql('UPDATE user_inventory SET quantity = quantity - 1 WHERE user_id = ? AND item_id = ?', [userId, animal]);
    // Clean up if 0
    const invItem = await getOne('SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, animal]);
    if (invItem && invItem.quantity <= 0) {
      await runSql('DELETE FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, animal]);
    }
  }
  
  // Add to farm
  await runSql('UPDATE user_farms SET animals = ?, animals_data = ? WHERE user_id = ?', [JSON.stringify(currentAnimals), JSON.stringify(animalsData), userId]);
  
  // Log activity
  try {
    await logActivity(req.user.username, 'farming_place_animal', `Thả 1 con ${animal} vào chuồng`);
  } catch (e) {}
  
  res.json({ message: 'Thả thú nuôi vào chuồng thành công!', backpack });
});

// ── POST /api/farm/sell-animals ────────────────────────────────────────────────
router.post('/sell-animals', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { indices } = req.body; // array of indices to sell
  
  if (!Array.isArray(indices) || indices.length === 0) {
    return res.status(400).json({ error: 'Chưa chọn con vật nào để bán' });
  }

  const farm = await getOne('SELECT animals, animals_data FROM user_farms WHERE user_id = ?', [userId]);
  if (!farm) return res.status(400).json({ error: 'Không tìm thấy trang trại' });

  let currentAnimals = parseJSON(farm.animals, []);
  let animalsData = parseJSON(farm.animals_data, []);
  
  // Sort indices descending to safely remove from array without messing up subsequent indices
  const sortedIndices = [...indices].sort((a, b) => b - a);
  
  let sellCount = 0;
  for (let i of sortedIndices) {
    if (i >= 0 && i < currentAnimals.length && animalsData[i]?.type === 'cow') {
      currentAnimals.splice(i, 1);
      animalsData.splice(i, 1);
      sellCount++;
    }
  }

  if (sellCount === 0) {
    return res.status(400).json({ error: 'Không có vật nuôi hợp lệ để bán' });
  }

  const totalEarned = sellCount * 150; // 75% of 200 xu
  
  // Update DB
  await runSql('UPDATE user_farms SET animals = ?, animals_data = ? WHERE user_id = ?', [JSON.stringify(currentAnimals), JSON.stringify(animalsData), userId]);
  await runSql('UPDATE users SET xu = xu + ? WHERE id = ?', [totalEarned, userId]);
  
  // Log activity
  try {
    await logActivity(req.user.username, 'farming_sell_animal', `Bán ${sellCount} con bò`, totalEarned);
  } catch (e) {}
  
  const user = await getOne('SELECT xu FROM users WHERE id = ?', [userId]);

  res.json({ message: `Bán thành công ${sellCount} con bò, thu về ${totalEarned} xu`, xu: user.xu });
});

// ── POST /api/farm/feed ────────────────────────────────────────────────────────
router.post('/feed', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Số lượng không hợp lệ' });

  const user = await getOne('SELECT backpack FROM users WHERE id = ?', [userId]);
  let backpack = parseJSON(user.backpack, [null, null]);
  const romCount = getBackpackItemCount(backpack, 'rom');
  const invRow = await getOne("SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = 'rom'", [userId]);
  const romInvCount = invRow ? invRow.quantity : 0;
  
  const takeAmount = Math.min(amount, romCount + romInvCount);
  if (takeAmount <= 0) return res.status(400).json({ error: 'Không có rơm trong balo hoặc kho' });

  const farm = await getOne('SELECT animals_data, cage_inventory, cage_products FROM user_farms WHERE user_id = ?', [userId]);
  if (!farm) return res.status(400).json({ error: 'Chưa có chuồng' });
  
  let animalsData = parseJSON(farm.animals_data, []);
  let cageInventory = parseJSON(farm.cage_inventory, [null, null, null, null]);
  let cageProducts = parseJSON(farm.cage_products, []);

  // Simulate progress BEFORE adding straw to prevent cows from consuming new straw retroactively
  const now = Date.now();
  const simulation = simulateCowProgress(animalsData, cageInventory, now);
  animalsData = simulation.animalsData;
  let cageInv = simulation.cageInventory;
  if (simulation.drops && simulation.drops.length > 0) {
    simulation.drops.forEach(d => cageProducts.push(d));
    await runSql('UPDATE user_farms SET cage_products = ? WHERE user_id = ?', [JSON.stringify(cageProducts), userId]);
  }
  
  let remainingToAdd = takeAmount;
  // Fill existing slots
  for (let i = 0; i < 4; i++) {
    if (cageInv[i] && cageInv[i].item_id === 'rom' && cageInv[i].quantity < 20) {
      let space = 20 - cageInv[i].quantity;
      let add = Math.min(remainingToAdd, space);
      cageInv[i].quantity += add;
      remainingToAdd -= add;
      if (remainingToAdd <= 0) break;
    }
  }
  
  // Fill empty slots
  if (remainingToAdd > 0) {
    for (let i = 0; i < 4; i++) {
      if (!cageInv[i]) {
        let add = Math.min(remainingToAdd, 20);
        cageInv[i] = { item_id: 'rom', quantity: add };
        remainingToAdd -= add;
        if (remainingToAdd <= 0) break;
      }
    }
  }
  
  const actualAdded = takeAmount - remainingToAdd;
  if (actualAdded <= 0) return res.status(400).json({ error: 'Chuồng đã đầy rơm' });
  
  // Deduct from backpack first, then inventory
  let toDeduct = actualAdded;
  if (romCount > 0) {
    const fromBp = Math.min(romCount, toDeduct);
    backpack = removeFromBackpack(backpack, 'rom', fromBp).backpack;
    await runSql('UPDATE users SET backpack = ? WHERE id = ?', [JSON.stringify(backpack), userId]);
    toDeduct -= fromBp;
  }
  if (toDeduct > 0) {
    await runSql('UPDATE user_inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ?', [toDeduct, userId, 'rom']);
    const invItem = await getOne('SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, 'rom']);
    if (invItem && invItem.quantity <= 0) {
      await runSql('DELETE FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, 'rom']);
    }
  }
  
  await runSql('UPDATE user_farms SET cage_inventory = ?, animals_data = ? WHERE user_id = ?', [JSON.stringify(cageInv), JSON.stringify(animalsData), userId]);
  
  // Log activity
  try {
    await logActivity(req.user.username, 'farming_feed', `Cho bò ăn ${actualAdded} rơm`);
  } catch (e) {}
  
  // Update quest progress for feeding cow
  await questManager.updateQuestProgress(userId, 'cho_bo_an', actualAdded);

  res.json({ message: `Đã bỏ ${actualAdded} rơm vào chuồng`, backpack, cage_inventory: cageInv });
});

// ── POST /api/farm/collect-cage-products ──────────────────────────────────────
router.post('/collect-cage-products', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const farm = await getOne('SELECT cage_products FROM user_farms WHERE user_id = ?', [userId]);
  if (!farm) return res.status(400).json({ error: 'Không tìm thấy nông trại' });

  let products = parseJSON(farm.cage_products, []);
  if (products.length === 0) {
    return res.status(400).json({ error: 'Không có sản phẩm nào để thu hoạch' });
  }

  const user = await getOne('SELECT backpack FROM users WHERE id = ?', [userId]);
  let backpack = parseJSON(user.backpack, [null, null]);

  // Count occurrences
  const counts = {};
  for (const p of products) {
    counts[p] = (counts[p] || 0) + 1;
  }

  let full = false;
  let remainingProducts = [];

  // Try to add to backpack
  for (const [item_id, quantity] of Object.entries(counts)) {
    const resAdd = addToBackpack(backpack, item_id, quantity);
    backpack = resAdd.backpack;
    if (resAdd.remaining > 0) {
      full = true;
      // Re-add the remaining to remainingProducts list
      for(let i=0; i<resAdd.remaining; i++) remainingProducts.push(item_id);
    }
  }

  // Update backpack
  await runSql('UPDATE users SET backpack = ? WHERE id = ?', [JSON.stringify(backpack), userId]);

  if (full && remainingProducts.length === products.length) {
     return res.status(400).json({ error: 'Balo đã đầy, không thể thu hoạch thêm!' });
  }

  // Update remaining products in cage
  await runSql('UPDATE user_farms SET cage_products = ? WHERE user_id = ?', [JSON.stringify(remainingProducts), userId]);
  
  // Log activity
  try {
    const collectedCount = products.length - remainingProducts.length;
    await logActivity(req.user.username, 'farming_gather', `Thu hoạch sữa bò (${collectedCount} bình sữa)`);
  } catch (e) {}

  if (full) {
    res.json({ message: `Balo đã đầy! Chỉ thu hoạch được một phần.`, counts, backpack });
  } else {
    res.json({ message: `Đã thu hoạch thành công các sản phẩm!`, counts, backpack });
  }
});

module.exports = router;
