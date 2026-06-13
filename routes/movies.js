const express = require('express');
const router = express.Router();
const { getOne, getAll, runSql } = require('../db');

// GET /api/movies
// Lấy danh sách phim kèm theo tổng số phần (parts) và lượt xem ước tính
router.get('/', async (req, res) => {
  try {
    const movies = await getAll('SELECT id, title, description, cover_url, tags, country, genre, parts, created_at FROM movies ORDER BY id DESC');
    res.json(movies.map(m => {
      let partsCount = 0;
      let episodesCount = 0;
      let partsArr = [];
      try {
        partsArr = JSON.parse(m.parts || '[]');
        partsCount = partsArr.length;
        episodesCount = partsArr.reduce((sum, p) => sum + (p.episodes ? p.episodes.length : 0), 0);
      } catch (e) {}
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
        createdAt: m.created_at
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
