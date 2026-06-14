const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { initDb, getOne, runSql } = require('./db');
const http = require('http');
const { Server } = require('socket.io');
const { parseJSON, addToBackpack } = require('./utils');
const { setupTradeSockets } = require('./tradeManager');
const { setupTienLenSockets } = require('./tienLenManager');
const { setupXiDachSockets } = require('./xiDachManager');
const { setupShurikenSockets } = require('./shurikenManager');
const { setupSpySockets } = require('./spyManager');
const { setupMessageSockets } = require('./messageManager');
const { setupWerewolfSockets } = require('./werewolfManager');
const { setupTravelSockets } = require('./travelManager');
const { simulateCowProgress } = require('./cowSimulation');


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

app.use(express.json({ limit: '10mb' }));
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

    if (!videoUrl.startsWith('https://') || !videoUrl.includes('.googleusercontent.com/')) {
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

  // Google Photos Resolver Endpoint (Public/Unauthenticated for robust player range requests & diagnostics)
  const { extractAlbum } = require('gphotos-scraper');
  const photosCache = new Map();

  function resolveShortUrl(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        res.resume(); // Drain stream to avoid memory/socket leak
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(res.headers.location);
        } else {
          resolve(url);
        }
      }).on('error', reject);
    });
  }

  app.get('/api/movies/photos-url', (req, res) => {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    if (photosCache.has(url)) {
      const cached = photosCache.get(url);
      if (Date.now() - cached.timestamp < 12 * 60 * 60 * 1000) {
        return res.json({ videoUrl: cached.videoUrl });
      }
    }

    const resolveAndExtract = async () => {
      try {
        let finalUrl = url;
        if (url.includes('photos.app.goo.gl')) {
          finalUrl = await resolveShortUrl(url);
        }

        const album = await extractAlbum(finalUrl);
        if (!album || !album.photos) {
          return res.status(404).json({ error: 'Album not found or empty' });
        }

        const videos = album.photos.filter(p => p.mimeType && p.mimeType.startsWith('video/'));
        if (videos.length === 0) {
          return res.status(404).json({ error: 'No videos found in album' });
        }

        const rawVideoUrl = videos[0].url;
        const streamUrl = `${rawVideoUrl}=m22`;

        photosCache.set(url, {
          videoUrl: streamUrl,
          timestamp: Date.now()
        });

        res.json({ videoUrl: streamUrl });
      } catch (err) {
        console.error('Error resolving Google Photos URL:', err);
        res.status(500).json({ 
          error: 'Error resolving Google Photos URL',
          detail: err.message,
          stack: err.stack
        });
      }
    };
    resolveAndExtract();
  });

  const path = require('path');
  const authRoutes = require('./routes/auth');
  const { authenticateToken } = authRoutes;
  const profileRoutes = require('./routes/profile');
  const farmRoutes = require('./routes/farm');
  const adminRoutes  = require('./routes/admin');
  const marketRoutes = require('./routes/market');
  const questRoutes = require('./routes/quests');
  const messageRoutes = require('./routes/messages');
  const vehicleRoutes = require('./routes/vehicle');
  const movieRoutes = require('./routes/movies');

  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
  app.use('/api', authRoutes);
  app.use('/api/profile', authenticateToken, profileRoutes);
  app.use('/api/farm', authenticateToken, farmRoutes);
  app.use('/api/market', authenticateToken, marketRoutes);
  app.use('/api/quests', authenticateToken, questRoutes);
  app.use('/api/messages', authenticateToken, messageRoutes);
  app.use('/api/vehicle', authenticateToken, vehicleRoutes);
  app.use('/api/movies', authenticateToken, movieRoutes);

  // Gold Price Scraper Endpoint — cache 30 phút để tránh scrape mỗi request
  let goldCache = null;
  let goldCacheTime = 0;
  const GOLD_CACHE_TTL = 30 * 60 * 1000; // 30 phút

  app.get('/api/gold', authenticateToken, (req, res) => {
    const now = Date.now();
    // Trả về cache nếu còn hiệu lực
    if (goldCache && now - goldCacheTime < GOLD_CACHE_TTL) {
      return res.json(goldCache);
    }

    const https = require('https');
    const options = {
      hostname: 'giavang.org',
      port: 443,
      path: '/',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://giavang.org/'
      },
      timeout: 8000
    };

    const request = https.get(options, (proxyRes) => {
      let html = '';
      proxyRes.on('data', (chunk) => { html += chunk; });
      
      proxyRes.on('end', () => {
        try {
          const timeRegex = /Cập nhật lúc\s+([\d:]+\s+[\d/]+)/i;
          const timeMatch = html.match(timeRegex);
          const updateTime = timeMatch ? timeMatch[1] : new Date().toLocaleTimeString('vi-VN') + ' ' + new Date().toLocaleDateString('vi-VN');
          
          const miengIndex = html.indexOf('Giá vàng Miếng SJC');
          const nhanIndex = html.indexOf('Giá vàng Nhẫn SJC');
          
          let sjcMieng = { buy: '155.500', sell: '158.500' };
          let sjcNhan = { buy: '155.300', sell: '158.300' };
          
          const priceRegex = /<span class="gold-price-label">(Mua vào|Bán ra)<\/span>\s*<span class="gold-price">([\d.,]+)\s*<small/g;
          
          if (miengIndex !== -1) {
            const endSlice = nhanIndex !== -1 ? nhanIndex : miengIndex + 1000;
            const miengHtml = html.substring(miengIndex, endSlice);
            let match;
            const localRegex = new RegExp(priceRegex);
            while ((match = localRegex.exec(miengHtml)) !== null) {
              if (match[1] === 'Mua vào') sjcMieng.buy = match[2];
              if (match[1] === 'Bán ra') sjcMieng.sell = match[2];
            }
          }
          
          if (nhanIndex !== -1) {
            const nhanHtml = html.substring(nhanIndex, nhanIndex + 1000);
            let match;
            const localRegex = new RegExp(priceRegex);
            while ((match = localRegex.exec(nhanHtml)) !== null) {
              if (match[1] === 'Mua vào') sjcNhan.buy = match[2];
              if (match[1] === 'Bán ra') sjcNhan.sell = match[2];
            }
          }
          
          const result = { success: true, updateTime, sjcMieng, sjcNhan };
          // Lưu vào cache
          goldCache = result;
          goldCacheTime = Date.now();
          res.json(result);
        } catch (e) {
          res.json({
            success: false,
            error: 'Lỗi phân tích dữ liệu',
            updateTime: new Date().toLocaleTimeString('vi-VN') + ' ' + new Date().toLocaleDateString('vi-VN'),
            sjcMieng: { buy: '155.500', sell: '158.500' },
            sjcNhan: { buy: '155.300', sell: '158.300' }
          });
        }
      });
    });

    request.on('error', () => {
      res.json({
        success: false,
        error: 'Lỗi kết nối máy chủ',
        updateTime: new Date().toLocaleTimeString('vi-VN') + ' ' + new Date().toLocaleDateString('vi-VN'),
        sjcMieng: { buy: '155.500', sell: '158.500' },
        sjcNhan: { buy: '155.300', sell: '158.300' }
      });
    });

    request.on('timeout', () => {
      request.destroy();
      res.json({
        success: false,
        error: 'Quá thời gian kết nối',
        updateTime: new Date().toLocaleTimeString('vi-VN') + ' ' + new Date().toLocaleDateString('vi-VN'),
        sjcMieng: { buy: '155.500', sell: '158.500' },
        sjcNhan: { buy: '155.300', sell: '158.300' }
      });
    });
  });

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
  setupSpySockets(io);
  setupMessageSockets(io);
  setupWerewolfSockets(io);
  setupTravelSockets(io);


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
  // Chỉ xử lý rooms đang có player để tránh query DB không cần thiết
  setInterval(async () => {
    const now = Date.now();
    for (const hostUsername in houseRooms) {
      const room = houseRooms[hostUsername];
      // Bỏ qua phòng rỗng (chỉ có key 'drops', không có player socket)
      const playerCount = Object.keys(room).filter(k => k !== 'drops').length;
      if (playerCount === 0) continue;

      if (!room.drops) room.drops = [];
      const user = await getOne('SELECT id FROM users WHERE username = ?', [hostUsername]);
      if (!user) continue;
      
      const farm = await getOne('SELECT animals_data, cage_inventory, cage_products FROM user_farms WHERE user_id = ?', [user.id]);
      if (!farm) continue;
      
      let animalsData = parseJSON(farm.animals_data, []);
      let cageInventory = parseJSON(farm.cage_inventory, [null, null, null, null]);
      let cageProducts = parseJSON(farm.cage_products, []);
      
      const simulation = simulateCowProgress(animalsData, cageInventory, now);
      
      if (simulation.updated) {
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
