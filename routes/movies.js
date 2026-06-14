const express = require('express');
const router = express.Router();
const { getOne, getAll, runSql } = require('../db');

// GET /api/movies
// Lấy danh sách phim kèm theo tổng số phần (parts), lượt xem và lịch sử xem của user hiện tại
router.get('/', async (req, res) => {
  const userId = req.user.id;
  try {
    const movies = await getAll('SELECT id, title, description, cover_url, tags, country, genre, parts, created_at FROM movies ORDER BY id DESC');
    
    // Lấy tất cả logs xem của user này
    const logs = await getAll('SELECT movie_id, part_index, episode_index, watched_seconds, last_position_seconds, last_watched_at FROM movie_watch_logs WHERE user_id = ?', [userId]);
    
    // Group logs by movie_id
    const logsByMovie = {};
    logs.forEach(l => {
      if (!logsByMovie[l.movie_id]) {
        logsByMovie[l.movie_id] = [];
      }
      logsByMovie[l.movie_id].push(l);
    });

    res.json(movies.map(m => {
      let partsCount = 0;
      let episodesCount = 0;
      let partsArr = [];
      try {
        partsArr = JSON.parse(m.parts || '[]');
        partsCount = partsArr.length;
        episodesCount = partsArr.reduce((sum, p) => sum + (p.episodes ? p.episodes.length : 0), 0);
      } catch (e) {}

      // Tính toán watch progress cho phim này
      const movieLogs = logsByMovie[m.id] || [];
      let lastWatchedAt = null;
      let totalWatchedSeconds = 0;
      let lastWatchedPartIndex = 0;
      let lastWatchedEpisodeIndex = 0;
      let lastWatchedEpisodeTitle = '';
      
      if (movieLogs.length > 0) {
        // Tìm log mới nhất
        let latestLog = movieLogs[0];
        movieLogs.forEach(l => {
          totalWatchedSeconds += (l.watched_seconds || 0);
          if (new Date(l.last_watched_at) > new Date(latestLog.last_watched_at)) {
            latestLog = l;
          }
        });
        
        lastWatchedAt = latestLog.last_watched_at;
        lastWatchedPartIndex = latestLog.part_index;
        lastWatchedEpisodeIndex = latestLog.episode_index;
        
        // Lấy tên tập phim đang xem dở
        try {
          const part = partsArr[lastWatchedPartIndex];
          if (part && part.episodes && part.episodes[lastWatchedEpisodeIndex]) {
            lastWatchedEpisodeTitle = part.episodes[lastWatchedEpisodeIndex].title;
          }
        } catch(e) {}
      }

      return {
        id: m.id,
        title: m.title,
        description: m.description,
        coverUrl: m.cover_url,
        tags: m.tags,
        country: m.country,
        genre: m.genre,
        partsCount,
        episodesCount,
        parts: partsArr,
        createdAt: m.created_at,
        watchProgress: movieLogs.length > 0 ? {
          lastWatchedAt,
          totalWatchedSeconds,
          lastWatchedPartIndex,
          lastWatchedEpisodeIndex,
          lastWatchedEpisodeTitle
        } : null
      };
    }));
  } catch (err) {
    console.error('GET /api/movies error:', err);
    res.status(500).json({ error: 'Lỗi máy chủ khi lấy danh sách phim' });
  }
});

// GET /api/movies/photos-url
// Phân tích liên kết chia sẻ Google Photos và trả về link direct video (googleusercontent)
const { extractAlbum } = require('gphotos-scraper');
const https = require('https');

// Helper to follow redirect for photos.app.goo.gl
function resolveShortUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(res.headers.location);
      } else {
        resolve(url);
      }
    }).on('error', reject);
  });
}

// In-memory cache for Google Photos resolved URLs
const photosCache = new Map();

router.get('/photos-url', async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Thiếu tham số url' });
  }

  // Check cache (valid for 12 hours)
  if (photosCache.has(url)) {
    const cached = photosCache.get(url);
    if (Date.now() - cached.timestamp < 12 * 60 * 60 * 1000) {
      return res.json({ videoUrl: cached.videoUrl });
    }
  }

  try {
    let finalUrl = url;
    if (url.includes('photos.app.goo.gl')) {
      finalUrl = await resolveShortUrl(url);
    }

    const album = await extractAlbum(finalUrl);
    if (!album || !album.photos) {
      return res.status(404).json({ error: 'Không thể phân tích dữ liệu từ liên kết Google Photos này.' });
    }

    const videos = album.photos.filter(p => p.mimeType && p.mimeType.startsWith('video/'));
    if (videos.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy video nào trong liên kết Google Photos này.' });
    }

    // Lấy video đầu tiên trong album
    const rawVideoUrl = videos[0].url;
    // Sử dụng chất lượng m22 (720p) làm mặc định để tải nhanh và mượt mà.
    const streamUrl = `${rawVideoUrl}=m22`;

    // Lưu cache
    photosCache.set(url, {
      videoUrl: streamUrl,
      timestamp: Date.now()
    });

    res.json({ videoUrl: streamUrl });
  } catch (err) {
    console.error('Error resolving Google Photos URL:', err);
    res.status(500).json({ 
      error: 'Lỗi phân tích Google Photos. Vui lòng đảm bảo liên kết chia sẻ công khai.',
      detail: err.message,
      stack: err.stack
    });
  }
});

// GET /api/movies/:id
// Lấy chi tiết một bộ phim và thông tin lịch sử xem dở của tài khoản hiện tại
router.get('/:id', async (req, res) => {
  const movieId = req.params.id;
  const userId = req.user.id;
  try {
    const movie = await getOne('SELECT id, title, description, cover_url, tags, country, genre, parts, created_at FROM movies WHERE id = ?', [movieId]);
    if (!movie) {
      return res.status(404).json({ error: 'Không tìm thấy phim này' });
    }

    // Lấy log xem dở của user này cho tất cả tập trong phim
    const logs = await getAll('SELECT part_index, episode_index, watched_seconds, last_position_seconds FROM movie_watch_logs WHERE user_id = ? AND movie_id = ?', [userId, movieId]);

    res.json({
      id: movie.id,
      title: movie.title,
      description: movie.description,
      coverUrl: movie.cover_url,
      tags: movie.tags,
      country: movie.country,
      genre: movie.genre,
      parts: JSON.parse(movie.parts || '[]'),
      watchLogs: logs.map(l => ({
        partIndex: l.part_index,
        episodeIndex: l.episode_index,
        watchedSeconds: l.watched_seconds,
        lastPositionSeconds: l.last_position_seconds
      })),
      createdAt: movie.created_at
    });
  } catch (err) {
    console.error('GET /api/movies/:id error:', err);
    res.status(500).json({ error: 'Lỗi máy chủ khi lấy chi tiết phim' });
  }
});

// POST /api/movies/watch-time
// Cộng dồn thời lượng xem và lưu giây xem cuối cùng
router.post('/watch-time', async (req, res) => {
  const userId = req.user.id;
  const { movieId, partIndex, episodeIndex, duration, lastPosition } = req.body;

  if (movieId === undefined || partIndex === undefined || episodeIndex === undefined || duration === undefined || lastPosition === undefined) {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  }

  const durationSec = parseInt(duration, 10);
  const positionSec = parseInt(lastPosition, 10);

  if (isNaN(durationSec) || durationSec < 0 || isNaN(positionSec) || positionSec < 0) {
    return res.status(400).json({ error: 'Dữ liệu thời gian không hợp lệ' });
  }

  try {
    // Thử cập nhật bản ghi cũ
    const existing = await getOne(
      'SELECT id, watched_seconds FROM movie_watch_logs WHERE user_id = ? AND movie_id = ? AND part_index = ? AND episode_index = ?',
      [userId, movieId, partIndex, episodeIndex]
    );

    if (existing) {
      const newWatched = existing.watched_seconds + durationSec;
      await runSql(
        'UPDATE movie_watch_logs SET watched_seconds = ?, last_position_seconds = ?, last_watched_at = CURRENT_TIMESTAMP WHERE id = ?',
        [newWatched, positionSec, existing.id]
      );
    } else {
      await runSql(
        'INSERT INTO movie_watch_logs (user_id, movie_id, part_index, episode_index, watched_seconds, last_position_seconds) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, movieId, partIndex, episodeIndex, durationSec, positionSec]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/movies/watch-time error:', err);
    res.status(500).json({ error: 'Lỗi khi lưu tiến trình xem phim' });
  }
});

module.exports = router;

