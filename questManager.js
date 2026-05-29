const { getOne, runSql } = require('./db');

const QUEST_CONFIGS = {
  sut_bong: {
    key: 'sut_bong',
    title: 'Kiếm 20 xu bằng sút bóng',
    description: 'Chơi minigame sút phạt ở trang chủ để kiếm xu',
    maxProgress: 20,
    reward: 100
  },
  mua_ruong: {
    key: 'mua_ruong',
    title: 'Mua ruộng ở nông trại của bạn',
    description: 'Sở hữu một mảnh ruộng để bắt đầu trồng trọt',
    maxProgress: 1,
    reward: 50,
    link: '/farm'
  },
  gieo_thu_hoach: {
    key: 'gieo_thu_hoach',
    title: 'Gieo hạt lần đầu và thu hoạch lần đầu',
    description: 'Thực hiện gieo hạt và thu hoạch lúa chín tại trang trại',
    maxProgress: 2,
    reward: 10
  },
  ban_lua: {
    key: 'ban_lua',
    title: 'Bán 8 lúa ở chợ',
    description: 'Bán lúa thu hoạch được tại thị trường chợ',
    maxProgress: 8,
    reward: 0
  },
  mua_bo: {
    key: 'mua_bo',
    title: 'Mua 1 con bò ở chợ',
    description: 'Mua một con bò sữa tại chợ động vật',
    maxProgress: 1,
    reward: 220
  },
  cho_bo_an: {
    key: 'cho_bo_an',
    title: 'Mua 4 bó rơm ở chợ và mang về cho bò ăn',
    description: 'Mua rơm từ chợ và bỏ vào chuồng cho bò ăn',
    maxProgress: 4,
    reward: 20
  },
  choi_lobby_game: {
    key: 'choi_lobby_game',
    title: 'Chơi một trò chơi ở sảnh đa người chơi',
    description: 'Tham gia chơi Tiến Lên hoặc Ném phi tiêu cùng bạn bè ở sảnh',
    maxProgress: 1,
    reward: 200
  }
};

/**
 * Get all quests with progress for a user
 */
async function getUserQuests(userId) {
  const rows = await require('./db').getAll('SELECT quest_key, progress, completed, claimed FROM user_quests WHERE user_id = ?', [userId]);
  const userQuestsMap = {};
  rows.forEach(r => {
    userQuestsMap[r.quest_key] = {
      progress: r.progress,
      completed: !!r.completed,
      claimed: !!r.claimed
    };
  });

  return Object.keys(QUEST_CONFIGS).map(key => {
    const config = QUEST_CONFIGS[key];
    const userState = userQuestsMap[key] || { progress: 0, completed: false, claimed: false };
    return {
      ...config,
      progress: userState.progress,
      completed: userState.completed,
      claimed: userState.claimed
    };
  });
}

/**
 * Get a specific quest progress for a user
 */
async function getUserQuest(userId, questKey) {
  const r = await getOne('SELECT quest_key, progress, completed, claimed FROM user_quests WHERE user_id = ? AND quest_key = ?', [userId, questKey]);
  if (!r) {
    return {
      ...QUEST_CONFIGS[questKey],
      progress: 0,
      completed: false,
      claimed: false
    };
  }
  return {
    ...QUEST_CONFIGS[questKey],
    progress: r.progress,
    completed: !!r.completed,
    claimed: !!r.claimed
  };
}

/**
 * Update quest progress for a user
 */
async function updateQuestProgress(userId, questKey, incrementAmount, progressCap) {
  const config = QUEST_CONFIGS[questKey];
  if (!config) return;

  const cap = progressCap != null ? progressCap : config.maxProgress;

  // Ensure record exists (no-op if already present)
  await runSql(`
    INSERT OR IGNORE INTO user_quests (user_id, quest_key, progress, completed, claimed)
    VALUES (?, ?, 0, 0, 0)
  `, [userId, questKey]);

  // Atomic update: only increment if not completed, not claimed, and progress < cap
  await runSql(`
    UPDATE user_quests
    SET progress = MIN(progress + ?, ?),
        completed = CASE WHEN MIN(progress + ?, ?) >= ? THEN 1 ELSE 0 END,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND quest_key = ? AND completed = 0 AND claimed = 0 AND progress < ?
  `, [incrementAmount, config.maxProgress, incrementAmount, config.maxProgress, config.maxProgress, userId, questKey, cap]);
}

/**
 * Claim the reward for a completed quest
 */
async function claimQuestReward(userId, questKey) {
  const config = QUEST_CONFIGS[questKey];
  if (!config) throw new Error('Không tìm thấy thông tin nhiệm vụ');

  const current = await getUserQuest(userId, questKey);
  if (!current.completed) {
    throw new Error('Nhiệm vụ chưa hoàn thành');
  }
  if (current.claimed) {
    throw new Error('Nhiệm vụ đã được nhận thưởng trước đó');
  }

  // Update claimed status
  await runSql('UPDATE user_quests SET claimed = ? WHERE user_id = ? AND quest_key = ?', [1, userId, questKey]);

  // Give reward if any
  if (config.reward > 0) {
    await runSql('UPDATE users SET xu = xu + ? WHERE id = ?', [config.reward, userId]);
  }

  const updatedUser = await getOne('SELECT xu FROM users WHERE id = ?', [userId]);
  return {
    success: true,
    reward: config.reward,
    newXu: updatedUser ? updatedUser.xu : 0
  };
}

module.exports = {
  QUEST_CONFIGS,
  getUserQuests,
  getUserQuest,
  updateQuestProgress,
  claimQuestReward
};
