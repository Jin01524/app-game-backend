const express = require('express');
const router = express.Router();
const { getOne, runSql } = require('../db');
const settingsManager = require('../settingsManager');
const { parseJSON, addToBackpack } = require('../utils');

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Helper to get or calculate current market state
async function getMarketState() {
  let priceRow = await getOne("SELECT value FROM settings WHERE key = 'market_rice_price'");
  let lastUpdateRow = await getOne("SELECT value FROM settings WHERE key = 'market_last_update'");

  let price = priceRow ? parseInt(priceRow.value) : null;
  let lastUpdate = lastUpdateRow ? parseInt(lastUpdateRow.value) : null;
  
  const now = Date.now();

  // Initialize or Update price if it's been more than 6 hours
  if (!price || !lastUpdate || now - lastUpdate >= UPDATE_INTERVAL_MS) {
    // Generate new price between 5 and 20
    price = Math.floor(Math.random() * (20 - 5 + 1)) + 5;
    
    // Calculate new base time (snap to exact 6 hour intervals to avoid drift, or just use now)
    // Using `now` is simpler.
    lastUpdate = now;

    await runSql("INSERT INTO settings (key, value) VALUES ('market_rice_price', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [price.toString()]);
    await runSql("INSERT INTO settings (key, value) VALUES ('market_last_update', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [lastUpdate.toString()]);
  }

  const nextUpdate = lastUpdate + UPDATE_INTERVAL_MS;
  const timeRemainingMs = Math.max(0, nextUpdate - now);

  return { price, nextUpdate, timeRemainingMs };
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

  // Check inventory
  const item = await getOne('SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, 'lua']);
  if (!item || item.quantity < sellQty) {
    return res.status(400).json({ error: 'Không đủ lúa để bán' });
  }

  const market = await getMarketState();
  const totalEarned = sellQty * market.price;

  // Deduct item
  await runSql('UPDATE user_inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ?', [sellQty, userId, 'lua']);
  
  // Add money
  await runSql('UPDATE users SET xu = xu + ? WHERE id = ?', [totalEarned, userId]);

  // Clean up inventory if zero
  const updatedItem = await getOne('SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, 'lua']);
  if (updatedItem && updatedItem.quantity <= 0) {
    await runSql('DELETE FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, 'lua']);
  }

  // Get new user state
  const user = await getOne('SELECT xu FROM users WHERE id = ?', [userId]);

  res.json({ success: true, earned: totalEarned, currentXu: user.xu });
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

  res.json({ message: `Mua ${quantity} ${itemId} thành công!`, xu: user.xu - cost, backpack: result.backpack });
});

module.exports = router;
