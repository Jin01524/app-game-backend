const express = require('express');
const { getAll, getOne } = require('../db');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Chưa đăng nhập' });
  next();
}

/**
 * GET /api/messages/global
 * Fetches 50 most recent global messages
 */
router.get('/global', requireAuth, async (req, res) => {
  try {
    const list = await getAll(`
      SELECT m.id, m.content, m.created_at, u.username, u.display_name, u.role, u.avatar
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.recipient_id IS NULL
      ORDER BY m.id DESC
      LIMIT 50
    `);
    res.json(list.reverse());
  } catch (err) {
    console.error('Error fetching global messages:', err);
    res.status(500).json({ error: 'Không thể tải tin nhắn kênh chung' });
  }
});

/**
 * GET /api/messages/private/:otherUsername
 * Fetches 50 most recent private messages with another user
 */
router.get('/private/:otherUsername', requireAuth, async (req, res) => {
  const { otherUsername } = req.params;
  const myUsername = req.user.username;

  try {
    const otherUser = await getOne('SELECT id FROM users WHERE username = ?', [otherUsername]);
    if (!otherUser) {
      return res.status(404).json({ error: 'Không tìm thấy người dùng này' });
    }

    const list = await getAll(`
      SELECT m.id, m.content, m.created_at, 
             u.username as sender_username, u.display_name as sender_display_name, u.role as sender_role, u.avatar as sender_avatar,
             r.username as recipient_username
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      JOIN users r ON m.recipient_id = r.id
      WHERE (u.username = ? AND r.username = ?) OR (u.username = ? AND r.username = ?)
      ORDER BY m.id DESC
      LIMIT 50
    `, [myUsername, otherUsername, otherUsername, myUsername]);

    res.json(list.reverse());
  } catch (err) {
    console.error('Error fetching private messages:', err);
    res.status(500).json({ error: 'Không thể tải tin nhắn riêng' });
  }
});

module.exports = router;
