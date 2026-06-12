const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getOne, runSql, logActivity } = require('../db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'te-lan-4.2-super-secret-key-2024';
const JWT_EXPIRES_IN = '7d';

const LAST_ONLINE_THROTTLE_MS = 5 * 60 * 1000; // 5 phút
const lastOnlineMap = new Map(); // userId -> lastUpdateTimestamp

// ── Shared middleware ────────────────────────────────────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token không hợp lệ hoặc đã hết hạn' });
    req.user = user;
    // Throttle last_online UPDATE: chỉ UPDATE nếu > 5 phút kể từ lần cuối
    const now = Date.now();
    const last = lastOnlineMap.get(user.id) || 0;
    if (now - last > LAST_ONLINE_THROTTLE_MS) {
      lastOnlineMap.set(user.id, now);
      runSql('UPDATE users SET last_online = CURRENT_TIMESTAMP WHERE id = ?', [user.id]).catch(() => {});
    }
    next();
  });
}

// ── POST /api/login ──────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Vui lòng nhập tên đăng nhập và mật khẩu' });

  const user = await getOne('SELECT * FROM users WHERE username = ?', [username.trim().toLowerCase()]);
  if (!user)
    return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' });

  if (!bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' });

  const token = jwt.sign(
    { id: user.id, username: user.username, displayName: user.display_name, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  
  // Log login activity
  try {
    await logActivity(user.username, 'login', 'Đăng nhập vào hệ thống');
  } catch(e) {}

  res.json({
    message: 'Đăng nhập thành công',
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      avatar: user.avatar || null,
      role: user.role || 'user',
      xu: user.xu ?? 0,
      charHeadColor: user.char_head_color || '#ffccaa',
      charHairColor: user.char_hair_color || '#8b4513',
      charBodyColor: user.char_body_color || '#3b82f6',
      charLegsColor: user.char_legs_color || '#1e293b',
      charShoeColor: user.char_shoe_color || '#000000',
      backpack: JSON.parse(user.backpack || '[null, null]'),
      characterType: user.character_type || 'FrogNinja',
    },
  });
});

// ── POST /api/logout ─────────────────────────────────────────────────────────
router.post('/logout', authenticateToken, (req, res) => {
  res.json({ message: 'Đăng xuất thành công' });
});

// ── GET /api/me ──────────────────────────────────────────────────────────────
router.get('/me', authenticateToken, async (req, res) => {
  const user = await getOne(
    'SELECT id, username, display_name, avatar, role, xu, created_at, char_head_color, char_hair_color, char_body_color, char_legs_color, char_shoe_color, backpack, inventory_slots, character_type FROM users WHERE id = ?',
    [req.user.id]
  );
  if (!user) return res.status(404).json({ error: 'Người dùng không tồn tại' });

  res.json({
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    avatar: user.avatar || null,
    role: user.role || 'user',
    xu: user.xu ?? 0,
    createdAt: user.created_at,
    charHeadColor: user.char_head_color || '#ffccaa',
    charHairColor: user.char_hair_color || '#8b4513',
    charBodyColor: user.char_body_color || '#3b82f6',
    charLegsColor: user.char_legs_color || '#1e293b',
    charShoeColor: user.char_shoe_color || '#000000',
    backpack: JSON.parse(user.backpack || '[null, null]'),
    inventory_slots: user.inventory_slots || 5,
    characterType: user.character_type || 'FrogNinja',
  });
});

module.exports = router;
module.exports.authenticateToken = authenticateToken;
