const express = require('express');
const bcrypt = require('bcryptjs');
const { getOne, getAll, runSql, logActivity, decayUserEnergy } = require('../db');
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
 * POST /api/profile/character-type
 * Body: { characterType }
 */
router.post('/character-type', requireAuth, async (req, res) => {
  const { characterType } = req.body;
  if (!characterType) {
    return res.status(400).json({ error: 'Thiếu loại nhân vật' });
  }
  const allowed = ['FrogNinja', 'PinkMan', 'MaskDude', 'VirtualGuy'];
  if (!allowed.includes(characterType)) {
    return res.status(400).json({ error: 'Loại nhân vật không hợp lệ' });
  }

  await runSql('UPDATE users SET character_type = ? WHERE id = ?', [characterType, req.user.id]);
  res.json({ message: 'Đổi nhân vật thành công', characterType });
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
    const result = addToBackpack(backpack, itemId, takeAmount, 2);
    
    const actualTaken = takeAmount - result.remaining;
    if (actualTaken <= 0) return res.status(400).json({ error: 'Balo đã đầy hoặc không chứa được thêm' });
    
    backpack = result.backpack;
    await runSql('UPDATE users SET backpack = ? WHERE id = ?', [JSON.stringify(backpack), userId]);
    
    if (invItem.quantity === actualTaken) {
      await runSql('DELETE FROM user_inventory WHERE user_id = ? AND item_id = ?', [userId, itemId]);
    } else {
      await runSql('UPDATE user_inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ?', [actualTaken, userId, itemId]);
    }
    
    const newInventory = await getAll('SELECT item_id, quantity FROM user_inventory WHERE user_id = ?', [userId]);
    res.json({ message: `Đã chuyển ${actualTaken} vật phẩm vào balo`, backpack, inventory: newInventory });
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
    
    const newInventory = await getAll('SELECT item_id, quantity FROM user_inventory WHERE user_id = ?', [userId]);
    res.json({ message: `Đã cất ${actualRemoved} vật phẩm vào kho`, backpack, inventory: newInventory });
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
    const newInventory = await getAll('SELECT item_id, quantity FROM user_inventory WHERE user_id = ?', [userId]);
    res.json({ message: `Đã vứt ${takeAmount} vật phẩm`, inventory: newInventory });
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
  const targetMaxSlots = 2;

  const senderId = req.user.id;
  const sender = await getOne('SELECT backpack, inventory_slots FROM users WHERE id = ?', [senderId]);
  const senderMaxSlots = 2;
  let senderBackpack = parseJSON(sender.backpack, [null, null]);

  // Check sender items
  const countBefore = senderBackpack.reduce((sum, slot) => sum + (slot && slot.item_id === itemId ? slot.quantity : 0), 0);
  const takeAmount = Math.min(parsedAmount, countBefore);
  if (takeAmount <= 0) return res.status(400).json({ error: 'Không có đủ vật phẩm trong balo' });

  // Remove from sender
  const removeResult = removeFromBackpack(senderBackpack, itemId, takeAmount);
  senderBackpack = removeResult.backpack;

  // Add to target
  let targetBackpack = parseJSON(targetUser.backpack, [null, null]);
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

/**
 * GET /api/profile/accommodation
 * Fetches rental rooms from Cho Tot public API gateway
 */
router.get('/accommodation', requireAuth, async (req, res) => {
  try {
    const https = require('https');
    const apiUrl = "https://gateway.chotot.com/v1/public/ad-listing?cg=1050&region=3&limit=60";
    
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      timeout: 8000
    };

    https.get(apiUrl, options, (apiRes) => {
      if (apiRes.statusCode !== 200) {
        apiRes.resume();
        return res.status(apiRes.statusCode).json({ error: `Cho Tot API returned status ${apiRes.statusCode}` });
      }

      let body = '';
      apiRes.on('data', chunk => body += chunk);
      apiRes.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data || !data.ads) {
            return res.json([]);
          }

          const rooms = data.ads.map(ad => ({
            id: ad.ad_id,
            title: ad.subject,
            price: ad.price_string || (ad.price ? `${(ad.price/1000000).toFixed(1).replace('.0', '')} triệu/tháng` : 'Thỏa thuận'),
            priceVal: ad.price,
            area: ad.size || 0,
            district: ad.area_name || 'Đà Nẵng',
            ward: ad.ward_name || '',
            image: ad.image || 'https://static.chotot.com/storage/default_images/pty/social.png',
            date: ad.date || 'Gần đây',
            url: `https://www.nhatot.com/room/${ad.list_id}.htm`,
            body: ad.body || ''
          }));

          res.json(rooms);
        } catch (err) {
          console.error('Error parsing Cho Tot response:', err);
          res.status(500).json({ error: 'Lỗi phân tích dữ liệu phòng trọ' });
        }
      });
    }).on('error', (err) => {
      console.error('Error fetching from Cho Tot:', err);
      res.status(500).json({ error: 'Lỗi kết nối máy chủ Chợ Tốt' });
    });
  } catch (e) {
    console.error('Accommodation sync error:', e);
    res.status(500).json({ error: 'Lỗi đồng bộ phòng trọ' });
  }
});

// ── Where is your team? (Travel Map & GPS Tracker) ──────────────────────────

/**
 * POST /api/profile/travel/create
 * Body: { name }
 */
router.post('/travel/create', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length === 0) {
    return res.status(400).json({ error: 'Tên chuyến đi không được để trống' });
  }

  try {
    // Generate unique group code
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    let isUnique = false;
    while (!isUnique) {
      code = '';
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      const existing = await getOne("SELECT id FROM travel_groups WHERE code = ?", [code]);
      if (!existing) isUnique = true;
    }

    // Create group
    await runSql(
      "INSERT INTO travel_groups (code, name, leader_username) VALUES (?, ?, ?)",
      [code, name.trim(), req.user.username]
    );

    const group = await getOne("SELECT * FROM travel_groups WHERE code = ?", [code]);
    if (!group) {
      return res.status(500).json({ error: 'Lỗi tạo nhóm phượt' });
    }

    // Add leader to members
    await runSql(
      "INSERT INTO group_members (group_id, username, status) VALUES (?, ?, 'active') ON CONFLICT DO NOTHING",
      [group.id, req.user.username]
    );

    res.json({ success: true, group });
  } catch (e) {
    console.error('Travel create error:', e);
    res.status(500).json({ error: 'Lỗi máy chủ khi tạo nhóm phượt' });
  }
});

/**
 * POST /api/profile/travel/join
 * Body: { code }
 */
router.post('/travel/join', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code || code.trim().length === 0) {
    return res.status(400).json({ error: 'Mã nhóm không được để trống' });
  }

  const cleanCode = code.trim().toUpperCase();

  try {
    const group = await getOne("SELECT * FROM travel_groups WHERE code = ?", [cleanCode]);
    if (!group) {
      return res.status(404).json({ error: 'Không tìm thấy nhóm phượt với mã này!' });
    }

    // Add user to group_members
    await runSql(
      "INSERT INTO group_members (group_id, username, status) VALUES (?, ?, 'active') ON CONFLICT (group_id, username) DO UPDATE SET status = 'active'",
      [group.id, req.user.username]
    );

    res.json({ success: true, group });
  } catch (e) {
    console.error('Travel join error:', e);
    res.status(500).json({ error: 'Lỗi máy chủ khi gia nhập nhóm phượt' });
  }
});

/**
 * GET /api/profile/travel/active
 * Gets the active group for the user
 */
router.get('/travel/active', requireAuth, async (req, res) => {
  try {
    const activeGroup = await getOne(
      "SELECT g.*, m.status FROM group_members m JOIN travel_groups g ON m.group_id = g.id WHERE m.username = ? ORDER BY g.created_at DESC LIMIT 1",
      [req.user.username]
    );
    res.json({ success: true, group: activeGroup });
  } catch (e) {
    console.error('Travel active query error:', e);
    res.status(500).json({ error: 'Lỗi máy chủ khi truy vấn nhóm hoạt động' });
  }
});

/**
 * GET /api/profile/travel/group/:id
 * Gets details of a specific group, including its members and custom RPG styling
 */
router.get('/travel/group/:id', requireAuth, async (req, res) => {
  const groupId = req.params.id;

  try {
    const group = await getOne("SELECT * FROM travel_groups WHERE id = ?", [groupId]);
    if (!group) {
      return res.status(404).json({ error: 'Không tìm thấy nhóm phượt' });
    }

    // Query all members with custom RPG character colors
    const members = await getAll(
      `SELECT m.username, m.lat, m.lng, m.status, m.last_updated, u.display_name,
              u.char_head_color, u.char_hair_color, u.char_body_color, u.char_legs_color, u.char_shoe_color
       FROM group_members m
       JOIN users u ON m.username = u.username
       WHERE m.group_id = ?
       ORDER BY m.username = ? DESC, m.last_updated DESC`,
      [groupId, group.leader_username]
    );

    res.json({ success: true, group, members });
  } catch (e) {
    console.error('Travel group details query error:', e);
    res.status(500).json({ error: 'Lỗi máy chủ khi truy vấn thông tin nhóm' });
  }
});

/**
 * POST /api/profile/travel/leave
 * Body: { groupId }
 */
router.post('/travel/leave', requireAuth, async (req, res) => {
  const { groupId } = req.body;
  if (!groupId) {
    return res.status(400).json({ error: 'Thiếu mã nhóm phượt' });
  }

  try {
    // Remove member
    await runSql(
      "DELETE FROM group_members WHERE group_id = ? AND username = ?",
      [groupId, req.user.username]
    );

    // If no members are left, clean up the group
    const checkMembers = await getOne("SELECT COUNT(*) as count FROM group_members WHERE group_id = ?", [groupId]);
    const memberCount = checkMembers ? parseInt(checkMembers.count, 10) : 0;
    
    if (memberCount === 0) {
      await runSql("DELETE FROM travel_groups WHERE id = ?", [groupId]);
      console.log(`[Travel DB] Deleted empty travel group: ID ${groupId}`);
    }

    res.json({ success: true });
  } catch (e) {
    console.error('Travel leave error:', e);
    res.status(500).json({ error: 'Lỗi máy chủ khi rời nhóm phượt' });
  }
});

/**
 * GET /api/profile/travel/config
 * Returns secure travel configurations (like Google Maps API Key)
 */
router.get('/travel/config', requireAuth, async (req, res) => {
  res.json({
    success: true,
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || ''
  });
});

router.post('/consume', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { slotIdx } = req.body;

  if (slotIdx === undefined || slotIdx === null || slotIdx < 0 || slotIdx > 1) {
    return res.status(400).json({ error: 'Chỉ số ô balo không hợp lệ' });
  }

  // Decay energy first
  await decayUserEnergy(userId);

  // Load user
  const user = await getOne('SELECT backpack, energy FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'Không tìm thấy người chơi' });

  let backpack = parseJSON(user.backpack, [null, null]);
  const item = backpack[slotIdx];

  if (!item || item.quantity <= 0) {
    return res.status(400).json({ error: 'Ô balo rỗng' });
  }

  // Check if item is edible/drinkable
  const edibleItems = {
    banh_mi: 2,
    sandwich: 2,
    milk: 1
  };

  const energyGain = edibleItems[item.item_id];
  if (energyGain === undefined) {
    return res.status(400).json({ error: 'Vật phẩm không thể ăn hoặc uống' });
  }

  const currentEnergy = user.energy !== null ? user.energy : 6;
  if (currentEnergy >= 6) {
    return res.status(400).json({ error: 'Năng lượng đã đầy (Tối đa 6)' });
  }

  // Deduct 1 item quantity
  item.quantity -= 1;
  if (item.quantity <= 0) {
    backpack[slotIdx] = null;
  }

  // Increase energy (cap at 6)
  const newEnergy = Math.min(6, currentEnergy + energyGain);

  // Save changes
  await runSql('UPDATE users SET backpack = ?, energy = ?, energy_updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
    JSON.stringify(backpack),
    newEnergy,
    userId
  ]);

  // Log activity
  try {
    const verb = item.item_id === 'milk' ? 'Uống' : 'Ăn';
    const itemName = item.item_id === 'milk' ? 'sữa' : (item.item_id === 'banh_mi' ? 'bánh mì dài' : 'sandwich');
    await logActivity(req.user.username, 'consume_item', `${verb} 1 ${itemName} (+${energyGain} năng lượng)`);
  } catch(e) {}

  res.json({
    message: 'Sử dụng vật phẩm thành công',
    backpack,
    energy: newEnergy
  });
});

module.exports = router;
