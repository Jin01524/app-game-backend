const express = require('express');
const bcrypt = require('bcryptjs');
const { getOne, getAll, runSql, logActivity } = require('../db');

const router = express.Router();

// All routes here already protected by authenticateToken + requireAdmin (set in server.js)

// ── GET /api/admin/users ─────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  const users = await getAll(
    'SELECT id, username, display_name, role, xu, created_at FROM users ORDER BY id ASC'
  );
  res.json(users.map(u => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    xu: u.xu ?? 0,
    createdAt: u.created_at,
  })));
});

// ── POST /api/admin/users — Tạo user mới ─────────────────────────────────────
router.post('/users', async (req, res) => {
  const { username, displayName, password, role } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: 'Tên đăng nhập và mật khẩu là bắt buộc' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 4 ký tự' });
  if (!/^[a-zA-Z0-9_]+$/.test(username))
    return res.status(400).json({ error: 'Tên đăng nhập chỉ được chứa chữ cái, số, dấu gạch dưới' });

  const existing = await getOne('SELECT id FROM users WHERE username = ?', [username.toLowerCase()]);
  if (existing)
    return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại' });

  const hash = bcrypt.hashSync(password, 10);
  const validRole = ['user', 'admin'].includes(role) ? role : 'user';

  await runSql(
    'INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)',
    [username.toLowerCase(), hash, displayName || username, validRole]
  );

  const created = await getOne('SELECT id, username, display_name, role, created_at FROM users WHERE username = ?',
    [username.toLowerCase()]);
  res.status(201).json({
    message: 'Tạo tài khoản thành công',
    user: { id: created.id, username: created.username, displayName: created.display_name, role: created.role },
  });
});

// ── PUT /api/admin/users/:id — Sửa user ──────────────────────────────────────
router.put('/users/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { displayName, password, role, xu } = req.body;

  const user = await getOne('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) return res.status(404).json({ error: 'Người dùng không tồn tại' });

  // Prevent removing the only admin
  if (role === 'user' && user.role === 'admin') {
    const adminCount = (await getAll("SELECT id FROM users WHERE role = 'admin'")).length;
    if (adminCount <= 1)
      return res.status(400).json({ error: 'Không thể hạ quyền admin duy nhất' });
  }

  const newDisplayName = displayName !== undefined ? displayName : user.display_name;
  const validRole = ['user', 'admin'].includes(role) ? role : user.role;
  const newXu = xu !== undefined ? Math.max(0, parseInt(xu) || 0) : (user.xu ?? 0);

  if (password) {
    if (password.length < 4)
      return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 4 ký tự' });
    const hash = bcrypt.hashSync(password, 10);
    await runSql('UPDATE users SET display_name = ?, role = ?, password_hash = ?, xu = ? WHERE id = ?',
      [newDisplayName, validRole, hash, newXu, id]);
  } else {
    await runSql('UPDATE users SET display_name = ?, role = ?, xu = ? WHERE id = ?',
      [newDisplayName, validRole, newXu, id]);
  }

  const updated = await getOne('SELECT id, username, display_name, role, xu, created_at FROM users WHERE id = ?', [id]);
  res.json({
    message: 'Cập nhật thành công',
    user: { id: updated.id, username: updated.username, displayName: updated.display_name, role: updated.role, xu: updated.xu ?? 0 },
  });
});

// ── DELETE /api/admin/users/:id — Xoá user ───────────────────────────────────
router.delete('/users/:id', async (req, res) => {
  const id = parseInt(req.params.id);

  // Cannot delete self
  if (id === req.user.id)
    return res.status(400).json({ error: 'Không thể xóa tài khoản đang đăng nhập' });

  const user = await getOne('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) return res.status(404).json({ error: 'Người dùng không tồn tại' });

  // Cannot delete last admin
  if (user.role === 'admin') {
    const adminCount = (await getAll("SELECT id FROM users WHERE role = 'admin'")).length;
    if (adminCount <= 1)
      return res.status(400).json({ error: 'Không thể xóa admin duy nhất' });
  }

  await runSql('DELETE FROM users WHERE id = ?', [id]);
  res.json({ message: `Đã xóa tài khoản ${user.username}` });
});

// ── PUT /api/admin/settings ──────────────────────────────────────────────────
router.put('/settings', async (req, res) => {
  const { gkBaseSpeed, goalWidth, aimSpeed } = req.body;
  
  if (gkBaseSpeed !== undefined) await runSql('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['gkBaseSpeed', String(gkBaseSpeed)]);
  if (goalWidth !== undefined) await runSql('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['goalWidth', String(goalWidth)]);
  if (aimSpeed !== undefined) await runSql('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['aimSpeed', String(aimSpeed)]);

  res.json({ message: 'Đã cập nhật cấu hình game' });
});

const settingsManager = require('../settingsManager');

// GET /api/admin/settings
router.get('/settings', (req, res) => {
  res.json(settingsManager.getAllSettings());
});

// POST /api/admin/settings
router.post('/settings', (req, res) => {
  const updates = req.body;
  if (typeof updates === 'object' && updates !== null) {
    Object.keys(updates).forEach(key => {
      settingsManager.setSetting(key, updates[key]);
    });
  }
  res.json({ message: 'Đã cập nhật cấu hình', settings: settingsManager.getAllSettings() });
});

// ── GET /api/admin/logs ─────────────────────────────────────────────────────
router.get('/logs', async (req, res) => {
  const logs = await getAll(
    'SELECT id, username, action_type, details, xu_change, created_at FROM activity_logs ORDER BY created_at DESC LIMIT 500'
  );
  res.json(logs);
});

module.exports = router;
