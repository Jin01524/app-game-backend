const express = require('express');
const router = express.Router();
const { getOne, runSql, logActivity } = require('../db');
const settingsManager = require('../settingsManager');
const { parseJSON, addToBackpack, getBackpackItemCount, removeFromBackpack } = require('../utils');
const questManager = require('../questManager');

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// In-memory cache — giá chỉ đổi mỗi 6 tiếng, không cần query DB mỗi request
let marketCache = null;
let marketCacheTime = 0;

// Helper to get or calculate current market state
async function getMarketState() {
  const now = Date.now();

  // Trả về cache nếu còn hiệu lực
  if (marketCache && now - marketCacheTime < UPDATE_INTERVAL_MS) {
    return marketCache;
  }

  let priceRow = await getOne("SELECT value FROM settings WHERE key = 'market_rice_price'");
  let lastUpdateRow = await getOne("SELECT value FROM settings WHERE key = 'market_last_update'");

  let price = priceRow ? parseInt(priceRow.value) : null;
  let lastUpdate = lastUpdateRow ? parseInt(lastUpdateRow.value) : null;

  // Initialize or Update price if it's been more than 6 hours
  if (!price || !lastUpdate || now - lastUpdate >= UPDATE_INTERVAL_MS) {
    price = Math.floor(Math.random() * (20 - 5 + 1)) + 5;
    lastUpdate = now;
    await runSql("INSERT INTO settings (key, value) VALUES ('market_rice_price', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [price.toString()]);
    await runSql("INSERT INTO settings (key, value) VALUES ('market_last_update', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [lastUpdate.toString()]);
  }

  const nextUpdate = lastUpdate + UPDATE_INTERVAL_MS;
  const timeRemainingMs = Math.max(0, nextUpdate - now);

  const result = { price, nextUpdate, timeRemainingMs };
  // Lưu vào cache
  marketCache = result;
  marketCacheTime = now;
  return result;
}

router.get('/', async (req, res) => {
  const market = await getMarketState();
  res.json({ market });
});

router.post('/sell', async (req, res) => {
  const userId = req.user.id;
  const { quantity } = req.body;
  const sellQty = parseInt(quantity);

  if (!sellQty || sellQty <= 0) {
    return res.status(400).json({ error: 'Số lượng không hợp lệ' });
  }

  // Lấy market state trước (đã cache, không query DB nếu còn hiệu lực)
  const market = await getMarketState();

  // 1. Get warehouse storage quantity of lúa
  const storageItem = await getOne('SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, 'lua']);
  const storageQty = storageItem ? storageItem.quantity : 0;

  // 2. Get backpack quantity of lúa
  const user = await getOne('SELECT backpack, xu FROM users WHERE id = ?', [userId]);
  const backpack = parseJSON(user.backpack, [null, null]);
  const backpackQty = getBackpackItemCount(backpack, 'lua');

  // 3. Check if total is sufficient
  const totalQty = storageQty + backpackQty;
  if (totalQty < sellQty) {
    return res.status(400).json({ error: 'Không đủ lúa để bán' });
  }

  // 4. Perform deductions
  let remainingToDeduct = sellQty;
  let newStorageQty = storageQty;
  let newBackpack = [...backpack];

  if (newStorageQty > 0) {
    const deductFromStorage = Math.min(remainingToDeduct, newStorageQty);
    newStorageQty -= deductFromStorage;
    remainingToDeduct -= deductFromStorage;
  }

  if (remainingToDeduct > 0) {
    const removeResult = removeFromBackpack(newBackpack, 'lua', remainingToDeduct);
    newBackpack = removeResult.backpack;
  }

  // 5. Update database - Warehouse storage
  if (newStorageQty <= 0) {
    await runSql('DELETE FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, 'lua']);
  } else {
    await runSql('UPDATE user_inventory SET quantity = ? WHERE user_id = ? AND item_id = ?', [newStorageQty, userId, 'lua']);
  }

  // 6. Update database - Backpack & xu trong một lần UPDATE
  const totalEarned = sellQty * market.price;
  await runSql('UPDATE users SET backpack = ?, xu = xu + ? WHERE id = ?', [JSON.stringify(newBackpack), totalEarned, userId]);

  // Log activity
  try {
    await logActivity(req.user.username, 'market_sell', `Bán ${sellQty} lúa với giá ${market.price} xu/lúa`, totalEarned);
  } catch (e) {}

  // Update quest progress for selling wheat
  await questManager.updateQuestProgress(userId, 'ban_lua', sellQty);

  res.json({ success: true, earned: totalEarned, currentXu: (user.xu ?? 0) + totalEarned });
});

router.post('/buy-animal', async (req, res) => {
  const userId = req.user.id;
  const { animal } = req.body;
  if (animal !== 'cow') return res.status(400).json({ error: 'Động vật không hợp lệ' });

  const user = await getOne('SELECT xu, backpack FROM users WHERE id = ?', [userId]);
  const cowPrice = settingsManager.getSetting('market_cow_price', 200);
  if (user.xu < cowPrice) return res.status(400).json({ error: `Không đủ xu (Cần ${cowPrice} xu)` });

  let backpack = parseJSON(user.backpack, [null, null]);
  const result = addToBackpack(backpack, animal, 1, 2);
  if (!result.success) {
    return res.status(400).json({ error: 'Balo đã đầy!' });
  }

  // Deduct Xu and save backpack
  await runSql('UPDATE users SET xu = xu - ?, backpack = ? WHERE id = ?', [cowPrice, JSON.stringify(result.backpack), userId]);
  
  // Log activity
  try {
    await logActivity(req.user.username, 'market_buy_animal', 'Mua 1 con bò ở chợ', -cowPrice);
  } catch (e) {}

  // Update quest progress for buying cow
  await questManager.updateQuestProgress(userId, 'mua_bo', 1);

  res.json({ message: 'Mua bò thành công!', xu: user.xu - cowPrice, backpack: result.backpack });
});

router.post('/buy-item', async (req, res) => {
  const userId = req.user.id;
  const { itemId, quantity } = req.body;
  
  if (itemId !== 'rom' || !quantity || quantity <= 0) {
    return res.status(400).json({ error: 'Vật phẩm hoặc số lượng không hợp lệ' });
  }

  const romPrice = settingsManager.getSetting('market_rom_price', 5);
  const cost = quantity * romPrice;
  const user = await getOne('SELECT xu, backpack FROM users WHERE id = ?', [userId]);
  if (user.xu < cost) return res.status(400).json({ error: `Không đủ xu (Cần ${cost} xu)` });

  let backpack = parseJSON(user.backpack, [null, null]);
  const result = addToBackpack(backpack, itemId, quantity, 2);
  if (!result.success) {
    return res.status(400).json({ error: `Balo không đủ chỗ chứa ${quantity} vật phẩm này!` });
  }

  // Deduct Xu and save backpack
  await runSql('UPDATE users SET xu = xu - ?, backpack = ? WHERE id = ?', [cost, JSON.stringify(result.backpack), userId]);
  
  // Log activity
  try {
    await logActivity(req.user.username, 'market_buy_item', `Mua ${quantity} rơm ở chợ`, -cost);
  } catch (e) {}

  res.json({ message: `Mua ${quantity} ${itemId} thành công!`, xu: user.xu - cost, backpack: result.backpack });
});

module.exports = router;
