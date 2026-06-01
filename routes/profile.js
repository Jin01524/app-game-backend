const express = require('express');
const bcrypt = require('bcryptjs');
const { getOne, getAll, runSql, logActivity } = require('../db');
const { parseJSON, addToBackpack, removeFromBackpack } = require('../utils');
const questManager = require('../questManager');

const router = express.Router();

// Middleware: verify JWT (imported from auth.js pattern — reuse via req.user set by parent)
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Chưa đăng nhập' });
  next();
}

/**
 * PUT /api/profile/avatar
 * Body: { avatar: "data:image/...;base64,..." }
 * Stores base64 avatar string directly in DB (max ~500KB recommended)
 */
router.put('/avatar', requireAuth, async (req, res) => {
  const { avatar } = req.body;

  if (!avatar) {
    return res.status(400).json({ error: 'Thiếu dữ liệu ảnh đại diện' });
  }

  // Basic validation — must be a data URL
  if (!avatar.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Định dạng ảnh không hợp lệ' });
  }

  // Rough size check: base64 string > ~700KB → reject
  if (avatar.length > 700000) {
    return res.status(400).json({ error: 'Ảnh quá lớn (tối đa ~500KB)' });
  }

  await runSql('UPDATE users SET avatar = ? WHERE id = ?', [avatar, req.user.id]);

  const updated = await getOne('SELECT id, username, display_name, avatar, created_at FROM users WHERE id = ?', [req.user.id]);
  res.json({
    message: 'Cập nhật ảnh đại diện thành công',
    avatar: updated.avatar,
  });
});

/**
 * DELETE /api/profile/avatar
 * Removes avatar (reset to default)
 */
router.delete('/avatar', requireAuth, async (req, res) => {
  await runSql('UPDATE users SET avatar = NULL WHERE id = ?', [req.user.id]);
  res.json({ message: 'Đã xóa ảnh đại diện' });
});

/**
 * PUT /api/profile/password
 * Body: { currentPassword, newPassword }
 */
router.put('/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 6 ký tự' });
  }

  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'Mật khẩu mới phải khác mật khẩu hiện tại' });
  }

  const user = await getOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user) {
    return res.status(404).json({ error: 'Người dùng không tồn tại' });
  }

  const isCurrentValid = bcrypt.compareSync(currentPassword, user.password_hash);
  if (!isCurrentValid) {
    return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng' });
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  await runSql('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.user.id]);

  res.json({ message: 'Đổi mật khẩu thành công' });
});

/**
 * POST /api/profile/game/score
 * Body: { goals: number }
 * Adds 2 xu per goal to the user's account.
 */
router.post('/game/score', requireAuth, async (req, res) => {
  const { goals } = req.body;
  if (typeof goals !== 'number' || goals <= 0 || goals > 100) {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  }

  const xuEarned = goals * 2;
  await runSql('UPDATE users SET xu = xu + ? WHERE id = ?', [xuEarned, req.user.id]);
  
  // Log activity
  try {
    await logActivity(req.user.username, 'game_play', `Chơi sút bóng đạt ${goals} bàn thắng`, xuEarned);
  } catch (e) {}
  
  // Update quest progress for sút bóng
  await questManager.updateQuestProgress(req.user.id, 'sut_bong', xuEarned);

  const user = await getOne('SELECT xu FROM users WHERE id = ?', [req.user.id]);
  res.json({ message: 'OK', xu: user.xu, earned: xuEarned });
});

/**
 * GET /api/profile/game/settings
 * Get current game settings
 */
router.get('/game/settings', requireAuth, async (req, res) => {
  const settingsRows = await require('../db').getAll('SELECT key, value FROM settings');
  const settings = {};
  settingsRows.forEach(r => settings[r.key] = parseFloat(r.value) || r.value);
  
  // Apply defaults if missing
  if (!settings.gkBaseSpeed) settings.gkBaseSpeed = 1.2;
  if (!settings.goalWidth) settings.goalWidth = 80;
  if (!settings.aimSpeed) settings.aimSpeed = 2.0;

  res.json(settings);
});

/**
 * GET /api/profile/users/status
 * Get online status of all users
 */
router.get('/users/status', requireAuth, async (req, res) => {
  const { getAll } = require('../db');
  const users = await getAll('SELECT id, username, display_name, avatar, last_online FROM users ORDER BY last_online DESC NULLS LAST');
  res.json(users);
});

/**
 * POST /api/profile/character
 * Body: { headColor, hairColor, bodyColor, legsColor, shoeColor }
 */
router.post('/character', requireAuth, async (req, res) => {
  const { headColor, hairColor, bodyColor, legsColor, shoeColor } = req.body;
  
  // Basic validation (hex colors)
  const hexRegex = /^#([0-9A-F]{3}){1,2}$/i;
  const hd = hexRegex.test(headColor) ? headColor : '#ffccaa';
  const hr = hexRegex.test(hairColor) ? hairColor : '#8b4513';
  const bd = hexRegex.test(bodyColor) ? bodyColor : '#3b82f6';
  const lg = hexRegex.test(legsColor) ? legsColor : '#1e293b';
  const sh = hexRegex.test(shoeColor) ? shoeColor : '#000000';

  await runSql(
    'UPDATE users SET char_head_color = ?, char_hair_color = ?, char_body_color = ?, char_legs_color = ?, char_shoe_color = ? WHERE id = ?',
    [hd, hr, bd, lg, sh, req.user.id]
  );

  res.json({ message: 'Đã lưu cấu hình nhân vật' });
});

/**
 * POST /api/profile/transfer
 * Body: { itemId: string, amount: number, direction: 'to_backpack' | 'to_storage' }
 */
router.post('/transfer', requireAuth, async (req, res) => {
  const { itemId, amount, direction } = req.body;
  if (!itemId || !amount || amount <= 0) return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });

  const userId = req.user.id;
  const user = await getOne('SELECT backpack, inventory_slots FROM users WHERE id = ?', [userId]);
  let backpack = parseJSON(user.backpack, [null, null]);

  if (direction === 'to_backpack') {
    const invItem = await getOne('SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, itemId]);
    if (!invItem || invItem.quantity <= 0) return res.status(400).json({ error: 'Không có vật phẩm trong kho' });
    
    const takeAmount = Math.min(amount, invItem.quantity);
    const result = addToBackpack(backpack, itemId, takeAmount);
    
    const actualTaken = takeAmount - result.remaining;
    if (actualTaken <= 0) return res.status(400).json({ error: 'Balo đã đầy hoặc không chứa được thêm' });
    
    backpack = result.backpack;
    await runSql('UPDATE users SET backpack = ? WHERE id = ?', [JSON.stringify(backpack), userId]);
    
    if (invItem.quantity === actualTaken) {
      await runSql('DELETE FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, itemId]);
    } else {
      await runSql('UPDATE user_inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ?', [actualTaken, userId, itemId]);
    }
    
    res.json({ message: `Đã chuyển ${actualTaken} vật phẩm vào balo`, backpack });
  } else if (direction === 'to_storage') {
    // Count BEFORE removing (removeFromBackpack mutates the array in-place)
    const countBefore = backpack.reduce((sum, slot) => sum + (slot && slot.item_id === itemId ? slot.quantity : 0), 0);
    const removeResult = removeFromBackpack(backpack, itemId, amount);
    backpack = removeResult.backpack;
    const countAfter = backpack.reduce((sum, slot) => sum + (slot && slot.item_id === itemId ? slot.quantity : 0), 0);
    const actualRemoved = countBefore - countAfter;
    
    if (actualRemoved <= 0) return res.status(400).json({ error: 'Không có vật phẩm trong balo' });
    
    const invItem = await getOne('SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, itemId]);
    // Check storage limits
    const slots = user.inventory_slots || 5;
    const allItems = await getAll('SELECT item_id, quantity FROM user_inventory WHERE user_id = ?', [userId]);
    let usedSlots = allItems.length;
    
    const hasItem = allItems.some(i => i.item_id === itemId);
    if (!hasItem && usedSlots >= slots) {
      return res.status(400).json({ error: 'Kho đã đầy, không thể cất thêm' });
    }
    
    await runSql('UPDATE users SET backpack = ? WHERE id = ?', [JSON.stringify(backpack), userId]);
    if (invItem) {
      await runSql('UPDATE user_inventory SET quantity = quantity + ? WHERE user_id = ? AND item_id = ?', [actualRemoved, userId, itemId]);
    } else {
      await runSql('INSERT INTO user_inventory (user_id, item_id, quantity) VALUES (?, ?, ?)', [userId, itemId, actualRemoved]);
    }
    
    res.json({ message: `Đã cất ${actualRemoved} vật phẩm vào kho`, backpack });
  } else {
    res.status(400).json({ error: 'Hành động không hợp lệ' });
  }
});

/**
 * POST /api/profile/discard
 * Body: { itemId: string, amount: number, source: 'backpack' | 'storage' }
 */
router.post('/discard', requireAuth, async (req, res) => {
  const { itemId, amount, source } = req.body;
  if (!itemId || !amount || amount <= 0) return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });

  const userId = req.user.id;
  if (source === 'backpack') {
    const user = await getOne('SELECT backpack FROM users WHERE id = ?', [userId]);
    let backpack = parseJSON(user.backpack, [null, null]);
    
    const countBefore = backpack.reduce((sum, slot) => sum + (slot && slot.item_id === itemId ? slot.quantity : 0), 0);
    const takeAmount = Math.min(amount, countBefore);
    if (takeAmount <= 0) return res.status(400).json({ error: 'Không có vật phẩm để vứt' });
    
    backpack = removeFromBackpack(backpack, itemId, takeAmount).backpack;
    await runSql('UPDATE users SET backpack = ? WHERE id = ?', [JSON.stringify(backpack), userId]);
    res.json({ message: `Đã vứt ${takeAmount} vật phẩm`, backpack });
  } else if (source === 'storage') {
    const invItem = await getOne('SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, itemId]);
    if (!invItem || invItem.quantity <= 0) return res.status(400).json({ error: 'Không có vật phẩm trong kho' });
    
    const takeAmount = Math.min(amount, invItem.quantity);
    if (invItem.quantity === takeAmount) {
      await runSql('DELETE FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, itemId]);
    } else {
      await runSql('UPDATE user_inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ?', [takeAmount, userId, itemId]);
    }
    res.json({ message: `Đã vứt ${takeAmount} vật phẩm` });
  } else {
    res.status(400).json({ error: 'Nguồn không hợp lệ' });
  }
});

/**
 * POST /api/profile/trade/item
 * Body: { targetUsername: string, itemId: string, amount: number }
 */
router.post('/trade/item', requireAuth, async (req, res) => {
  const { targetUsername, itemId, amount } = req.body;
  const parsedAmount = parseInt(amount, 10);
  if (!targetUsername || !itemId || !parsedAmount || !Number.isInteger(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  }

  const { getOne, runSql } = require('../db');
  
  if (targetUsername === req.user.username) {
    return res.status(400).json({ error: 'Không thể giao dịch với chính mình' });
  }

  const targetUser = await getOne('SELECT id, backpack, inventory_slots FROM users WHERE username = ?', [targetUsername]);
  if (!targetUser) return res.status(404).json({ error: 'Không tìm thấy người chơi' });
  const targetMaxSlots = targetUser.inventory_slots || 5;

  const senderId = req.user.id;
  const sender = await getOne('SELECT backpack, inventory_slots FROM users WHERE id = ?', [senderId]);
  const senderMaxSlots = sender.inventory_slots || 5;
  let senderBackpack = parseJSON(sender.backpack, Array(senderMaxSlots).fill(null));

  // Check sender items
  const countBefore = senderBackpack.reduce((sum, slot) => sum + (slot && slot.item_id === itemId ? slot.quantity : 0), 0);
  const takeAmount = Math.min(parsedAmount, countBefore);
  if (takeAmount <= 0) return res.status(400).json({ error: 'Không có đủ vật phẩm trong balo' });

  // Remove from sender
  const removeResult = removeFromBackpack(senderBackpack, itemId, takeAmount);
  senderBackpack = removeResult.backpack;

  // Add to target
  let targetBackpack = parseJSON(targetUser.backpack, Array(targetMaxSlots).fill(null));
  const addResult = addToBackpack(targetBackpack, itemId, takeAmount, targetMaxSlots);
  
  const actualTransferred = takeAmount - addResult.remaining;
  if (actualTransferred <= 0) {
    return res.status(400).json({ error: 'Balo người nhận đã đầy' });
  }

  // If actualTransferred < takeAmount, give back remaining to sender
  if (addResult.remaining > 0) {
    senderBackpack = addToBackpack(senderBackpack, itemId, addResult.remaining, senderMaxSlots).backpack;
  }

  targetBackpack = addResult.backpack;

  await runSql('UPDATE users SET backpack = ? WHERE id = ?', [JSON.stringify(senderBackpack), senderId]);
  await runSql('UPDATE users SET backpack = ? WHERE id = ?', [JSON.stringify(targetBackpack), targetUser.id]);

  res.json({ message: `Đã gửi ${actualTransferred} vật phẩm cho ${targetUsername}`, backpack: senderBackpack });
});

/**
 * POST /api/profile/trade/xu
 * Body: { targetUsername: string, amount: number }
 */
router.post('/trade/xu', requireAuth, async (req, res) => {
  const { targetUsername, amount } = req.body;
  const parsedAmount = parseInt(amount, 10);
  if (!targetUsername || !parsedAmount || !Number.isInteger(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  }

  const { getOne, runSql } = require('../db');
  
  if (targetUsername === req.user.username) {
    return res.status(400).json({ error: 'Không thể giao dịch với chính mình' });
  }

  const targetUser = await getOne('SELECT id FROM users WHERE username = ?', [targetUsername]);
  if (!targetUser) return res.status(404).json({ error: 'Không tìm thấy người chơi' });

  const senderId = req.user.id;
  const sender = await getOne('SELECT xu FROM users WHERE id = ?', [senderId]);

  if (sender.xu < parsedAmount) {
    return res.status(400).json({ error: 'Không đủ xu' });
  }

  await runSql('UPDATE users SET xu = xu - ? WHERE id = ?', [parsedAmount, senderId]);
  await runSql('UPDATE users SET xu = xu + ? WHERE id = ?', [parsedAmount, targetUser.id]);
  
  // Log activity
  try {
    await logActivity(req.user.username, 'coin_transfer_send', `Chuyển ${parsedAmount} xu cho người dùng ${targetUsername}`, -parsedAmount);
    await logActivity(targetUsername, 'coin_transfer_receive', `Nhận ${parsedAmount} xu từ người dùng ${req.user.username}`, parsedAmount);
  } catch (e) {}

  const newSenderXu = sender.xu - parsedAmount;
  res.json({ message: `Đã gửi ${parsedAmount} xu cho ${targetUsername}`, xu: newSenderXu });
});

/**
 * POST /api/profile/log-utility
 * Body: { utilityKey, utilityName }
 */
router.post('/log-utility', requireAuth, async (req, res) => {
  const { utilityKey, utilityName } = req.body;
  if (!utilityKey || !utilityName) {
    return res.status(400).json({ error: 'Thiếu thông tin tiện ích' });
  }
  try {
    await logActivity(req.user.username, 'utility_access', `Truy cập tiện ích: ${utilityName}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Lỗi ghi log' });
  }
});

// ── Google Photos Scraper & Sync Utilities ──────────────────────────────────
const { extractAlbum } = require('gphotos-scraper');
const albumUrl = "https://photos.google.com/share/AF1QipMKAT4_MsLhIA5kdLquRrYnMr-qj7sR49XVD-G2BwMqBlLTrEG2UQkhcb5FtkwJvQ?key=cnczbzRqOHhhNjl0Vm5PbkNIaVVrY2ZZLWVQLWhR";

const LOCATION_RULES = [
  { start: "26/04/2026", end: "27/04/2026", location: "Kon Tum" },
  { start: "28/04/2026", end: "31/12/2026", location: "Đà Nẵng" }
];

function parseDate(dateStr) {
  if (!dateStr || dateStr === "Không rõ") return null;
  const parts = dateStr.split(" ")[0].split("/");
  if (parts.length < 3) return null;
  return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
}

function getMappedLocation(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return null;
  for (const rule of LOCATION_RULES) {
    const start = parseDate(rule.start);
    const end = parseDate(rule.end);
    if (start && end && d >= start && d <= end) {
      return rule.location;
    }
  }
  return null;
}

/**
 * GET /api/profile/photos
 * Returns the cached photos album list from DB
 */
router.get('/photos', requireAuth, async (req, res) => {
  try {
    const row = await getOne("SELECT value FROM settings WHERE key = 'photos_album_data'");
    if (row && row.value) {
      return res.json(JSON.parse(row.value));
    }
    res.json([]);
  } catch (e) {
    console.error('Fetch photos error:', e);
    res.status(500).json({ error: 'Lỗi lấy album ảnh từ database' });
  }
});

/**
 * POST /api/profile/photos/sync
 * Scrapes Google Photos shared album and updates DB cache using gphotos-scraper
 */
router.post('/photos/sync', requireAuth, async (req, res) => {
  try {
    const album = await extractAlbum(albumUrl);
    if (!album || !album.photos || album.photos.length === 0) {
      return res.status(400).json({ error: 'Không tìm thấy ảnh nào trong album để đồng bộ' });
    }

    const photos = album.photos.map(p => {
      const isVideo = p.mimeType && p.mimeType.startsWith('video/');
      const dateStr = p.createdAt 
        ? (new Date(p.createdAt).toLocaleDateString('vi-VN') + ' ' + new Date(p.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false })) 
        : "Không rõ";
      const location = getMappedLocation(dateStr);
      return {
        id: p.id,
        url: p.url,
        date: dateStr,
        isVideo: !!isVideo,
        location: location
      };
    });
    
    await runSql(
      "INSERT INTO settings (key, value) VALUES ('photos_album_data', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [JSON.stringify(photos)]
    );
    
    // Log activity
    await logActivity(
      req.user.username,
      'utility_sync_photos',
      `Đồng bộ album kỷ niệm Google Photos thành công: ${photos.length} ảnh/video`
    );
    
    res.json({ success: true, count: photos.length, photos });
  } catch (e) {
    console.error('Photos sync error:', e);
    res.status(500).json({ error: e.message || 'Lỗi đồng bộ album' });
  }
});

module.exports = router;
