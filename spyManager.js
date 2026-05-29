const { getOne, runSql } = require('./db');

const CATEGORIES = {
  ANIMALS: {
    name: 'Động vật',
    words: ['Chó', 'Mèo', 'Hổ', 'Sư tử', 'Báo', 'Sói', 'Cáo', 'Gấu', 'Voi', 'Hươu', 'Ngựa', 'Bò', 'Cừu', 'Dê', 'Lợn']
  },
  FOODS: {
    name: 'Đồ ăn & Trái cây',
    words: ['Táo', 'Cam', 'Lê', 'Đào', 'Chuối', 'Nho', 'Dâu tây', 'Dưa hấu', 'Xoài', 'Dứa', 'Bánh mì', 'Phở', 'Cơm', 'Bún', 'Hủ tiếu']
  },
  TOOLS: {
    name: 'Đồ gia dụng & Công cụ',
    words: ['Búa', 'Kéo', 'Dao', 'Rìu', 'Liềm', 'Chổi', 'Muỗng', 'Đũa', 'Nồi', 'Chảo', 'Bàn', 'Ghế', 'Giường', 'Tủ', 'Đèn']
  },
  ACTIONS: {
    name: 'Hành động & Trạng thái',
    words: ['Chạy', 'Nhảy', 'Đi', 'Đứng', 'Ngồi', 'Nằm', 'Ngủ', 'Khóc', 'Cười', 'Hát', 'Múa', 'Vẽ', 'Viết', 'Đọc', 'Học']
  }
};

const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      id: roomId,
      players: {}, // socketId: { username, displayName, ready, word, isSpy, isEliminated, host }
      status: 'waiting', // waiting -> discussing -> voting -> ended
      category: '',
      words: { civilian: '', spy: '' },
      timer: 0,
      timerId: null,
      round: 1,
      votes: {}, // voterSocketId: targetSocketId
      result: null // { winner: 'civilians' | 'spy', message: string, awards: { username: amount } }
    };
  }
  return rooms[roomId];
}

async function updateXu(username, amount) {
  if (amount === 0) return;
  try {
    const user = await getOne('SELECT id, xu FROM users WHERE username = ?', [username]);
    if (user) {
      const newXu = Math.max(0, user.xu + amount);
      await runSql('UPDATE users SET xu = ? WHERE id = ?', [newXu, user.id]);
    }
  } catch (err) {
    console.error(`[spyManager] Failed to update xu for ${username}:`, err.message);
  }
}

function broadcastState(io, roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // We should mask critical info (isSpy, word) unless requested by that socket
  const safePlayers = {};
  for (const [sid, p] of Object.entries(room.players)) {
    safePlayers[sid] = {
      username: p.username,
      displayName: p.displayName,
      ready: p.ready,
      isEliminated: p.isEliminated,
      host: p.host,
      voteCount: Object.values(room.votes).filter(v => v === sid).length
    };
  }

  // Send baseline status to everyone in the room
  for (const sid of Object.keys(room.players)) {
    const personalWord = room.players[sid].word || '';
    
    // Mask details for the players
    io.to(sid).emit('spy_state', {
      id: room.id,
      players: safePlayers,
      status: room.status,
      category: room.category,
      timer: room.timer,
      round: room.round,
      votes: room.votes,
      result: room.result,
      myWord: personalWord,
      myEliminated: room.players[sid].isEliminated,
      myHost: room.players[sid].host
    });
  }
}

function startGame(io, roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.status = 'discussing';
  room.round = 1;
  room.votes = {};
  room.result = null;

  // Reset player roles
  for (const p of Object.values(room.players)) {
    p.isSpy = false;
    p.word = '';
    p.isEliminated = false;
  }

  // Pick category
  const catKeys = Object.keys(CATEGORIES);
  const randomCatKey = catKeys[Math.floor(Math.random() * catKeys.length)];
  const cat = CATEGORIES[randomCatKey];
  room.category = cat.name;

  // Pick 2 random words
  const wordsList = [...cat.words];
  const idxA = Math.floor(Math.random() * wordsList.length);
  const wordA = wordsList.splice(idxA, 1)[0];
  const idxB = Math.floor(Math.random() * wordsList.length);
  const wordB = wordsList[idxB];

  room.words = { civilian: wordA, spy: wordB };

  // Select Spy
  const playerSids = Object.keys(room.players);
  const spySid = playerSids[Math.floor(Math.random() * playerSids.length)];

  for (const sid of playerSids) {
    if (sid === spySid) {
      room.players[sid].isSpy = true;
      room.players[sid].word = wordB;
    } else {
      room.players[sid].isSpy = false;
      room.players[sid].word = wordA;
    }
  }

  startDiscussingTimer(io, roomId);
}

function startDiscussingTimer(io, roomId) {
  const room = rooms[roomId];
  if (!room) return;

  if (room.timerId) clearInterval(room.timerId);
  room.timer = 30;
  broadcastState(io, roomId);

  room.timerId = setInterval(() => {
    const r = rooms[roomId];
    if (!r) {
      clearInterval(this);
      return;
    }

    r.timer--;
    if (r.timer <= 0) {
      clearInterval(r.timerId);
      r.timerId = null;
      startVoting(io, roomId);
    } else {
      broadcastState(io, roomId);
    }
  }, 1000);
}

function startVoting(io, roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.status = 'voting';
  room.votes = {};
  
  if (room.timerId) clearInterval(room.timerId);
  room.timer = 10;
  broadcastState(io, roomId);

  room.timerId = setInterval(() => {
    const r = rooms[roomId];
    if (!r) {
      clearInterval(this);
      return;
    }

    r.timer--;
    if (r.timer <= 0) {
      clearInterval(r.timerId);
      r.timerId = null;
      tallyVotes(io, roomId);
    } else {
      broadcastState(io, roomId);
    }
  }, 1000);
}

function checkAllVoted(room) {
  const alivePlayers = Object.entries(room.players).filter(([sid, p]) => !p.isEliminated);
  const votedCount = Object.keys(room.votes).length;
  return votedCount >= alivePlayers.length;
}

async function tallyVotes(io, roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const voteCounts = {};
  for (const targetSid of Object.values(room.votes)) {
    voteCounts[targetSid] = (voteCounts[targetSid] || 0) + 1;
  }

  let maxVotes = 0;
  let maxTargetSids = [];

  for (const [targetSid, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) {
      maxVotes = count;
      maxTargetSids = [targetSid];
    } else if (count === maxVotes) {
      maxTargetSids.push(targetSid);
    }
  }

  let eliminatedPlayer = null;
  let isTie = false;

  // Only eliminate if there is a single target with most votes AND at least one vote was cast
  if (maxVotes > 0 && maxTargetSids.length === 1) {
    const targetSid = maxTargetSids[0];
    if (room.players[targetSid] && !room.players[targetSid].isEliminated) {
      room.players[targetSid].isEliminated = true;
      eliminatedPlayer = room.players[targetSid];
    }
  } else {
    isTie = true;
  }

  // Tally current state of remaining players
  const alivePlayers = Object.values(room.players).filter(p => !p.isEliminated);
  const spyAlive = alivePlayers.some(p => p.isSpy);
  const civilianAliveCount = alivePlayers.filter(p => !p.isSpy).length;

  if (eliminatedPlayer && eliminatedPlayer.isSpy) {
    // Spy is eliminated -> Civilians win
    await endGame(io, roomId, 'civilians', `Gián điệp (${eliminatedPlayer.displayName}) đã bị bỏ phiếu loại! Dân thường giành chiến thắng!`);
  } else if (alivePlayers.length <= 2 && spyAlive) {
    // Spy is not eliminated, and only 2 or fewer players remain -> Spy wins
    await endGame(io, roomId, 'spy', `Gián điệp đã sống sót thành công đến vòng cuối cùng! Gián điệp giành chiến thắng!`);
  } else {
    // Continue to next round
    room.status = 'discussing';
    room.round++;
    room.votes = {};
    
    // Announce round transition message
    let announceMsg = '';
    if (isTie) {
      announceMsg = `Hòa phiếu! Không ai bị loại ở vòng này. Bắt đầu vòng ${room.round} thảo luận!`;
    } else if (eliminatedPlayer) {
      announceMsg = `${eliminatedPlayer.displayName} đã bị loại (không phải Gián điệp). Bắt đầu vòng ${room.round} thảo luận!`;
    }

    io.to(roomId).emit('spy_announcement', announceMsg);
    startDiscussingTimer(io, roomId);
  }
}

async function endGame(io, roomId, winner, message) {
  const room = rooms[roomId];
  if (!room) return;

  room.status = 'ended';
  room.timer = 0;
  if (room.timerId) {
    clearInterval(room.timerId);
    room.timerId = null;
  }

  const awards = {};
  const spyPlayer = Object.values(room.players).find(p => p.isSpy);

  if (winner === 'civilians') {
    // Reward 200 divided by number of alive civilians
    const aliveCivs = Object.values(room.players).filter(p => !p.isSpy && !p.isEliminated);
    const rewardAmount = aliveCivs.length > 0 ? Math.floor(200 / aliveCivs.length) : 50;

    for (const p of Object.values(room.players)) {
      if (!p.isSpy && !p.isEliminated) {
        awards[p.username] = rewardAmount;
        await updateXu(p.username, rewardAmount);
      }
    }
  } else if (winner === 'spy' && spyPlayer) {
    // Reward 100 to the spy
    awards[spyPlayer.username] = 100;
    await updateXu(spyPlayer.username, 100);
  }

  // Include full actual roles and words in result
  const playerRoles = {};
  for (const [sid, p] of Object.entries(room.players)) {
    playerRoles[sid] = {
      username: p.username,
      displayName: p.displayName,
      isSpy: p.isSpy,
      word: p.word
    };
  }

  room.result = {
    winner,
    message,
    awards,
    playerRoles,
    words: room.words
  };

  broadcastState(io, roomId);

  // Auto reset room back to waiting lobby after 8 seconds
  setTimeout(() => {
    const r = rooms[roomId];
    if (!r || r.status !== 'ended') return;

    r.status = 'waiting';
    r.category = '';
    r.words = { civilian: '', spy: '' };
    r.round = 1;
    r.votes = {};
    r.result = null;

    // Reset player roles and words, and reset ready states
    for (const p of Object.values(r.players)) {
      p.isSpy = false;
      p.word = '';
      p.isEliminated = false;
      p.ready = false;
    }

    broadcastState(io, roomId);
  }, 8000);
}

function handlePlayerLeave(io, socket) {
  const roomId = socket.spyRoomId;
  if (!roomId) return;
  const room = rooms[roomId];
  if (!room) return;

  const wasHost = room.players[socket.id] ? room.players[socket.id].host : false;
  delete room.players[socket.id];

  // If room is empty, clean it up
  const playerCount = Object.keys(room.players).length;
  if (playerCount === 0) {
    if (room.timerId) clearInterval(room.timerId);
    delete rooms[roomId];
    return;
  }

  // Re-elect host if necessary
  if (wasHost && playerCount > 0) {
    const nextSid = Object.keys(room.players)[0];
    room.players[nextSid].host = true;
  }

  // If game is active, check if disconnection ends game or triggers recalculation
  if (room.status === 'discussing' || room.status === 'voting') {
    const alivePlayers = Object.values(room.players).filter(p => !p.isEliminated);
    const spyAlive = alivePlayers.some(p => p.isSpy);

    if (!spyAlive) {
      // Spy disconnected -> Civilians win
      endGame(io, roomId, 'civilians', 'Gián điệp đã rời phòng! Dân thường giành chiến thắng!');
    } else if (alivePlayers.length <= 2) {
      // Civilian disconnected and now <= 2 players remain -> Spy wins
      endGame(io, roomId, 'spy', 'Có người chơi rời phòng, khiến số lượng người chơi còn lại quá ít! Gián điệp giành chiến thắng!');
    } else {
      // Recalculate if in voting state and all remaining alive players have voted
      if (room.status === 'voting') {
        // Remove votes cast by the disconnected player
        delete room.votes[socket.id];
        
        // Remove votes cast *to* the disconnected player
        for (const [voter, target] of Object.entries(room.votes)) {
          if (target === socket.id) {
            delete room.votes[voter];
          }
        }

        if (checkAllVoted(room)) {
          if (room.timerId) clearInterval(room.timerId);
          room.timerId = null;
          tallyVotes(io, roomId);
        }
      }
      broadcastState(io, roomId);
    }
  } else {
    broadcastState(io, roomId);
  }
}

function setupSpySockets(io) {
  io.on('connection', (socket) => {
    socket.on('spy_join', ({ roomId, username, displayName }) => {
      socket.join(roomId);
      socket.spyRoomId = roomId;

      const room = getRoom(roomId);

      // Check if room is active to prevent mid-game joining
      if (room.status !== 'waiting') {
        socket.emit('spy_error', 'Trò chơi đã bắt đầu, vui lòng đợi ván sau!');
        return;
      }

      const isFirst = Object.keys(room.players).length === 0;

      room.players[socket.id] = {
        username,
        displayName,
        ready: isFirst, // Host is auto-ready
        isSpy: false,
        word: '',
        isEliminated: false,
        host: isFirst
      };

      broadcastState(io, roomId);
    });

    socket.on('spy_ready', () => {
      const roomId = socket.spyRoomId;
      if (!roomId) return;
      const room = rooms[roomId];
      if (!room || room.status !== 'waiting') return;

      const p = room.players[socket.id];
      if (p) {
        p.ready = !p.ready;
        broadcastState(io, roomId);
      }
    });

    socket.on('spy_start', () => {
      const roomId = socket.spyRoomId;
      if (!roomId) return;
      const room = rooms[roomId];
      if (!room || room.status !== 'waiting') return;

      const p = room.players[socket.id];
      if (!p || !p.host) {
        socket.emit('spy_error', 'Chỉ có Chủ phòng mới có quyền bắt đầu trò chơi!');
        return;
      }

      const pCount = Object.keys(room.players).length;
      if (pCount < 3) {
        socket.emit('spy_error', 'Cần tối thiểu 3 người chơi để bắt đầu!');
        return;
      }

      const allReady = Object.values(room.players).every(player => player.ready);
      if (!allReady) {
        socket.emit('spy_error', 'Tất cả mọi người phải sẵn sàng mới có thể bắt đầu!');
        return;
      }

      startGame(io, roomId);
    });

    socket.on('spy_vote', ({ targetSocketId }) => {
      const roomId = socket.spyRoomId;
      if (!roomId) return;
      const room = rooms[roomId];
      if (!room || room.status !== 'voting') return;

      const p = room.players[socket.id];
      if (!p || p.isEliminated) return;

      // Validate target
      const target = room.players[targetSocketId];
      if (!target || target.isEliminated) return;

      room.votes[socket.id] = targetSocketId;
      broadcastState(io, roomId);

      // If everyone has voted, trigger vote tallying early
      if (checkAllVoted(room)) {
        if (room.timerId) clearInterval(room.timerId);
        room.timerId = null;
        tallyVotes(io, roomId);
      }
    });

    socket.on('spy_leave', () => {
      handlePlayerLeave(io, socket);
      socket.leave(socket.spyRoomId);
      socket.spyRoomId = null;
    });

    socket.on('disconnect', () => {
      handlePlayerLeave(io, socket);
    });
  });
}

module.exports = { setupSpySockets };
