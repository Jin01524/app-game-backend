const { createDeck, shuffle, evaluateHand, compareHands, HAND_TYPES } = require('./utils/xiDachLogic');
const { getOne, runSql } = require('./db');

const rooms = {};

// Max 4 players per room
function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      id: roomId,
      players: {}, // socketId: { username, displayName, bet, cards, status, result, payout }
      dealer: { cards: [], status: 'waiting' },
      deck: [],
      status: 'waiting', // waiting -> betting -> playing -> dealer_turn -> finished
      turnOrder: [],
      currentTurnIdx: -1,
      timer: null
    };
  }
  return rooms[roomId];
}

function broadcastRoom(io, roomId) {
  const room = rooms[roomId];
  if (!room) return;
  // Mask dealer's second card if not dealer_turn or finished
  let displayDealer = { ...room.dealer };
  if (['playing', 'betting'].includes(room.status) && room.dealer.cards.length >= 2) {
    displayDealer.cards = [room.dealer.cards[0], { rank: '?', suit: '?' }];
  }
  io.to(roomId).emit('xidach_state', { ...room, dealer: displayDealer });
}

async function handleBet(socket, io, roomId, amount) {
  const room = getRoom(roomId);
  if (room.status !== 'waiting' && room.status !== 'betting') return;
  if (!room.players[socket.id]) return;

  const p = room.players[socket.id];
  
  // check balance
  const user = await getOne('SELECT * FROM users WHERE username = ?', [p.username]);
  if (!user || user.xu < amount) {
    socket.emit('xidach_error', 'Không đủ Xu!');
    return;
  }

  // Deduct bet
  await runSql('UPDATE users SET xu = xu - ? WHERE username = ?', [amount, p.username]);
  p.bet = amount;
  p.status = 'ready';

  room.status = 'betting';

  // Check if all players betted
  const allReady = Object.values(room.players).every(pl => pl.status === 'ready' || pl.status === 'waiting');
  const hasBets = Object.values(room.players).some(pl => pl.bet > 0);

  if (allReady && hasBets) {
    startGame(io, roomId);
  } else {
    broadcastRoom(io, roomId);
  }
}

function startGame(io, roomId) {
  const room = getRoom(roomId);
  room.status = 'playing';
  room.deck = shuffle(createDeck());
  room.dealer.cards = [room.deck.pop(), room.deck.pop()];
  room.turnOrder = [];

  // Deal 2 cards to each playing player
  for (const [sid, p] of Object.entries(room.players)) {
    if (p.bet > 0) {
      p.cards = [room.deck.pop(), room.deck.pop()];
      p.status = 'playing';
      room.turnOrder.push(sid);
    }
  }

  room.currentTurnIdx = 0;
  
  // Check instant wins (Xì Bàng, Xì Dách) for everyone including dealer
  const dealerEval = evaluateHand(room.dealer.cards, true);
  if (dealerEval.type === HAND_TYPES.XI_BANG || dealerEval.type === HAND_TYPES.XI_DACH) {
    // Dealer has instant win -> end game immediately
    room.status = 'finished';
    finishGame(io, roomId);
    return;
  }

  // Next valid turn
  advanceTurn(io, roomId);
}

function advanceTurn(io, roomId) {
  const room = getRoom(roomId);
  
  if (room.currentTurnIdx >= room.turnOrder.length) {
    // All players done, dealer's turn
    playDealer(io, roomId);
    return;
  }

  const currentSid = room.turnOrder[room.currentTurnIdx];
  const p = room.players[currentSid];
  const pEval = evaluateHand(p.cards, false);

  if (pEval.type === HAND_TYPES.XI_BANG || pEval.type === HAND_TYPES.XI_DACH || pEval.type === HAND_TYPES.QUAC || pEval.type === HAND_TYPES.NGU_LINH || p.cards.length >= 5) {
    // Force end turn for this player
    p.status = 'stand';
    room.currentTurnIdx++;
    advanceTurn(io, roomId);
  } else {
    broadcastRoom(io, roomId);
  }
}

function handleHit(socket, io, roomId) {
  const room = getRoom(roomId);
  if (room.status !== 'playing') return;
  if (room.turnOrder[room.currentTurnIdx] !== socket.id) return;

  const p = room.players[socket.id];
  if (p.cards.length >= 5) return;

  p.cards.push(room.deck.pop());
  
  advanceTurn(io, roomId); // will check bust/ngu linh and advance if needed
}

function handleStand(socket, io, roomId) {
  const room = getRoom(roomId);
  if (room.status !== 'playing') return;
  if (room.turnOrder[room.currentTurnIdx] !== socket.id) return;

  const p = room.players[socket.id];
  const pEval = evaluateHand(p.cards, false);
  
  if (pEval.type === HAND_TYPES.NON) {
    socket.emit('xidach_error', 'Chưa đủ tuổi (16 điểm) không được dằng!');
    return;
  }

  p.status = 'stand';
  room.currentTurnIdx++;
  advanceTurn(io, roomId);
}

async function playDealer(io, roomId) {
  const room = getRoom(roomId);
  room.status = 'dealer_turn';
  broadcastRoom(io, roomId);

  const drawLoop = async () => {
    let evalDealer = evaluateHand(room.dealer.cards, true);
    if (evalDealer.type === HAND_TYPES.NON && room.dealer.cards.length < 5) {
      // Must draw
      await new Promise(r => setTimeout(r, 1000)); // 1s delay for animation
      room.dealer.cards.push(room.deck.pop());
      broadcastRoom(io, roomId);
      drawLoop();
    } else {
      // Dealer done
      await new Promise(r => setTimeout(r, 1000));
      room.status = 'finished';
      finishGame(io, roomId);
    }
  };
  
  drawLoop();
}

async function finishGame(io, roomId) {
  const room = getRoom(roomId);
  const dealerEval = evaluateHand(room.dealer.cards, true);

  for (const p of Object.values(room.players)) {
    if (p.bet > 0) {
      const pEval = evaluateHand(p.cards, false);
      const comp = compareHands(pEval, dealerEval);
      
      let payout = 0;
      if (comp > 0) {
        // Win
        payout = p.bet * 2;
        p.result = 'WIN';
      } else if (comp === 0) {
        // Tie
        payout = p.bet;
        p.result = 'TIE';
      } else {
        // Lose
        payout = 0;
        p.result = 'LOSE';
      }
      
      p.payout = payout;
      if (payout > 0) {
        await runSql('UPDATE users SET xu = xu + ? WHERE username = ?', [payout, p.username]);
      }
    }
  }

  broadcastRoom(io, roomId);

  // Reset after 5 seconds
  setTimeout(() => {
    const r = getRoom(roomId);
    if (!r) return;
    r.status = 'waiting';
    r.dealer.cards = [];
    for (const p of Object.values(r.players)) {
      p.bet = 0;
      p.cards = [];
      p.status = 'waiting';
      p.result = null;
      p.payout = 0;
    }
    broadcastRoom(io, roomId);
  }, 5000);
}


function setupXiDachSockets(io) {
  io.on('connection', (socket) => {
    let currentRoom = null;

    socket.on('join_xidach', ({ roomId, username, displayName }) => {
      socket.join(roomId);
      currentRoom = roomId;
      const room = getRoom(roomId);
      
      if (Object.keys(room.players).length >= 5) {
         socket.emit('xidach_error', 'Phòng đã đầy!');
         return;
      }

      room.players[socket.id] = {
        username,
        displayName,
        bet: 0,
        cards: [],
        status: 'waiting',
        result: null,
        payout: 0
      };
      
      broadcastRoom(io, roomId);
    });

    socket.on('xidach_bet', (amount) => {
      if (currentRoom) handleBet(socket, io, currentRoom, amount);
    });

    socket.on('xidach_hit', () => {
      if (currentRoom) handleHit(socket, io, currentRoom);
    });

    socket.on('xidach_stand', () => {
      if (currentRoom) handleStand(socket, io, currentRoom);
    });

    const leave = () => {
      if (currentRoom) {
        const room = getRoom(currentRoom);
        if (room.players[socket.id]) {
           // If they leave during play, they lose their bet (already deducted)
           delete room.players[socket.id];
        }
        broadcastRoom(io, currentRoom);
      }
    };

    socket.on('leave_xidach', leave);
    socket.on('disconnect', leave);
  });
}

module.exports = { setupXiDachSockets };
