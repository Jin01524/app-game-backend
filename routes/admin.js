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

const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../uploads/movies');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, 'cover-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // limit 5MB
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const mimeType = allowedTypes.test(file.mimetype);
    const extName = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    if (mimeType && extName) {
      return cb(null, true);
    }
    cb(new Error('Chỉ chấp nhận các định dạng ảnh (.png, .jpg, .jpeg, .gif, .webp)'));
  }
});

// POST /api/admin/movies/upload - Tải ảnh bìa lên
router.post('/movies/upload', upload.single('cover'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Không nhận được file tải lên' });
    }
    const relativePath = `/uploads/movies/${req.file.filename}`;
    res.json({ success: true, path: relativePath });
  } catch (err) {
    console.error('Upload movie cover error:', err);
    res.status(500).json({ error: 'Lỗi tải tệp lên' });
  }
});

// POST /api/admin/movies - Tạo phim mới
router.post('/movies', async (req, res) => {
  const { title, description, coverUrl, tags, country, genre, parts } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Tên phim không được bỏ trống' });
  }

  const partsStr = typeof parts === 'string' ? parts : JSON.stringify(parts || []);
  try {
    await runSql(
      'INSERT INTO movies (title, description, cover_url, tags, country, genre, parts) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [title, description || '', coverUrl || '', tags || '', country || '', genre || '', partsStr]
    );
    await logActivity(req.user.username, 'admin_create_movie', `Tạo phim: ${title}`);
    res.json({ success: true, message: 'Đăng phim mới thành công!' });
  } catch (err) {
    console.error('Admin create movie error:', err);
    res.status(500).json({ error: 'Lỗi khi lưu bộ phim mới' });
  }
});

// PUT /api/admin/movies/:id - Cập nhật phim
router.put('/movies/:id', async (req, res) => {
  const { id } = req.params;
  const { title, description, coverUrl, tags, country, genre, parts } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Tên phim không được bỏ trống' });
  }

  const partsStr = typeof parts === 'string' ? parts : JSON.stringify(parts || []);
  try {
    const existing = await getOne('SELECT id FROM movies WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Không tìm thấy phim cần cập nhật' });
    }

    await runSql(
      'UPDATE movies SET title = ?, description = ?, cover_url = ?, tags = ?, country = ?, genre = ?, parts = ? WHERE id = ?',
      [title, description || '', coverUrl || '', tags || '', country || '', genre || '', partsStr, id]
    );
    await logActivity(req.user.username, 'admin_update_movie', `Cập nhật phim ID ${id}: ${title}`);
    res.json({ success: true, message: 'Cập nhật thông tin phim thành công!' });
  } catch (err) {
    console.error('Admin update movie error:', err);
    res.status(500).json({ error: 'Lỗi khi cập nhật bộ phim' });
  }
});

// DELETE /api/admin/movies/:id - Xóa phim
router.delete('/movies/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await getOne('SELECT title FROM movies WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Không tìm thấy phim cần xóa' });
    }

    await runSql('DELETE FROM movies WHERE id = ?', [id]);
    await logActivity(req.user.username, 'admin_delete_movie', `Xóa phim ID ${id}: ${existing.title}`);
    res.json({ success: true, message: 'Đã xóa phim thành công!' });
  } catch (err) {
    console.error('Admin delete movie error:', err);
    res.status(500).json({ error: 'Lỗi khi xóa bộ phim' });
  }
});

// GET /api/admin/movies/:id/watchers - Lấy danh sách người dùng đã xem phim
router.get('/movies/:id/watchers', async (req, res) => {
  const { id } = req.params;
  try {
    const watchers = await getAll(
      `SELECT 
        u.username, 
        u.display_name as "displayName", 
        w.part_index as "partIndex", 
        w.watched_seconds as "watchedSeconds", 
        w.last_watched_at as "lastWatchedAt"
      FROM movie_watch_logs w
      JOIN users u ON w.user_id = u.id
      WHERE w.movie_id = ?
      ORDER BY u.username, w.part_index`,
      [id]
    );
    res.json(watchers);
  } catch (err) {
    console.error('Admin get movie watchers error:', err);
    res.status(500).json({ error: 'Lỗi khi lấy thống kê người xem' });
  }
});

module.exports = router;
