const { getOne, runSql } = require('./db');

const ROLES = {
  DAN_LANG: { id: 'DAN_LANG', name: 'Dân Làng', faction: 'VILLAGER' },
  TIEN_TRI: { id: 'TIEN_TRI', name: 'Tiên Tri', faction: 'VILLAGER' },
  PHU_THUY: { id: 'PHU_THUY', name: 'Phù Thủy', faction: 'VILLAGER' },
  THO_SAN: { id: 'THO_SAN', name: 'Thợ Săn', faction: 'VILLAGER' },
  BAO_VE: { id: 'BAO_VE', name: 'Bảo Vệ', faction: 'VILLAGER' },
  GIA_LANG: { id: 'GIA_LANG', name: 'Già Làng', faction: 'VILLAGER' },
  KE_NGOC: { id: 'KE_NGOC', name: 'Kẻ Ngốc', faction: 'VILLAGER' },
  THIEN_THAN: { id: 'THIEN_THAN', name: 'Thiên Thần', faction: 'VILLAGER' },
  QUAN_TOA: { id: 'QUAN_TOA', name: 'Quan Tòa Nói Lắp', faction: 'VILLAGER' },
  HIEP_SI: { id: 'HIEP_SI', name: 'Hiệp Sĩ Kiếm Rỉ', faction: 'VILLAGER' },
  DIEN_VIEN: { id: 'DIEN_VIEN', name: 'Diễn Viên', faction: 'VILLAGER' },
  NGUOI_HAU: { id: 'NGUOI_HAU', name: 'Người Hầu Trung Thành', faction: 'VILLAGER' },
  NGUOI_THUAN_GAU: { id: 'NGUOI_THUAN_GAU', name: 'Người Thuần Gấu', faction: 'VILLAGER' },
  KE_THAO_TUNG: { id: 'KE_THAO_TUNG', name: 'Kẻ Thao Túng Thành Kiến', faction: 'VILLAGER' },
  DUA_TRE_HOANG_DA: { id: 'DUA_TRE_HOANG_DA', name: 'Đứa Trẻ Hoang Dã', faction: 'VILLAGER' },
  THAY_BOI_GYPSY: { id: 'THAY_BOI_GYPSY', name: 'Thầy Bói Gypsy', faction: 'VILLAGER' },
  NGUOI_RAO_TIN: { id: 'NGUOI_RAO_TIN', name: 'Người Rao Tin', faction: 'VILLAGER' },
  CAP_DAN_LANG: { id: 'CAP_DAN_LANG', name: 'Cặp Dân Làng', faction: 'VILLAGER' },
  MA_SOI: { id: 'MA_SOI', name: 'Ma Sói', faction: 'WOLF' },
  SOI_TRANG: { id: 'SOI_TRANG', name: 'Sói Trắng', faction: 'WOLF' },
  DAI_MA_SOI: { id: 'DAI_MA_SOI', name: 'Đại Ma Sói', faction: 'WOLF' },
  SOI_CHA: { id: 'SOI_CHA', name: 'Sói Cha Bị Nguyền', faction: 'WOLF' },
  SOI_LAI: { id: 'SOI_LAI', name: 'Sói Lai', faction: 'WOLF' }, // Chooses faction night 1
  CUPID: { id: 'CUPID', name: 'Cupid', faction: 'NEUTRAL' },
  KE_TROM: { id: 'KE_TROM', name: 'Kẻ Trộm', faction: 'NEUTRAL' },
  KE_THOI_SAO: { id: 'KE_THOI_SAO', name: 'Kẻ Thổi Sáo', faction: 'NEUTRAL' },
  VAT_TE_THAN: { id: 'VAT_TE_THAN', name: 'Vật Tế Thần', faction: 'NEUTRAL' },
  CHO_SOI: { id: 'CHO_SOI', name: 'Chó Sói', faction: 'NEUTRAL' },
  CON_QUA: { id: 'CON_QUA', name: 'Con Quạ', faction: 'NEUTRAL' },
  KE_PHONG_HOA: { id: 'KE_PHONG_HOA', name: 'Kẻ Phóng Hỏa', faction: 'NEUTRAL' },
};

// Night action priority order
const NIGHT_PRIORITY = [
  'KE_TROM', // Night 1 only
  'CUPID', // Night 1 only
  'LOVERS_WAKE_UP', // Night 1 only, just to see each other
  'DUA_TRE_HOANG_DA', // Night 1 only
  'SOI_LAI', // Night 1 only
  'BAO_VE',
  'MA_SOI', // All wolves wake up to kill
  'SOI_TRANG', // Every even night, can kill a wolf
  'DAI_MA_SOI', // Can kill an extra target if no wolf is dead
  'SOI_CHA', // Can curse the victim instead of killing
  'PHU_THUY',
  'TIEN_TRI',
  'THAY_BOI_GYPSY',
  'CON_QUA',
  'KE_PHONG_HOA',
  'KE_THOI_SAO'
];

const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      id: roomId,
      players: {}, // socketId: { id, username, displayName, ready, role: null, isAlive: true, isConnected: true, host: false, tags: [] }
      settings: {
        revealRoleOnDeath: true,
        spectatorMode: true,
        rolesList: [] // Array of role IDs
      },
      status: 'waiting', // waiting, night, day_discussion, day_voting, hunter_action, ended
      timer: 0,
      timerId: null,
      round: 0,
      votes: {}, 
      nightState: {
        activeRoleIndex: -1,
        actions: {}, // Records actions taken this night
        middleCards: [] // For Thief
      },
      dayState: {
        diedTonight: [],
        sheriff: null // socketId of Sheriff
      },
      result: null
    };
  }
  return rooms[roomId];
}

function broadcastState(io, roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const safePlayers = {};
  for (const [sid, p] of Object.entries(room.players)) {
    safePlayers[sid] = {
      id: sid,
      username: p.username,
      displayName: p.displayName,
      ready: p.ready,
      isAlive: p.isAlive,
      isConnected: p.isConnected,
      host: p.host,
      hasSheriffBadge: room.dayState.sheriff === sid,
      voteCount: Object.values(room.votes).filter(v => v === sid).length
    };
  }

  for (const [sid, p] of Object.entries(room.players)) {
    // Determine what roles this player can see
    let visibleRoles = {};
    if (room.status === 'ended' || (room.settings.spectatorMode && !p.isAlive)) {
      // Can see all roles
      for (const [osid, op] of Object.entries(room.players)) {
        visibleRoles[osid] = op.role;
      }
    } else {
      // Normal gameplay visibility
      visibleRoles[sid] = p.role;
      
      if (room.settings.revealRoleOnDeath) {
        for (const [osid, op] of Object.entries(room.players)) {
          if (!op.isAlive) visibleRoles[osid] = op.role;
        }
      }

      // Wolf vision
      if (p.isAlive && p.role && ROLES[p.role] && ROLES[p.role].faction === 'WOLF') {
        for (const [osid, op] of Object.entries(room.players)) {
          if (op.isAlive && op.role && ROLES[op.role] && ROLES[op.role].faction === 'WOLF') {
            visibleRoles[osid] = op.role;
          }
        }
      }
      // Lovers vision
      if (p.tags && p.tags.includes('LOVER')) {
        for (const [osid, op] of Object.entries(room.players)) {
          if (op.tags && op.tags.includes('LOVER')) {
            // Can see they are a lover, but not necessarily their exact role, 
            // though usually lovers know each other. We just pass their role here for simplicity.
            visibleRoles[osid] = op.role;
          }
        }
      }
    }

    io.to(sid).emit('werewolf_state', {
      id: room.id,
      players: safePlayers,
      settings: room.settings,
      status: room.status,
      timer: room.timer,
      round: room.round,
      votes: room.votes,
      result: room.result,
      myRole: p.role,
      myTags: p.tags,
      visibleRoles: visibleRoles,
      nightState: {
        // Only send active role if it's night and it's their turn
        isMyTurn: room.status === 'night' && NIGHT_PRIORITY[room.nightState.activeRoleIndex] === p.role,
        activeRole: room.status === 'night' ? NIGHT_PRIORITY[room.nightState.activeRoleIndex] : null,
        middleCards: p.role === 'KE_TROM' && room.round === 1 ? room.nightState.middleCards : []
      },
      dayState: room.dayState
    });
  }
}

function startTimer(io, roomId, duration, onTimeout) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.timerId) clearInterval(room.timerId);
  
  room.timer = duration;
  broadcastState(io, roomId);

  room.timerId = setInterval(() => {
    room.timer--;
    if (room.timer <= 0) {
      clearInterval(room.timerId);
      room.timerId = null;
      onTimeout();
    } else {
      broadcastState(io, roomId);
    }
  }, 1000);
}

function checkWinCondition(room) {
  const alivePlayers = Object.values(room.players).filter(p => p.isAlive);
  const wolfCount = alivePlayers.filter(p => ROLES[p.role] && ROLES[p.role].faction === 'WOLF').length;
  const villagerCount = alivePlayers.length - wolfCount;
  
  // Check Piper win
  const charmedCount = alivePlayers.filter(p => p.tags.includes('CHARMED')).length;
  if (charmedCount === alivePlayers.length && alivePlayers.length > 0) {
    return 'PIPER_WIN';
  }
  
  // Check Lovers win (only lovers left)
  const loversCount = alivePlayers.filter(p => p.tags.includes('LOVER')).length;
  if (loversCount === alivePlayers.length && alivePlayers.length > 0 && loversCount > 1) {
    return 'LOVERS_WIN';
  }
  
  // Check White Wolf win
  if (alivePlayers.length === 1 && alivePlayers[0].role === 'SOI_TRANG') {
    return 'WHITE_WOLF_WIN';
  }

  // Standard Wolf win
  if (wolfCount >= villagerCount && wolfCount > 0) {
    return 'WOLF_WIN';
  }
  
  // Standard Villager win
  if (wolfCount === 0 && alivePlayers.length > 0) {
    return 'VILLAGER_WIN';
  }

  return null;
}

function endGame(io, roomId, winReason) {
  const room = rooms[roomId];
  room.status = 'ended';
  room.result = { reason: winReason };
  if (room.timerId) clearInterval(room.timerId);
  broadcastState(io, roomId);
  
  // Reset room after 15 seconds
  setTimeout(() => {
    if (rooms[roomId] && rooms[roomId].status === 'ended') {
      rooms[roomId].status = 'waiting';
      rooms[roomId].round = 0;
      rooms[roomId].result = null;
      for (const p of Object.values(rooms[roomId].players)) {
        p.role = null;
        p.isAlive = true;
        p.ready = false;
        p.tags = [];
      }
      broadcastState(io, roomId);
    }
  }, 15000);
}

function advanceNight(io, roomId) {
  const room = rooms[roomId];
  if (!room || room.status !== 'night') return;
  
  room.nightState.activeRoleIndex++;
  
  if (room.nightState.activeRoleIndex >= NIGHT_PRIORITY.length) {
    // End of night, transition to day
    startDay(io, roomId);
    return;
  }
  
  const currentRole = NIGHT_PRIORITY[room.nightState.activeRoleIndex];
  
  // Check if role exists in the game and is alive (or needed for Night 1)
  const hasRole = Object.values(room.players).some(p => p.role === currentRole && p.isAlive);
  
  // Special cases for Night 1 only
  const isNight1Only = ['KE_TROM', 'CUPID', 'LOVERS_WAKE_UP', 'DUA_TRE_HOANG_DA', 'SOI_LAI'].includes(currentRole);
  
  if (isNight1Only && room.round > 1) {
    advanceNight(io, roomId); // Skip
    return;
  }
  
  // Specific checks for roles that don't always wake up
  if (currentRole === 'LOVERS_WAKE_UP') {
    const lovers = Object.values(room.players).filter(p => p.tags.includes('LOVER'));
    if (lovers.length === 0) {
      advanceNight(io, roomId);
      return;
    }
  } else if (!hasRole && currentRole !== 'MA_SOI') { 
    // Wolves check is special because they act as a group, but covered by hasRole if any wolf variant exists?
    // Let's broaden MA_SOI to any WOLF faction
    let hasAnyWolf = Object.values(room.players).some(p => p.isAlive && ROLES[p.role] && ROLES[p.role].faction === 'WOLF');
    if (currentRole === 'MA_SOI' && !hasAnyWolf) {
      advanceNight(io, roomId);
      return;
    } else if (currentRole !== 'MA_SOI' && !hasRole) {
      advanceNight(io, roomId);
      return;
    }
  }

  // Found a role that needs to wake up
  let duration = 20; // 20s for night action
  // If it's just lovers waking up to see each other, only 10s
  if (currentRole === 'LOVERS_WAKE_UP') duration = 10;
  
  // Fake time to mask roles (always wait the full time even if they finish early, except if everyone finishes?)
  // For simplicity, we just use the timer.
  startTimer(io, roomId, duration, () => {
    // Process timeout/submit for current role
    processNightAction(io, roomId, currentRole);
    advanceNight(io, roomId);
  });
}

function processNightAction(io, roomId, role) {
  const room = rooms[roomId];
  const actions = room.nightState.actions[role] || {}; // Actions submitted by players with this role
  
  // Implementation of specific role mechanics
  if (role === 'MA_SOI') {
    // Tally wolf votes
    let voteCounts = {};
    for (const targetId of Object.values(actions)) {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }
    let maxVotes = 0;
    let victim = null;
    for (const [target, count] of Object.entries(voteCounts)) {
      if (count > maxVotes) {
        maxVotes = count;
        victim = target;
      }
    }
    if (victim) {
      room.nightState.actions['WOLF_KILL'] = victim;
    }
  } else if (role === 'CUPID') {
    // Action should be an array of 2 socketIds
    for (const act of Object.values(actions)) {
      if (Array.isArray(act) && act.length === 2) {
        const [p1, p2] = act;
        if (room.players[p1]) room.players[p1].tags.push('LOVER');
        if (room.players[p2]) room.players[p2].tags.push('LOVER');
      }
    }
  } else if (role === 'KE_TROM' && room.round === 1) {
    // Check if thief picked a card
    for (const act of Object.values(actions)) {
       // act should be the index (0 or 1) of the middle card
       if (act === 0 || act === 1) {
          const thiefSid = Object.keys(actions)[0];
          const chosenCard = room.nightState.middleCards[act];
          if (room.players[thiefSid]) {
            room.players[thiefSid].role = chosenCard;
          }
       }
    }
  }
  // Other role processing...
}

function resolveNightDeaths(room) {
  // Resolve who dies based on actions
  const died = [];
  
  const wolfKill = room.nightState.actions['WOLF_KILL'];
  const guardProtect = Object.values(room.nightState.actions['BAO_VE'] || {})[0];
  const witchSave = Object.values(room.nightState.actions['PHU_THUY_SAVE'] || {})[0];
  const witchPoison = Object.values(room.nightState.actions['PHU_THUY_POISON'] || {})[0];
  
  if (wolfKill && wolfKill !== guardProtect && wolfKill !== witchSave) {
    died.push(wolfKill);
  }
  if (witchPoison) {
    if (!died.includes(witchPoison)) died.push(witchPoison);
  }
  
  // Handle lovers
  const initialDied = [...died];
  for (const deadId of initialDied) {
    const p = room.players[deadId];
    if (p && p.tags.includes('LOVER')) {
      const otherLover = Object.keys(room.players).find(sid => sid !== deadId && room.players[sid].tags.includes('LOVER'));
      if (otherLover && !died.includes(otherLover)) {
        died.push(otherLover);
      }
    }
  }
  
  // Kill them
  for (const d of died) {
    if (room.players[d]) room.players[d].isAlive = false;
  }
  
  return died;
}

function startDay(io, roomId) {
  const room = rooms[roomId];
  room.status = 'day_discussion';
  
  const died = resolveNightDeaths(room);
  room.dayState.diedTonight = died;
  
  const win = checkWinCondition(room);
  if (win) {
    endGame(io, roomId, win);
    return;
  }
  
  // Check if Hunter died tonight
  const hunterDied = died.find(d => room.players[d] && room.players[d].role === 'THO_SAN');
  if (hunterDied) {
    room.status = 'hunter_action';
    room.dayState.hunterId = hunterDied;
    startTimer(io, roomId, 20, () => {
      // Hunter timeout
      handleHunterAction(io, roomId, hunterDied, null);
    });
    return;
  }
  
  // Normal discussion
  startTimer(io, roomId, 120, () => {
    startVoting(io, roomId);
  });
}

function handleHunterAction(io, roomId, hunterId, targetId) {
  const room = rooms[roomId];
  if (targetId && room.players[targetId] && room.players[targetId].isAlive) {
    room.players[targetId].isAlive = false;
    // Check if target is a lover
    if (room.players[targetId].tags.includes('LOVER')) {
      const otherLover = Object.keys(room.players).find(sid => sid !== targetId && room.players[sid].tags.includes('LOVER'));
      if (otherLover && room.players[otherLover].isAlive) {
        room.players[otherLover].isAlive = false;
      }
    }
  }
  
  const win = checkWinCondition(room);
  if (win) {
    endGame(io, roomId, win);
    return;
  }
  
  room.status = 'day_discussion';
  startTimer(io, roomId, 120, () => {
    startVoting(io, roomId);
  });
}

function startVoting(io, roomId) {
  const room = rooms[roomId];
  room.status = 'day_voting';
  room.votes = {};
  
  startTimer(io, roomId, 30, () => {
    tallyVotes(io, roomId);
  });
}

function tallyVotes(io, roomId) {
  const room = rooms[roomId];
  
  let voteCounts = {};
  for (const [voter, target] of Object.entries(room.votes)) {
    let weight = room.dayState.sheriff === voter ? 2 : 1;
    voteCounts[target] = (voteCounts[target] || 0) + weight;
  }
  
  let maxVotes = 0;
  let maxTargets = [];
  
  for (const [target, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) {
      maxVotes = count;
      maxTargets = [target];
    } else if (count === maxVotes) {
      maxTargets.push(target);
    }
  }
  
  let eliminatedId = null;
  
  if (maxVotes > 0) {
    if (maxTargets.length === 1) {
      eliminatedId = maxTargets[0];
    } else {
      // Tie! Check for Scapegoat (VAT_TE_THAN)
      const scapegoatId = Object.keys(room.players).find(sid => room.players[sid].role === 'VAT_TE_THAN' && room.players[sid].isAlive);
      if (scapegoatId) {
        eliminatedId = scapegoatId;
      } else {
        // No one dies
      }
    }
  }
  
  if (eliminatedId) {
    room.players[eliminatedId].isAlive = false;
    // Check lovers
    if (room.players[eliminatedId].tags.includes('LOVER')) {
      const otherLover = Object.keys(room.players).find(sid => sid !== eliminatedId && room.players[sid].tags.includes('LOVER'));
      if (otherLover) room.players[otherLover].isAlive = false;
    }
    
    // Check win
    const win = checkWinCondition(room);
    if (win) {
      endGame(io, roomId, win);
      return;
    }
    
    // Check Hunter
    if (room.players[eliminatedId].role === 'THO_SAN') {
      room.status = 'hunter_action';
      room.dayState.hunterId = eliminatedId;
      startTimer(io, roomId, 20, () => {
        handleHunterAction(io, roomId, eliminatedId, null); // Skip if timeout
      });
      return;
    }
    
    // Check Sheriff
    if (room.dayState.sheriff === eliminatedId) {
      // Need a phase to pass badge
      room.status = 'sheriff_pass';
      room.dayState.oldSheriff = eliminatedId;
      startTimer(io, roomId, 20, () => {
        startNight(io, roomId); // If timeout, badge lost
      });
      return;
    }
  }
  
  startNight(io, roomId);
}

function startNight(io, roomId) {
  const room = rooms[roomId];
  room.status = 'night';
  room.round++;
  room.nightState = {
    activeRoleIndex: -1,
    actions: {},
    middleCards: room.nightState.middleCards || []
  };
  room.dayState.diedTonight = [];
  
  advanceNight(io, roomId);
}

function setupWerewolfSockets(io) {
  io.on('connection', (socket) => {
    socket.on('ww_join', ({ roomId, username, displayName }) => {
      socket.join(roomId);
      socket.wwRoomId = roomId;

      const room = getRoom(roomId);
      
      const isFirst = Object.keys(room.players).length === 0;

      if (room.players[socket.id]) {
        room.players[socket.id].isConnected = true;
      } else {
        if (room.status !== 'waiting') {
           // Allow reconnect if they had a state, but here they don't.
           // In real app, we should map by username. Let's do that for reconnect.
           const existingSid = Object.keys(room.players).find(sid => room.players[sid].username === username);
           if (existingSid) {
             // Migrate state to new socket
             room.players[socket.id] = room.players[existingSid];
             room.players[socket.id].isConnected = true;
             delete room.players[existingSid];
             // Change sheriff if needed
             if (room.dayState.sheriff === existingSid) room.dayState.sheriff = socket.id;
             // Re-map votes
             for (const [v, t] of Object.entries(room.votes)) {
               if (v === existingSid) { delete room.votes[v]; room.votes[socket.id] = t; }
               if (t === existingSid) room.votes[v] = socket.id;
             }
           } else {
             socket.emit('ww_error', 'Game in progress.');
             return;
           }
        } else {
          room.players[socket.id] = {
            id: socket.id,
            username,
            displayName,
            ready: isFirst,
            host: isFirst,
            role: null,
            isAlive: true,
            isConnected: true,
            tags: [] // LOVER, CHARMED, PROTECTED, etc.
          };
        }
      }

      broadcastState(io, roomId);
    });

    socket.on('ww_ready', () => {
      const room = rooms[socket.wwRoomId];
      if (room && room.status === 'waiting') {
        const p = room.players[socket.id];
        if (p) {
          p.ready = !p.ready;
          broadcastState(io, socket.wwRoomId);
        }
      }
    });

    socket.on('ww_update_settings', (settings) => {
      const room = rooms[socket.wwRoomId];
      if (room && room.status === 'waiting' && room.players[socket.id].host) {
        room.settings = { ...room.settings, ...settings };
        broadcastState(io, socket.wwRoomId);
      }
    });

    socket.on('ww_start', () => {
      const room = rooms[socket.wwRoomId];
      if (!room || room.status !== 'waiting') return;

      const p = room.players[socket.id];
      if (!p || !p.host) return;

      const playerSids = Object.keys(room.players);
      if (playerSids.length < 8) {
        socket.emit('ww_error', 'Cần ít nhất 8 người chơi!');
        return;
      }
      
      const allReady = Object.values(room.players).every(player => player.ready);
      if (!allReady) {
        socket.emit('ww_error', 'Tất cả mọi người phải sẵn sàng!');
        return;
      }
      
      const selectedRoles = room.settings.rolesList || [];
      const hasThief = selectedRoles.includes('KE_TROM');
      const requiredCards = hasThief ? playerSids.length + 2 : playerSids.length;
      
      if (selectedRoles.length !== requiredCards) {
        socket.emit('ww_error', `Số lượng thẻ bài (${selectedRoles.length}) không khớp với yêu cầu (${requiredCards})!`);
        return;
      }
      
      const wolfCount = selectedRoles.filter(r => ROLES[r] && ROLES[r].faction === 'WOLF').length;
      if (wolfCount < 2) {
        socket.emit('ww_error', 'Phải có ít nhất 2 role phe Sói!');
        return;
      }

      // Shuffle and deal
      const deck = [...selectedRoles].sort(() => Math.random() - 0.5);
      
      for (const sid of playerSids) {
        room.players[sid].role = deck.pop();
        room.players[sid].isAlive = true;
        room.players[sid].tags = [];
      }
      
      if (hasThief) {
        room.nightState.middleCards = deck; // 2 remaining cards
        // Enforce thief pick logic if both are wolves
        const wolfCards = deck.filter(r => ROLES[r] && ROLES[r].faction === 'WOLF');
        if (wolfCards.length === 2) {
            room.nightState.thiefMustPickWolf = true;
        } else {
            room.nightState.thiefMustPickWolf = false;
        }
      }

      startNight(io, socket.wwRoomId);
    });

    socket.on('ww_night_action', (data) => {
      const room = rooms[socket.wwRoomId];
      if (!room || room.status !== 'night') return;
      
      const p = room.players[socket.id];
      if (!p || !p.isAlive) return;
      
      const currentRole = NIGHT_PRIORITY[room.nightState.activeRoleIndex];
      if (p.role !== currentRole && currentRole !== 'MA_SOI') return; // Simplified check for wolves
      if (currentRole === 'MA_SOI' && ROLES[p.role].faction !== 'WOLF') return;
      
      if (!room.nightState.actions[currentRole]) {
        room.nightState.actions[currentRole] = {};
      }
      
      room.nightState.actions[currentRole][socket.id] = data; // store their action
    });

    socket.on('ww_vote', (targetId) => {
      const room = rooms[socket.wwRoomId];
      if (!room || room.status !== 'day_voting') return;
      
      const p = room.players[socket.id];
      if (!p || !p.isAlive) return;
      
      if (room.players[targetId] && room.players[targetId].isAlive) {
        room.votes[socket.id] = targetId;
        broadcastState(io, socket.wwRoomId);
      }
    });

    socket.on('ww_hunter_shoot', (targetId) => {
      const room = rooms[socket.wwRoomId];
      if (!room || room.status !== 'hunter_action') return;
      if (room.dayState.hunterId !== socket.id) return;
      
      if (room.timerId) {
        clearInterval(room.timerId);
        room.timerId = null;
      }
      
      handleHunterAction(io, socket.wwRoomId, socket.id, targetId);
    });

    socket.on('disconnect', () => {
      const room = rooms[socket.wwRoomId];
      if (room && room.players[socket.id]) {
        room.players[socket.id].isConnected = false;
        
        if (room.status === 'waiting') {
           const wasHost = room.players[socket.id].host;
           delete room.players[socket.id];
           const remaining = Object.keys(room.players);
           if (remaining.length === 0) {
             delete rooms[socket.wwRoomId];
             return;
           }
           if (wasHost && remaining.length > 0) {
             room.players[remaining[0]].host = true;
           }
        }
        broadcastState(io, socket.wwRoomId);
      }
    });
  });
}

module.exports = { setupWerewolfSockets, ROLES };
