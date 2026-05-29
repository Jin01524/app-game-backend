const express = require('express');
const questManager = require('../questManager');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Chưa đăng nhập' });
  next();
}

/**
 * GET /api/quests
 * Returns list of all quests for the current user
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const list = await questManager.getUserQuests(req.user.id);
    res.json(list);
  } catch (err) {
    console.error('Error fetching quests:', err);
    res.status(500).json({ error: 'Không thể tải danh sách nhiệm vụ' });
  }
});

/**
 * POST /api/quests/claim
 * Claims the reward for a completed quest
 * Body: { questKey: string }
 */
router.post('/claim', requireAuth, async (req, res) => {
  const { questKey } = req.body;
  if (!questKey) {
    return res.status(400).json({ error: 'Thiếu thông tin khóa nhiệm vụ' });
  }

  try {
    const result = await questManager.claimQuestReward(req.user.id, questKey);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Không thể nhận thưởng nhiệm vụ này' });
  }
});

module.exports = router;
