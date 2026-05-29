const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { initDb } = require('./db');
const http = require('http');
const { Server } = require('socket.io');
const { parseJSON, addToBackpack } = require('./utils');
const { setupTradeSockets } = require('./tradeManager');
const { setupTienLenSockets } = require('./tienLenManager');
const { setupXiDachSockets } = require('./xiDachManager');
const { setupShurikenSockets } = require('./shurikenManager');

dotenv.config();

const app = express();
const server = http.createServer(app);
const ALLOWED_ORIGINS_DEFAULT = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
  'https://te-lan-42.vercel.app',
];
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? [...new Set([...ALLOWED_ORIGINS_DEFAULT, ...process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim().replace(/\/$/, ''))])]
  : ALLOWED_ORIGINS_DEFAULT;

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    credentials: true,
  }
});

const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '2mb' }));
app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true,
}));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'Tệ Lạn 4.2', time: new Date().toISOString() });
});

initDb().then(() => {
  require('./settingsManager').loadSettings();

  // Video Streaming Proxy (Bypasses Google Photos 403 hotlinking block & supports Range Requests + Redirect Following)
  const https = require('https');
  const http = require('http');

  function fetchWithRedirects(url, headers, maxRedirects, callback) {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers }, (proxyRes) => {
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location && maxRedirects > 0) {
        proxyRes.resume(); // drain the response
        const redirectUrl = proxyRes.headers.location.startsWith('http')
          ? proxyRes.headers.location
          : new URL(proxyRes.headers.location, url).href;
        return fetchWithRedirects(redirectUrl, headers, maxRedirects - 1, callback);
      }
      callback(null, proxyRes);
    }).on('error', (err) => callback(err, null));
  }

  app.get('/api/proxy-video', (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) {
      return res.status(400).send('Missing url parameter');
    }

    if (!videoUrl.startsWith('https://lh3.googleusercontent.com/')) {
      return res.status(403).send('Forbidden: Invalid proxy target');
    }

    console.log('[proxy-video] Streaming:', videoUrl.substring(0, 80) + '...');

    const range = req.headers.range;
    const proxyHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Referer': 'https://photos.google.com/',
    };
    if (range) {
      proxyHeaders['Range'] = range;
    }

    fetchWithRedirects(videoUrl, proxyHeaders, 5, (err, proxyRes) => {
      if (err) {
        console.error('[proxy-video] Fetch error:', err.message);
        if (!res.headersSent) res.status(502).send('Error fetching video');
        return;
      }

      console.log('[proxy-video] Upstream status:', proxyRes.statusCode, 'Content-Type:', proxyRes.headers['content-type']);

      // Explicit CORS headers (video elements cross-origin need this)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Range');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');

      res.status(proxyRes.statusCode);
      if (proxyRes.headers['content-type']) res.setHeader('Content-Type', proxyRes.headers['content-type']);
      if (proxyRes.headers['content-length']) res.setHeader('Content-Length', proxyRes.headers['content-length']);
      if (proxyRes.headers['content-range']) res.setHeader('Content-Range', proxyRes.headers['content-range']);
      res.setHeader('Accept-Ranges', proxyRes.headers['accept-ranges'] || 'bytes');

      req.on('close', () => proxyRes.destroy());
      proxyRes.pipe(res);
    });
  });

  const authRoutes = require('./routes/auth');
  const { authenticateToken } = authRoutes;
  const profileRoutes = require('./routes/profile');
  const farmRoutes = require('./routes/farm');
  const adminRoutes  = require('./routes/admin');
  const marketRoutes = require('./routes/market');
  const questRoutes = require('./routes/quests');

  app.use('/api', authRoutes);
  app.use('/api/profile', authenticateToken, profileRoutes);
  app.use('/api/farm', authenticateToken, farmRoutes);
  app.use('/api/market', authenticateToken, marketRoutes);
  app.use('/api/quests', authenticateToken, questRoutes);

  // Admin routes — must be authenticated + admin role
  app.use('/api/admin', authenticateToken, (req, res, next) => {
    if (req.user.role !== 'admin')
      return res.status(403).json({ error: 'Bạn không có quyền truy cập' });
    next();
  }, adminRoutes);

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal server error' });
  });

  setupTradeSockets(io);
  setupTienLenSockets(io);
  setupXiDachSockets(io);
  setupShurikenSockets(io);

  const houseRooms = {};

  io.on('connection', (socket) => {
    socket.on('join_house', ({ hostUsername, player }) => {
      if (socket.hostUsername && houseRooms[socket.hostUsername]) {
        socket.leave(socket.hostUsername);
        delete houseRooms[socket.hostUsername][socket.id];
        socket.to(socket.hostUsername).emit('player_left', socket.id);
      }
      
      socket.join(hostUsername);
      socket.hostUsername = hostUsername;
      
      if (!houseRooms[hostUsername]) houseRooms[hostUsername] = {};
      houseRooms[hostUsername][socket.id] = player;
      socket.playerUsername = player.username;
      
      socket.emit('current_players', houseRooms[hostUsername]);
      if (houseRooms[hostUsername].drops) {
        socket.emit('item_dropped', houseRooms[hostUsername].drops);
      }
      socket.to(hostUsername).emit('player_joined', { id: socket.id, player });
    });

    socket.on('player_move', (state) => {
      if (socket.hostUsername && houseRooms[socket.hostUsername]) {
        const oldState = houseRooms[socket.hostUsername][socket.id] || {};
        houseRooms[socket.hostUsername][socket.id] = { ...oldState, ...state };
        socket.to(socket.hostUsername).emit('player_moved', { id: socket.id, state });
      }
    });

    socket.on('farm_action', () => {
      if (socket.hostUsername) {
        socket.to(socket.hostUsername).emit('farm_updated');
      }
    });

    socket.on('pickup_item', async dropId => {
      if (socket.hostUsername && houseRooms[socket.hostUsername]) {
        const room = houseRooms[socket.hostUsername];
        if (room.drops) {
          const dropIndex = room.drops.findIndex(d => d.id === dropId);
          if (dropIndex !== -1) {
            const drop = room.drops[dropIndex];
            const { getOne, runSql } = require('./db');
            const user = await getOne('SELECT id, backpack FROM users WHERE username = ?', [socket.playerUsername]);
            if (user) {
               let backpack = parseJSON(user.backpack, [null, null]);
               const result = addToBackpack(backpack, drop.item_id, 1);
               if (result.success) {
                 await runSql('UPDATE users SET backpack = ? WHERE id = ?', [JSON.stringify(result.backpack), user.id]);
                 room.drops.splice(dropIndex, 1);
                 io.to(socket.hostUsername).emit('item_dropped', room.drops);
                 socket.emit('pickup_success', { backpack: result.backpack });
               } else {
                 socket.emit('pickup_failed', { error: 'Balo đã đầy' });
               }
            }
          }
        }
      }
    });

    socket.on('disconnect', () => {
      if (socket.hostUsername && houseRooms[socket.hostUsername]) {
        delete houseRooms[socket.hostUsername][socket.id];
        socket.to(socket.hostUsername).emit('player_left', socket.id);
        if (Object.keys(houseRooms[socket.hostUsername]).length === 0) {
          delete houseRooms[socket.hostUsername];
        }
      }
    });
  });

  // Periodically check for milk drops (every 10s)
  setInterval(async () => {
    const { getOne, runSql } = require('./db');
    const { simulateCowProgress } = require('./cowSimulation');
    const now = Date.now();
    for (const hostUsername in houseRooms) {
      if (!houseRooms[hostUsername].drops) houseRooms[hostUsername].drops = [];
      const user = await getOne('SELECT id FROM users WHERE username = ?', [hostUsername]);
      if (!user) continue;
      
      const farm = await getOne('SELECT animals_data, cage_inventory, cage_products FROM user_farms WHERE user_id = ?', [user.id]);
      if (!farm) continue;
      
      let animalsData = parseJSON(farm.animals_data, []);
      let cageInventory = parseJSON(farm.cage_inventory, [null, null, null, null]);
      let cageProducts = parseJSON(farm.cage_products, []);
      
      const simulation = simulateCowProgress(animalsData, cageInventory, now);
      
      if (simulation.updated) {
        // Handle new drops
        if (simulation.drops.length > 0) {
          simulation.drops.forEach((dropType) => {
            cageProducts.push(dropType);
          });
        }
        
        await runSql('UPDATE user_farms SET animals_data = ?, cage_inventory = ?, cage_products = ? WHERE user_id = ?', [
          JSON.stringify(simulation.animalsData),
          JSON.stringify(simulation.cageInventory),
          JSON.stringify(cageProducts),
          user.id
        ]);
        
        io.to(hostUsername).emit('farm_updated');
      }
    }
  }, 10000);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Tệ Lạn 4.2 Backend running on port ${PORT}`);
  });
}).catch((err) => {
  console.error('❌ Failed to initialize database:', err);
  process.exit(1);
});
