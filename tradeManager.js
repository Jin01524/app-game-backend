const { getOne, runSql } = require('./db');
const { parseJSON, addToBackpack, removeFromBackpack } = require('./utils');
const { v4: uuidv4 } = require('uuid');

const activeTrades = {}; // tradeId -> { p1: { socketId, username, items: [{itemId, quantity}], xu, ready, maxSlots }, p2: { socketId, username, items: [], xu, ready, maxSlots }, status }
const userToTrade = {}; // username -> tradeId

function setupTradeSockets(io) {
  io.on('connection', (socket) => {
    socket.on('trade_request', ({ targetUsername }) => {
      const p1 = socket.playerUsername;
      if (!p1 || p1 === targetUsername) return;
      if (userToTrade[p1] || userToTrade[targetUsername]) {
        return socket.emit('trade_error', 'Một trong hai người đang bận giao dịch');
      }

      // Find target socket in any room
      let targetSocket = null;
      io.sockets.sockets.forEach(s => {
        if (s.playerUsername === targetUsername) targetSocket = s;
      });

      if (!targetSocket) return socket.emit('trade_error', 'Người chơi không trực tuyến');

      targetSocket.emit('trade_requested', { from: p1 });
    });

    socket.on('trade_accept', async ({ fromUsername }) => {
      const p2 = socket.playerUsername;
      const p1 = fromUsername;
      
      let p1Socket = null;
      io.sockets.sockets.forEach(s => {
        if (s.playerUsername === p1) p1Socket = s;
      });

      if (!p1Socket) return socket.emit('trade_error', 'Người chơi kia đã thoát');
      if (userToTrade[p1] || userToTrade[p2]) return;

      const user1 = await getOne('SELECT backpack FROM users WHERE username = ?', [p1]);
      const user2 = await getOne('SELECT backpack FROM users WHERE username = ?', [p2]);

      const bp1 = parseJSON(user1?.backpack, [null, null, null, null]);
      const bp2 = parseJSON(user2?.backpack, [null, null, null, null]);

      const tradeId = uuidv4();
      activeTrades[tradeId] = {
        p1: { socketId: p1Socket.id, username: p1, items: [], xu: 0, ready: false, maxSlots: bp1.length || 4 },
        p2: { socketId: socket.id, username: p2, items: [], xu: 0, ready: false, maxSlots: bp2.length || 4 },
        status: 'active'
      };
      
      userToTrade[p1] = tradeId;
      userToTrade[p2] = tradeId;

      const initData = {
        tradeId,
        p1: { username: p1, items: [], xu: 0, ready: false },
        p2: { username: p2, items: [], xu: 0, ready: false }
      };

      p1Socket.emit('trade_started', initData);
      socket.emit('trade_started', initData);
    });

    socket.on('trade_decline', ({ fromUsername }) => {
      io.sockets.sockets.forEach(s => {
        if (s.playerUsername === fromUsername) {
          s.emit('trade_error', `${socket.playerUsername} đã từ chối giao dịch.`);
        }
      });
    });

    // P1 cancelled the request before P2 accepted - notify P2 to dismiss popup
    socket.on('trade_request_cancel', ({ targetUsername }) => {
      const p1 = socket.playerUsername;
      if (!p1) return;
      io.sockets.sockets.forEach(s => {
        if (s.playerUsername === targetUsername) {
          s.emit('trade_request_cancelled', { from: p1 });
        }
      });
    });

    socket.on('trade_update', ({ tradeId, items, xu }) => {
      const trade = activeTrades[tradeId];
      if (!trade || trade.status !== 'active') return;

      const isP1 = trade.p1.socketId === socket.id;
      const isP2 = trade.p2.socketId === socket.id;
      if (!isP1 && !isP2) return;

      const player = isP1 ? trade.p1 : trade.p2;
      const other = isP1 ? trade.p2 : trade.p1;

      // Unready both if one changes
      trade.p1.ready = false;
      trade.p2.ready = false;

      player.items = items.slice(0, 4); // max 4 slots
      player.xu = parseInt(xu) || 0;

      const updateData = {
        p1: { username: trade.p1.username, items: trade.p1.items, xu: trade.p1.xu, ready: trade.p1.ready },
        p2: { username: trade.p2.username, items: trade.p2.items, xu: trade.p2.xu, ready: trade.p2.ready }
      };

      io.to(player.socketId).emit('trade_updated', updateData);
      io.to(other.socketId).emit('trade_updated', updateData);
    });

    socket.on('trade_ready', async ({ tradeId, ready }) => {
      const trade = activeTrades[tradeId];
      if (!trade || trade.status !== 'active') return;

      const isP1 = trade.p1.socketId === socket.id;
      const isP2 = trade.p2.socketId === socket.id;
      if (!isP1 && !isP2) return;

      if (isP1) trade.p1.ready = !!ready;
      if (isP2) trade.p2.ready = !!ready;

      const updateData = {
        p1: { username: trade.p1.username, items: trade.p1.items, xu: trade.p1.xu, ready: trade.p1.ready },
        p2: { username: trade.p2.username, items: trade.p2.items, xu: trade.p2.xu, ready: trade.p2.ready }
      };

      io.to(trade.p1.socketId).emit('trade_updated', updateData);
      io.to(trade.p2.socketId).emit('trade_updated', updateData);

      if (trade.p1.ready && trade.p2.ready) {
        trade.status = 'processing';
        await executeTrade(trade, io);
      }
    });

    socket.on('trade_cancel', ({ tradeId }) => {
      const trade = activeTrades[tradeId];
      if (!trade) return;
      
      const isP1 = trade.p1.socketId === socket.id;
      const isP2 = trade.p2.socketId === socket.id;
      if (!isP1 && !isP2) return;

      io.to(trade.p1.socketId).emit('trade_cancelled');
      io.to(trade.p2.socketId).emit('trade_cancelled');
      
      delete userToTrade[trade.p1.username];
      delete userToTrade[trade.p2.username];
      delete activeTrades[tradeId];
    });

    socket.on('disconnect', () => {
      const p = socket.playerUsername;
      if (p && userToTrade[p]) {
        const tradeId = userToTrade[p];
        const trade = activeTrades[tradeId];
        if (trade) {
          io.to(trade.p1.socketId).emit('trade_cancelled', 'Đối phương đã mất kết nối');
          io.to(trade.p2.socketId).emit('trade_cancelled', 'Đối phương đã mất kết nối');
          delete userToTrade[trade.p1.username];
          delete userToTrade[trade.p2.username];
          delete activeTrades[tradeId];
        }
      }
    });
  });
}

async function executeTrade(trade, io) {
  const { p1, p2 } = trade;

  const u1 = await getOne('SELECT id, backpack, xu FROM users WHERE username = ?', [p1.username]);
  const u2 = await getOne('SELECT id, backpack, xu FROM users WHERE username = ?', [p2.username]);

  if (!u1 || !u2) return cancelWith(trade, io, 'Không tìm thấy người chơi');

  // Verify Xu
  if (u1.xu < p1.xu) return cancelWith(trade, io, `${p1.username} không đủ Xu`);
  if (u2.xu < p2.xu) return cancelWith(trade, io, `${p2.username} không đủ Xu`);

  let bp1 = parseJSON(u1.backpack, Array(p1.maxSlots).fill(null));
  let bp2 = parseJSON(u2.backpack, Array(p2.maxSlots).fill(null));

  // Verify and remove items from P1
  for (const item of p1.items) {
    const res = removeFromBackpack(bp1, item.itemId, item.quantity);
    if (!res.success) return cancelWith(trade, io, `${p1.username} không đủ vật phẩm`);
    bp1 = res.backpack;
  }
  
  // Verify and remove items from P2
  for (const item of p2.items) {
    const res = removeFromBackpack(bp2, item.itemId, item.quantity);
    if (!res.success) return cancelWith(trade, io, `${p2.username} không đủ vật phẩm`);
    bp2 = res.backpack;
  }

  // Add items to P1 (from P2)
  for (const item of p2.items) {
    const res = addToBackpack(bp1, item.itemId, item.quantity, p1.maxSlots);
    if (res.remaining > 0) return cancelWith(trade, io, `Balo ${p1.username} không đủ chỗ trống`);
    bp1 = res.backpack;
  }

  // Add items to P2 (from P1)
  for (const item of p1.items) {
    const res = addToBackpack(bp2, item.itemId, item.quantity, p2.maxSlots);
    if (res.remaining > 0) return cancelWith(trade, io, `Balo ${p2.username} không đủ chỗ trống`);
    bp2 = res.backpack;
  }

  // Swap Xu
  const newXu1 = u1.xu - p1.xu + p2.xu;
  const newXu2 = u2.xu - p2.xu + p1.xu;

  await runSql('UPDATE users SET backpack = ?, xu = ? WHERE id = ?', [JSON.stringify(bp1), newXu1, u1.id]);
  await runSql('UPDATE users SET backpack = ?, xu = ? WHERE id = ?', [JSON.stringify(bp2), newXu2, u2.id]);

  io.to(p1.socketId).emit('trade_success');
  io.to(p2.socketId).emit('trade_success');

  delete userToTrade[p1.username];
  delete userToTrade[p2.username];
  delete activeTrades[trade.tradeId];
}

function cancelWith(trade, io, reason) {
  io.to(trade.p1.socketId).emit('trade_error', reason);
  io.to(trade.p2.socketId).emit('trade_error', reason);
  io.to(trade.p1.socketId).emit('trade_cancelled', reason);
  io.to(trade.p2.socketId).emit('trade_cancelled', reason);
  delete userToTrade[trade.p1.username];
  delete userToTrade[trade.p2.username];
  delete activeTrades[trade.tradeId];
}

module.exports = { setupTradeSockets };
