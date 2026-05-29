const { createDeck, shuffle, sortCards, evaluateCombo, canBeat, botPlay } = require('./utils/tienLenLogic');
const { getOne, runSql } = require('./db');
const questManager = require('./questManager');

const rooms = {};

function getRoom(hostUsername) {
  if (!rooms[hostUsername]) {
    rooms[hostUsername] = {
      players: [null, null, null, null], // fixed 4 slots. Bottom(0), Right(1), Top(2), Left(3) for player 0.
      spectators: [], // { socketId, username, displayName, wantsToJoin }
      status: 'waiting',
      turn: -1,
      tableCards: [],
      lastCombo: null,
      lastPlayerIdx: -1,
      winners: [],
      botBets: 0 // to track total bot bets
    };
  }
  return rooms[hostUsername];
}

function broadcastState(io, hostUsername) {
  const room = rooms[hostUsername];
  if (!room) return;
  // Hide other players' cards for clients, only send counts unless it's their own cards.
  // Actually, we should send individual state to each player so they can't cheat, but to keep it simple, we can send hidden cards.
  io.to(hostUsername).emit('tl_state', getSafeState(room));
}

function getSafeState(room) {
  const safeRoom = JSON.parse(JSON.stringify(room));
  safeRoom.players = safeRoom.players.map(p => {
    if (!p) return null;
    return {
      ...p,
      cardsCount: p.cards ? p.cards.length : 0,
      cards: [] // hide by default, client will request their own hand or we send it individually?
    };
  });
  return safeRoom;
}

// Since getSafeState hides cards, we need a way to send personal hands.
function sendPersonalStates(io, hostUsername) {
  const room = rooms[hostUsername];
  if (!room) return;
  const safeRoom = getSafeState(room);
  
  // Broadcast safe state to all
  io.to(`tl_${hostUsername}`).emit('tl_state', safeRoom);

  // Send personal hands
  room.players.forEach((p, idx) => {
    if (p && !p.isBot) {
      io.to(p.socketId).emit('tl_hand', p.cards || []);
      io.to(p.socketId).emit('tl_slot', idx);
    }
  });

  room.spectators.forEach(s => {
    if (s && s.socketId) {
      io.to(s.socketId).emit('tl_slot', -1);
      io.to(s.socketId).emit('tl_hand', []);
    }
  });
}

async function updateXu(username, amount) {
  if (amount === 0) return;
  const user = await getOne('SELECT id, xu FROM users WHERE username = ?', [username]);
  if (user) {
    const newXu = Math.max(0, user.xu + amount);
    await runSql('UPDATE users SET xu = ? WHERE id = ?', [newXu, user.id]);
  }
}

function startRound(io, hostUsername) {
  const room = rooms[hostUsername];
  
  // Calculate bot bets
  let minHumanBet = Infinity;
  let humanCount = 0;
  let botCount = 0;
  room.players.forEach(p => {
    if (p && !p.isBot) {
      if (p.bet < minHumanBet) minHumanBet = p.bet;
      humanCount++;
    } else if (p && p.isBot) {
      botCount++;
    }
  });

  if (humanCount > 0 && botCount > 0) {
    const totalBotBet = minHumanBet;
    const betPerBot = Math.floor(totalBotBet / botCount);
    room.players.forEach(p => {
      if (p && p.isBot) {
        p.bet = betPerBot;
      }
    });
  }

  room.status = 'playing';
  room.winners = [];
  const deck = shuffle(createDeck());
  
  room.players.forEach((p, i) => {
    if (p) {
      p.cards = sortCards(deck.slice(i * 13, (i + 1) * 13));
      p.passed = false;
      // Deduct bet from humans
      if (!p.isBot) updateXu(p.username, -p.bet);
    }
  });

  room.tableCards = [];
  room.lastCombo = null;
  room.lastPlayerIdx = -1;

  // Find 3 Bích
  let startingTurn = 0;
  for (let i = 0; i < 4; i++) {
    if (room.players[i] && room.players[i].cards.includes('3S')) {
      startingTurn = i;
      break;
    }
  }
  room.turn = startingTurn;
  
  sendPersonalStates(io, hostUsername);
  checkBotTurn(io, hostUsername);
}

function checkBotTurn(io, hostUsername) {
  const room = rooms[hostUsername];
  if (!room || room.status !== 'playing' || room.turn === -1) return;
  
  const currentPlayer = room.players[room.turn];
  if (currentPlayer && currentPlayer.isBot && !currentPlayer.passed) {
    setTimeout(() => {
      // Refresh room state just in case
      const currentRoom = rooms[hostUsername];
      if (!currentRoom || currentRoom.status !== 'playing' || currentRoom.turn !== room.turn) return;
      
      const hand = currentPlayer.cards;
      const comboToBeat = (currentRoom.lastPlayerIdx === currentRoom.turn || currentRoom.lastCombo === null) ? null : currentRoom.lastCombo;
      const playCards = botPlay(hand, comboToBeat);
      
      if (playCards.length > 0) {
        handlePlay(io, hostUsername, room.turn, playCards);
      } else {
        handlePass(io, hostUsername, room.turn);
      }
    }, 1500); // 1.5s bot delay
  }
}

function handlePlay(io, hostUsername, playerIdx, cards) {
  const room = rooms[hostUsername];
  if (!room || room.status !== 'playing') return;
  
  const player = room.players[playerIdx];
  player.cards = player.cards.filter(c => !cards.includes(c));
  
  room.tableCards = cards;
  room.lastCombo = evaluateCombo(cards);
  room.lastPlayerIdx = playerIdx;
  
  if (player.cards.length === 0) {
    room.winners.push(player);
    // Remove them from active play
    player.passed = true;
    
    // Check if game over
    const activePlayers = room.players.filter(p => p && p.cards.length > 0);
    if (activePlayers.length <= 1) {
      if (activePlayers.length === 1) {
        room.winners.push(activePlayers[0]);
      }
      room.status = 'ended';
      sendPersonalStates(io, hostUsername);
      setTimeout(() => {
        endRound(io, hostUsername);
      }, 5000);
      return;
    }
  }
  
  nextTurn(io, hostUsername, playerIdx);
}

function handlePass(io, hostUsername, playerIdx) {
  const room = rooms[hostUsername];
  if (!room || room.status !== 'playing') return;
  
  const player = room.players[playerIdx];
  player.passed = true;
  
  const activeCount = room.players.filter(p => p && !p.passed && p.cards.length > 0).length;
  if (activeCount <= 1) {
    // New round
    let next = room.lastPlayerIdx;
    
    // If the last player who played already won, they can't start the new round.
    // The next available player should start.
    if (room.players[next].cards.length === 0) {
      next = (next + 1) % 4;
      while (room.players[next] && room.players[next].cards.length === 0) {
        next = (next + 1) % 4;
      }
    }
    
    room.players.forEach(p => { if (p && p.cards.length > 0) p.passed = false; });
    room.lastCombo = null;
    room.tableCards = [];
    room.turn = next;
    sendPersonalStates(io, hostUsername);
    checkBotTurn(io, hostUsername);
  } else {
    nextTurn(io, hostUsername, playerIdx);
  }
}

function nextTurn(io, hostUsername, playerIdx) {
  const room = rooms[hostUsername];
  let next = (playerIdx + 1) % 4;
  while ((!room.players[next] || room.players[next].passed || room.players[next].cards.length === 0) && next !== playerIdx) {
    next = (next + 1) % 4;
  }
  room.turn = next;
  sendPersonalStates(io, hostUsername);
  checkBotTurn(io, hostUsername);
}

function endRound(io, hostUsername) {
  const room = rooms[hostUsername];
  room.status = 'waiting';
  room.turn = -1;
  
  // Payout: 1st eats 4th, 2nd eats 3rd.
  // We need to handle bots as well. Bots don't have DB accounts, so we only update humans.
  const w1 = room.winners[0];
  const w2 = room.winners[1];
  const w3 = room.winners[2];
  const w4 = room.winners[3];
  
  if (w1 && w4) {
    if (!w1.isBot) updateXu(w1.username, w1.bet + w4.bet); // w1 gets their bet back + w4's bet
    if (!w4.isBot) {} // w4 already lost bet at start
  }
  if (w2 && w3) {
    if (!w2.isBot) updateXu(w2.username, w2.bet + w3.bet);
    if (!w3.isBot) {} 
  }

  // Update quest progress for playing a lobby game
  room.players.forEach(async (p) => {
    if (p && !p.isBot) {
      try {
        const user = await getOne('SELECT id FROM users WHERE username = ?', [p.username]);
        if (user) {
          await questManager.updateQuestProgress(user.id, 'choi_lobby_game', 1);
        }
      } catch (err) {
        console.error("Error updating Tien Len quest progress in endRound:", err);
      }
    }
  });
  
  // Replace bots with waiting spectators
  const waitingSpectators = room.spectators.filter(s => s.wantsToJoin);
  for (let i = 0; i < 4; i++) {
    if (room.players[i] && room.players[i].isBot && waitingSpectators.length > 0) {
      const spec = waitingSpectators.shift();
      room.players[i] = {
        socketId: spec.socketId,
        username: spec.username,
        displayName: spec.displayName,
        isBot: false,
        bet: 0,
        ready: false,
        cards: [],
        passed: false
      };
      // Remove from spectators
      room.spectators = room.spectators.filter(s => s.socketId !== spec.socketId);
    } else if (room.players[i] && !room.players[i].isBot) {
      room.players[i].ready = false;
      room.players[i].cards = [];
    }
  }
  
  sendPersonalStates(io, hostUsername);
}

function handlePlayerLeave(io, socket) {
  const hostUsername = socket.hostUsername;
  if (!hostUsername) return;
  const room = rooms[hostUsername];
  if (!room) return;
  
  // Remove from spectators
  room.spectators = room.spectators.filter(s => s.socketId !== socket.id);
  
  // Check if they are a player
  let playerIdx = -1;
  for (let i = 0; i < 4; i++) {
    if (room.players[i] && room.players[i].socketId === socket.id) {
      playerIdx = i;
      break;
    }
  }
  
  if (playerIdx !== -1) {
    if (room.status === 'playing') {
      // Penalize: give their bet to 1st place when game ends? 
      // Actually, just replace them with a bot that takes over. 
      // Their bet is already deducted. If they leave, the bot finishes the game for them.
      // If the bot wins, the bet is lost into the void (since bot has no DB).
      room.players[playerIdx].isBot = true;
      room.players[playerIdx].username = `Bot (Thế mạng ${room.players[playerIdx].displayName})`;
      
      // If it's their turn, trigger bot
      if (room.turn === playerIdx) {
        checkBotTurn(io, hostUsername);
      }
    } else {
      // Waiting status, just replace with a Bot
      room.players[playerIdx] = {
        socketId: null,
        username: `Bot ${playerIdx + 1}`,
        displayName: `Bot ${playerIdx + 1}`,
        isBot: true,
        bet: 0,
        ready: true, // bots are always ready
        cards: [],
        passed: false
      };
    }
  }
  
  sendPersonalStates(io, hostUsername);
  
  // Check if room is all bots and empty
  const hasHuman = room.players.some(p => p && !p.isBot) || room.spectators.length > 0;
  if (!hasHuman) {
    delete rooms[hostUsername];
  }
}

function setupTienLenSockets(io) {
  io.on('connection', (socket) => {
    socket.on('tl_join', ({ hostUsername, username, displayName }) => {
      socket.join(`tl_${hostUsername}`);
      const room = getRoom(hostUsername);
      
      // Check if they are already in the room (reconnect)
      let existingIdx = room.players.findIndex(p => p && !p.isBot && p.username === username);
      if (existingIdx !== -1) {
        room.players[existingIdx].socketId = socket.id;
        sendPersonalStates(io, hostUsername);
        return;
      }
      
      // Check if they can sit
      let seated = false;
      if (room.status === 'waiting') {
        for (let i = 0; i < 4; i++) {
          if (!room.players[i] || room.players[i].isBot) {
            room.players[i] = {
              socketId: socket.id,
              username,
              displayName,
              isBot: false,
              bet: 0,
              ready: false,
              cards: [],
              passed: false
            };
            seated = true;
            break;
          }
        }
      }
      
      if (!seated) {
        // Add to spectators if not already one
        if (!room.spectators.find(s => s.socketId === socket.id)) {
          room.spectators.push({
            socketId: socket.id,
            username,
            displayName,
            wantsToJoin: false
          });
        }
      } else {
        // Remove from spectators if they were one
        room.spectators = room.spectators.filter(s => s.socketId !== socket.id);
      }
      
      // Ensure remaining slots are filled with ready bots
      for (let i = 0; i < 4; i++) {
        if (!room.players[i]) {
          room.players[i] = {
            socketId: null,
            username: `Bot ${i + 1}`,
            displayName: `Bot ${i + 1}`,
            isBot: true,
            bet: 0,
            ready: true,
            cards: [],
            passed: false
          };
        }
      }
      
      sendPersonalStates(io, hostUsername);
    });

    socket.on('tl_bet', ({ hostUsername, bet }) => {
      const room = rooms[hostUsername];
      if (!room || room.status !== 'waiting') return;
      const p = room.players.find(p => p && p.socketId === socket.id);
      if (p) {
        p.bet = bet;
        sendPersonalStates(io, hostUsername);
      }
    });

    socket.on('tl_ready', async ({ hostUsername }) => {
      const room = rooms[hostUsername];
      if (!room || room.status !== 'waiting') return;
      
      // Check user balance
      const p = room.players.find(p => p && p.socketId === socket.id);
      if (p) {
        const user = await getOne('SELECT xu FROM users WHERE username = ?', [p.username]);
        if (user && user.xu >= p.bet) {
          p.ready = true;
        } else {
          socket.emit('tl_error', 'Không đủ xu!');
          return;
        }
      }
      
      // Check if all humans are ready
      const humans = room.players.filter(p => p && !p.isBot);
      const allReady = humans.every(h => h.ready);
      if (allReady && humans.length > 0) {
        startRound(io, hostUsername);
      } else {
        sendPersonalStates(io, hostUsername);
      }
    });

    socket.on('tl_play', ({ hostUsername, cards }) => {
      const room = rooms[hostUsername];
      if (!room || room.status !== 'playing') return;
      
      const pIdx = room.players.findIndex(p => p && p.socketId === socket.id);
      if (pIdx === -1 || pIdx !== room.turn) return;
      
      handlePlay(io, hostUsername, pIdx, cards);
    });

    socket.on('tl_pass', ({ hostUsername }) => {
      const room = rooms[hostUsername];
      if (!room || room.status !== 'playing') return;
      
      const pIdx = room.players.findIndex(p => p && p.socketId === socket.id);
      if (pIdx === -1 || pIdx !== room.turn) return;
      
      handlePass(io, hostUsername, pIdx);
    });

    socket.on('tl_spectator_join', ({ hostUsername }) => {
      const room = rooms[hostUsername];
      if (!room) return;
      const spec = room.spectators.find(s => s.socketId === socket.id);
      if (spec) {
        spec.wantsToJoin = true;
        sendPersonalStates(io, hostUsername);
      }
    });

    socket.on('tl_leave_seat', ({ hostUsername }) => {
      const room = rooms[hostUsername];
      if (!room || room.status !== 'waiting') return;
      const pIdx = room.players.findIndex(p => p && p.socketId === socket.id);
      if (pIdx !== -1) {
        const player = room.players[pIdx];
        room.players[pIdx] = {
            socketId: null,
            username: `Bot ${pIdx + 1}`,
            displayName: `Bot ${pIdx + 1}`,
            isBot: true,
            bet: 0,
            ready: true,
            cards: [],
            passed: false
        };
        room.spectators.push({
          socketId: player.socketId,
          username: player.username,
          displayName: player.displayName,
          wantsToJoin: false
        });
        sendPersonalStates(io, hostUsername);
      }
    });

    socket.on('tl_leave', () => {
      handlePlayerLeave(io, socket);
    });

    socket.on('disconnect', () => {
      handlePlayerLeave(io, socket);
    });
  });
}

module.exports = { setupTienLenSockets };
