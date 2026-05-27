const { getOne, runSql } = require('./db');

const rooms = {};

// Bot names to pick from
const botNames = ['Bot_Ninja', 'Bot_Shadow', 'Bot_Frog', 'Bot_Assassin', 'Bot_Swift', 'Bot_Blade'];

function getRoom(hostUsername) {
  if (!rooms[hostUsername]) {
    rooms[hostUsername] = {
      host: hostUsername,
      players: {}, // key: username (or botId), value: player stats
      status: 'waiting', // waiting, playing, ended
      timer: 0,
      intervalId: null,
      projectiles: [], // { id, x, y, vx, vy, ownerId, startX, startY }
      projectileIdCounter: 0
    };
  }
  return rooms[hostUsername];
}

function broadcastState(io, hostUsername) {
  const room = rooms[hostUsername];
  if (!room) return;
  io.to(hostUsername).emit('shuriken_state', {
    status: room.status,
    timer: room.timer,
    players: room.players,
    projectiles: room.projectiles,
    host: room.host
  });
}

function stopGameLoop(room) {
  if (room.intervalId) {
    clearInterval(room.intervalId);
    room.intervalId = null;
  }
}

function startGameLoop(io, hostUsername) {
  const room = rooms[hostUsername];
  if (!room) return;

  stopGameLoop(room);
  room.timer = 90; // 1m30s
  room.status = 'playing';
  room.projectiles = [];

  // Reset player stats
  Object.values(room.players).forEach(p => {
    p.hp = 5;
    p.maxAmmo = 3;
    p.ammo = 3;
    p.hits = 0;
    p.taken = 0;
    p.kills = 0;
    p.isInvulnerable = true;
    p.invulnerableTimer = 3;
    p.x = 200 + Math.random() * 400; // spawn in middle
    p.y = 100;
    p.vx = 0;
    p.vy = 0;
    p.isDead = false;
    p.isAfk = false;
  });

  broadcastState(io, hostUsername);

  room.intervalId = setInterval(() => {
    updateGameLogic(io, hostUsername);
  }, 1000 / 30); // 30 FPS server loop
}

function updateGameLogic(io, hostUsername) {
  const room = rooms[hostUsername];
  if (!room || room.status !== 'playing') return;

  let timeTicked = false;
  if (!room.lastTick) room.lastTick = Date.now();
  const now = Date.now();
  const dt = (now - room.lastTick) / 1000;
  
  if (now - room.lastTimerUpdate >= 1000) {
    room.timer -= 1;
    room.lastTimerUpdate = now;
    timeTicked = true;

    // Handle invulnerability countdown
    Object.values(room.players).forEach(p => {
      if (p.invulnerableTimer > 0) p.invulnerableTimer--;
      else p.isInvulnerable = false;
    });

    // Sudden death check
    if (room.timer === 30) {
      Object.values(room.players).forEach(p => {
        if (!p.isDead) {
          p.maxAmmo = 5;
          p.ammo = Math.min(p.ammo + 2, p.maxAmmo); // give them the ammo immediately
        }
      });
      io.to(hostUsername).emit('shuriken_event', { type: 'sudden_death' });
    }
  }
  room.lastTick = now;

  // Update projectiles
  for (let i = room.projectiles.length - 1; i >= 0; i--) {
    let proj = room.projectiles[i];
    proj.x += proj.vx * dt;
    proj.y += proj.vy * dt;

    // Check distance limit (900px)
    const distSq = (proj.x - proj.startX)**2 + (proj.y - proj.startY)**2;
    if (distSq > 900 * 900) {
      room.projectiles.splice(i, 1);
      continue;
    }

    // Check collisions with players
    let hitSomeone = false;
    for (const targetId in room.players) {
      const target = room.players[targetId];
      if (targetId === proj.ownerId || target.isDead || target.isInvulnerable) continue;

      // Simple AABB / Distance check
      // Frog size is approx 32x32, hitbox radius ~ 20
      const dx = target.x - proj.x;
      const dy = target.y - proj.y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      
      if (dist < 30) {
        // HIT!
        hitSomeone = true;
        target.hp -= 1;
        target.taken += 1;
        
        const attacker = room.players[proj.ownerId];
        if (attacker) attacker.hits += 1;
        
        io.to(hostUsername).emit('shuriken_event', { type: 'hit', targetId, attackerId: proj.ownerId });

        if (target.hp <= 0) {
          target.hp = 0;
          target.isDead = true;
          if (attacker) {
            attacker.kills += 1;
            attacker.hp = Math.min(attacker.hp + 1, 5); // Heal on kill
          }
          io.to(hostUsername).emit('shuriken_event', { type: 'kill', targetId, attackerId: proj.ownerId });
        }
        break;
      }
    }

    if (hitSomeone) {
      room.projectiles.splice(i, 1);
    }
  }

  // Update Bots AI
  updateBots(room, dt);

  // Check end game conditions
  const alivePlayers = Object.values(room.players).filter(p => !p.isDead);
  if (room.timer <= 0 || alivePlayers.length <= 1) {
    endGame(io, hostUsername);
  } else {
    // We broadcast state relatively frequently but to save bandwidth we could send 10fps, but 30fps is fine for small rooms.
    broadcastState(io, hostUsername);
  }
}

function updateBots(room, dt) {
  const alivePlayers = Object.values(room.players).filter(p => !p.isDead);
  if (alivePlayers.length === 0) return;

  Object.values(room.players).forEach(bot => {
    if (!bot.isBot || bot.isDead) return;
    
    // Simple Bot AI
    if (!bot.aiState) bot.aiState = { dir: 1, lastThink: 0, lastShoot: 0 };
    
    bot.x += bot.aiState.dir * 150 * dt; // walk speed
    
    // Bounds check
    if (bot.x < 50) { bot.aiState.dir = 1; bot.x = 50; }
    if (bot.x > 750) { bot.aiState.dir = -1; bot.x = 750; } // Assuming 800px width game area

    const now = Date.now();
    // Randomly change direction/jump
    if (now - bot.aiState.lastThink > 2000) {
      if (Math.random() < 0.3) bot.aiState.dir *= -1;
      // Simple jump
      if (Math.random() < 0.4 && bot.y >= 300) {
        bot.vy = -400; // Jump force
      }
      bot.aiState.lastThink = now;
    }

    // Apply gravity to bot
    if (bot.y < 300) { // Assuming 300 is ground level
      bot.vy += 1000 * dt;
    } else {
      bot.y = 300;
      bot.vy = 0;
    }
    bot.y += bot.vy * dt;

    // Shoot at nearest
    if (bot.ammo > 0 && !bot.isInvulnerable && now - bot.aiState.lastShoot > (bot.difficulty === 'hard' ? 800 : 1500)) {
      let nearest = null;
      let minDist = Infinity;
      alivePlayers.forEach(p => {
        if (p.id !== bot.id && !p.isInvulnerable) {
          const dist = Math.sqrt((p.x - bot.x)**2 + (p.y - bot.y)**2);
          if (dist < minDist) { minDist = dist; nearest = p; }
        }
      });

      if (nearest && minDist < 600) {
        bot.ammo--;
        bot.aiState.lastShoot = now;
        
        // Calculate angle
        const dx = nearest.x - bot.x;
        const dy = nearest.y - bot.y;
        const angle = Math.atan2(dy, dx);
        
        const speed = 600;
        room.projectiles.push({
          id: room.projectileIdCounter++,
          ownerId: bot.id,
          x: bot.x,
          y: bot.y,
          startX: bot.x,
          startY: bot.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed
        });

        // Trigger reload
        setTimeout(() => {
          if (room && room.status === 'playing' && bot && bot.ammo < bot.maxAmmo) {
            bot.ammo++;
          }
        }, 500);
      }
    }
  });
}

function endGame(io, hostUsername) {
  const room = rooms[hostUsername];
  stopGameLoop(room);
  room.status = 'ended';
  
  const hasBot = Object.values(room.players).some(p => p.isBot);
  
  // Distribute rewards
  const alivePlayers = Object.values(room.players).filter(p => !p.isDead);
  
  Object.values(room.players).forEach(async (p) => {
    if (p.isBot) return;
    
    let reward = 0;
    // Standard rewards
    let hitReward = p.hits * 5;
    let killReward = p.kills * 20;
    let surviveReward = (p.isDead === false && alivePlayers.length === 1) ? 50 : 0;
    
    // Halve if bot exists
    if (hasBot) {
      hitReward = Math.floor(hitReward / 2);
      killReward = Math.floor(killReward / 2);
      surviveReward = Math.floor(surviveReward / 2);
    }
    
    reward = hitReward + killReward + surviveReward;
    
    // AFK penalty
    if (p.isAfk) {
      reward -= 20;
    }
    
    p.finalReward = reward; // Attach to send in results
    
    if (reward !== 0) {
      // Find db user and update xu
      try {
        const user = await getOne("SELECT * FROM users WHERE username = ?", [p.username]);
        if (user) {
          const newXu = Math.max(0, user.xu + reward);
          await runSql("UPDATE users SET xu = ? WHERE username = ?", [newXu, p.username]);
        }
      } catch (err) {
        console.error("Error updating xu in shuriken:", err);
      }
    }
  });

  broadcastState(io, hostUsername);
}

function setupShurikenSockets(io) {
  io.on('connection', (socket) => {
    
    socket.on('shuriken_create_room', () => {
      if (!socket.user) return;
      const hostUsername = socket.user.username;
      
      const room = getRoom(hostUsername);
      room.host = hostUsername;
      room.status = 'waiting';
      room.players = {
        [hostUsername]: {
          id: hostUsername,
          username: hostUsername,
          displayName: socket.user.displayName,
          isBot: false,
          isReady: true // host is always ready
        }
      };
      
      socket.join(`shuriken_${hostUsername}`);
      broadcastState(io, hostUsername);
    });

    socket.on('shuriken_join_room', ({ hostUsername }) => {
      if (!socket.user) return;
      const room = rooms[hostUsername];
      if (!room || room.status !== 'waiting') return; // Can only join if waiting
      
      const username = socket.user.username;
      room.players[username] = {
        id: username,
        username: username,
        displayName: socket.user.displayName,
        isBot: false,
        isReady: false
      };
      
      socket.join(`shuriken_${hostUsername}`);
      broadcastState(io, hostUsername);
    });

    socket.on('shuriken_leave_room', ({ hostUsername }) => {
      if (!socket.user) return;
      const room = rooms[hostUsername];
      if (!room) return;
      
      const username = socket.user.username;
      if (room.status === 'playing') {
        // Disconnect during game -> AFK
        if (room.players[username]) {
          room.players[username].isAfk = true;
          room.players[username].isReady = false;
        }
      } else {
        // Waiting -> just remove
        delete room.players[username];
        if (username === room.host) {
          // If host leaves, close room or transfer. Let's just destroy it for simplicity.
          io.to(`shuriken_${hostUsername}`).emit('shuriken_room_closed');
          delete rooms[hostUsername];
          return;
        }
      }
      
      socket.leave(`shuriken_${hostUsername}`);
      broadcastState(io, hostUsername);
    });

    socket.on('shuriken_add_bot', ({ hostUsername }) => {
      if (!socket.user || socket.user.username !== hostUsername) return;
      const room = rooms[hostUsername];
      if (!room || room.status !== 'waiting') return;

      const botCount = Object.values(room.players).filter(p => p.isBot).length;
      if (botCount >= 4) return;

      const botId = `bot_${Date.now()}_${Math.floor(Math.random()*1000)}`;
      room.players[botId] = {
        id: botId,
        username: botId,
        displayName: botNames[Math.floor(Math.random() * botNames.length)],
        isBot: true,
        isReady: true
      };

      // Recalculate bot difficulty (1/3 Hard, 2/3 Easy). 1 bot = Hard.
      const bots = Object.values(room.players).filter(p => p.isBot);
      if (bots.length === 1) {
        bots[0].difficulty = 'hard';
      } else {
        const hardCount = Math.ceil(bots.length / 3);
        bots.forEach((b, idx) => {
          b.difficulty = idx < hardCount ? 'hard' : 'easy';
        });
      }

      broadcastState(io, hostUsername);
    });

    socket.on('shuriken_remove_bot', ({ hostUsername, botId }) => {
      if (!socket.user || socket.user.username !== hostUsername) return;
      const room = rooms[hostUsername];
      if (!room || room.status !== 'waiting') return;
      
      if (room.players[botId] && room.players[botId].isBot) {
        delete room.players[botId];
        broadcastState(io, hostUsername);
      }
    });

    socket.on('shuriken_ready', ({ hostUsername }) => {
      if (!socket.user) return;
      const room = rooms[hostUsername];
      if (!room || room.status !== 'waiting') return;
      
      if (room.players[socket.user.username]) {
        room.players[socket.user.username].isReady = true;
        broadcastState(io, hostUsername);
      }
    });

    socket.on('shuriken_start_game', ({ hostUsername }) => {
      if (!socket.user || socket.user.username !== hostUsername) return;
      const room = rooms[hostUsername];
      if (!room || room.status !== 'waiting') return;
      
      const allReady = Object.values(room.players).every(p => p.isReady);
      if (!allReady) return;

      startGameLoop(io, hostUsername);
    });

    socket.on('shuriken_player_move', ({ hostUsername, x, y, vy, isWalking, dirX }) => {
      if (!socket.user) return;
      const room = rooms[hostUsername];
      if (!room || room.status !== 'playing') return;

      const p = room.players[socket.user.username];
      if (p && !p.isDead && !p.isAfk) {
        p.x = x;
        p.y = y;
        p.vy = vy;
        p.isWalking = isWalking;
        p.dirX = dirX;
      }
    });

    socket.on('shuriken_shoot', ({ hostUsername, angle }) => {
      if (!socket.user) return;
      const room = rooms[hostUsername];
      if (!room || room.status !== 'playing') return;

      const p = room.players[socket.user.username];
      if (p && !p.isDead && !p.isAfk && p.ammo > 0) {
        p.ammo--;
        
        const speed = 600;
        room.projectiles.push({
          id: room.projectileIdCounter++,
          ownerId: p.id,
          x: p.x,
          y: p.y,
          startX: p.x,
          startY: p.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed
        });

        // Trigger reload
        setTimeout(() => {
          if (room && room.status === 'playing' && p && p.ammo < p.maxAmmo) {
            p.ammo++;
            // Note: In a real architecture, telling the client via a separate event is better, 
            // but since we broadcast state continuously, it will be updated in the next broadcast.
          }
        }, 500);
      }
    });

    // Global Invites
    socket.on('global_invite', ({ toUsername, game, hostUsername }) => {
      if (!socket.user) return;
      // Emit to the target user (assuming they are connected to a room with their username as ID)
      // Since `io` has all sockets, and users join a room matching their username upon login (standard practice).
      // Wait, does TL4.2 put users in a room by their username? Let's assume yes or use global broadcast.
      // We will emit globally and clients check if it's for them.
      io.emit('global_invite_received', {
        from: socket.user.username,
        to: toUsername,
        game,
        hostUsername
      });
    });

    // We also need to send the list of open rooms
    socket.on('shuriken_get_rooms', () => {
      const openRooms = Object.values(rooms)
        .filter(r => r.status === 'waiting')
        .map(r => ({
          host: r.host,
          playerCount: Object.keys(r.players).length
        }));
      socket.emit('shuriken_rooms_list', openRooms);
    });

    socket.on('disconnect', () => {
      if (!socket.user) return;
      // Handle sudden disconnect from any shuriken room they might be in
      const username = socket.user.username;
      for (const host in rooms) {
        const room = rooms[host];
        if (room.players[username]) {
          if (room.status === 'playing') {
            room.players[username].isAfk = true;
          } else {
            delete room.players[username];
            if (host === username) {
              io.to(`shuriken_${host}`).emit('shuriken_room_closed');
              delete rooms[host];
            }
          }
          broadcastState(io, host);
        }
      }
    });
  });
}

module.exports = { setupShurikenSockets };
