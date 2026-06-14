const express = require('express');
const router = express.Router();
const { getOne, getAll, runSql } = require('../db');

// GET /api/movies
// Lấy danh sách phim (không trả về parts URLs để giảm payload)
router.get('/', async (req, res) => {
  const userId = req.user.id;
  try {
    const movies = await getAll(
      'SELECT id, title, description, cover_url, tags, country, genre, parts, created_at FROM movies ORDER BY id DESC'
    );

    // Lấy tất cả logs xem của user này một lần duy nhất
    const logs = await getAll(
      'SELECT movie_id, part_index, episode_index, watched_seconds, last_position_seconds, last_watched_at FROM movie_watch_logs WHERE user_id = ?',
      [userId]
    );

    // Group logs by movie_id
    const logsByMovie = {};
    logs.forEach(l => {
      if (!logsByMovie[l.movie_id]) logsByMovie[l.movie_id] = [];
      logsByMovie[l.movie_id].push(l);
    });

    // Không lưu cache trình duyệt để đảm bảo thông tin cập nhật từ Admin hiển thị ngay lập tức
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

    res.json(movies.map(m => {
      let partsCount = 0;
      let episodesCount = 0;
      let partsArr = [];

      try {
        partsArr = JSON.parse(m.parts || '[]');
        partsCount = partsArr.length;
        episodesCount = partsArr.reduce((sum, p) => sum + (p.episodes ? p.episodes.length : 0), 0);
      } catch (e) {}

      const movieLogs = logsByMovie[m.id] || [];

      if (movieLogs.length === 0) {
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
          createdAt: m.created_at,
          watchProgress: null
        };
      }

      let latestLog = movieLogs[0];
      let totalWatchedSeconds = 0;
      movieLogs.forEach(l => {
        totalWatchedSeconds += (l.watched_seconds || 0);
        if (new Date(l.last_watched_at) > new Date(latestLog.last_watched_at)) {
          latestLog = l;
        }
      });

      let lastWatchedEpisodeTitle = '';
      try {
        const part = partsArr[latestLog.part_index];
        if (part && part.episodes && part.episodes[latestLog.episode_index]) {
          lastWatchedEpisodeTitle = part.episodes[latestLog.episode_index].title;
        }
      } catch(e) {}

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
        createdAt: m.created_at,
        watchProgress: {
          lastWatchedAt: latestLog.last_watched_at,
          totalWatchedSeconds,
          lastWatchedPartIndex: latestLog.part_index,
          lastWatchedEpisodeIndex: latestLog.episode_index,
          lastWatchedEpisodeTitle
        }
      };
    }));
  } catch (err) {
    console.error('GET /api/movies error:', err);
    res.status(500).json({ error: 'Lỗi máy chủ khi lấy danh sách phim' });
  }
});


// GET /api/movies/:id
// Lấy chi tiết một bộ phim và thông tin lịch sử xem dở của tài khoản hiện tại
router.get('/:id', async (req, res) => {
  const movieId = req.params.id;
  const userId = req.user.id;
  try {
    const movie = await getOne(
      'SELECT id, title, description, cover_url, tags, country, genre, parts, created_at FROM movies WHERE id = ?',
      [movieId]
    );
    if (!movie) {
      return res.status(404).json({ error: 'Không tìm thấy phim này' });
    }

    // Lấy log xem dở — được tăng tốc bởi composite index idx_watch_logs_user_movie
    const logs = await getAll(
      'SELECT part_index, episode_index, watched_seconds, last_position_seconds FROM movie_watch_logs WHERE user_id = ? AND movie_id = ?',
      [userId, movieId]
    );

    // Không lưu cache trình duyệt để đảm bảo thay đổi phản ánh ngay lập tức
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

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
// UPSERT: cộng dồn thời lượng xem trong 1 round-trip DB thay vì SELECT + UPDATE/INSERT
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
    // Single UPSERT: INSERT hoặc cộng dồn watched_seconds nếu đã tồn tại
    await runSql(
      `INSERT INTO movie_watch_logs (user_id, movie_id, part_index, episode_index, watched_seconds, last_position_seconds, last_watched_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, movie_id, part_index, episode_index)
       DO UPDATE SET
         watched_seconds = movie_watch_logs.watched_seconds + EXCLUDED.watched_seconds,
         last_position_seconds = EXCLUDED.last_position_seconds,
         last_watched_at = CURRENT_TIMESTAMP`,
      [userId, movieId, partIndex, episodeIndex, durationSec, positionSec]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/movies/watch-time error:', err);
    res.status(500).json({ error: 'Lỗi khi lưu tiến trình xem phim' });
  }
});

module.exports = router;
