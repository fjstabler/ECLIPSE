-- ECLIPSE schema.
-- Everything the server knows lives here: the library, who watches what, and
-- what NOVA has learned about each viewer's taste.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Titles: one row per film or series. Episodes hang off series rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS titles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
  title         TEXT NOT NULL,
  sort_title    TEXT NOT NULL,
  original_title TEXT,
  year          INTEGER,
  overview      TEXT,
  tagline       TEXT,
  runtime       INTEGER,             -- minutes; for series this is episode average
  rating        REAL,                -- 0-10 from the metadata provider
  certification TEXT,                -- e.g. "15", "PG-13"
  status        TEXT,                -- e.g. "Returning Series", "Ended"
  poster        TEXT,                -- cached artwork path or remote URL
  backdrop      TEXT,
  logo          TEXT,
  trailer_url   TEXT,
  tmdb_id       INTEGER,
  imdb_id       TEXT,
  metadata_state TEXT NOT NULL DEFAULT 'pending'
                 CHECK (metadata_state IN ('pending', 'matched', 'unmatched', 'manual')),
  added_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_titles_kind ON titles(kind);
CREATE INDEX IF NOT EXISTS idx_titles_sort ON titles(sort_title);
CREATE UNIQUE INDEX IF NOT EXISTS idx_titles_tmdb ON titles(kind, tmdb_id) WHERE tmdb_id IS NOT NULL;

-- Genres, keywords, cast and crew are stored as tag rows so the recommendation
-- engine can score on any of them without a schema change.
CREATE TABLE IF NOT EXISTS title_tags (
  title_id  INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  tag_type  TEXT NOT NULL,           -- 'genre' | 'keyword' | 'cast' | 'director' | 'creator' | 'studio' | 'mood'
  tag_value TEXT NOT NULL,
  weight    REAL NOT NULL DEFAULT 1.0,
  ordering  INTEGER NOT NULL DEFAULT 0,
  image     TEXT,                   -- cached headshot path, cast rows only
  PRIMARY KEY (title_id, tag_type, tag_value)
);

CREATE INDEX IF NOT EXISTS idx_tags_lookup ON title_tags(tag_type, tag_value);

-- ---------------------------------------------------------------------------
-- Seasons and episodes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seasons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title_id    INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  number      INTEGER NOT NULL,
  name        TEXT,
  overview    TEXT,
  poster      TEXT,
  UNIQUE (title_id, number)
);

CREATE TABLE IF NOT EXISTS episodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title_id    INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  season_id   INTEGER REFERENCES seasons(id) ON DELETE CASCADE,
  season      INTEGER NOT NULL,
  number      INTEGER NOT NULL,
  name        TEXT,
  overview    TEXT,
  still       TEXT,
  air_date    TEXT,
  runtime     INTEGER,
  UNIQUE (title_id, season, number)
);

CREATE INDEX IF NOT EXISTS idx_episodes_title ON episodes(title_id, season, number);

-- ---------------------------------------------------------------------------
-- Media files: the actual things on disk.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title_id    INTEGER REFERENCES titles(id) ON DELETE CASCADE,
  episode_id  INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
  path        TEXT NOT NULL UNIQUE,
  filename    TEXT NOT NULL,
  extension   TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  mtime       INTEGER NOT NULL DEFAULT 0,
  duration    REAL,                  -- seconds, from ffprobe when available
  width       INTEGER,
  height      INTEGER,
  video_codec TEXT,
  audio_codec TEXT,
  direct_play INTEGER NOT NULL DEFAULT 1,
  scanned_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_files_title ON media_files(title_id);
CREATE INDEX IF NOT EXISTS idx_files_episode ON media_files(episode_id);

CREATE TABLE IF NOT EXISTS subtitles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  language     TEXT,
  label        TEXT,
  forced       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (media_file_id, path)
);

-- Embedded audio tracks, from ffprobe. track_index is 0-based among audio
-- streams only, matching ffmpeg's own "0:a:N" stream-map syntax exactly —
-- that's what the transcode route passes straight through when a viewer
-- picks a language.
CREATE TABLE IF NOT EXISTS audio_tracks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  track_index   INTEGER NOT NULL,
  codec         TEXT,
  language      TEXT,
  label         TEXT,
  channels      INTEGER,
  is_default    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (media_file_id, track_index)
);

-- ---------------------------------------------------------------------------
-- Users and profiles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  avatar_color   TEXT NOT NULL DEFAULT '#6c5ce7',
  is_admin       INTEGER NOT NULL DEFAULT 0,
  is_kids        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- The taste profile NOVA reads from and writes to.
CREATE TABLE IF NOT EXISTS taste_profiles (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  about          TEXT NOT NULL DEFAULT '',   -- free text: "I like slow-burn sci-fi, hate gore"
  liked_genres   TEXT NOT NULL DEFAULT '[]', -- JSON array
  disliked_genres TEXT NOT NULL DEFAULT '[]',
  favourite_people TEXT NOT NULL DEFAULT '[]',
  moods          TEXT NOT NULL DEFAULT '[]',
  avoid          TEXT NOT NULL DEFAULT '[]', -- things to steer clear of
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Watching
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS playback_state (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  title_id    INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  position    REAL NOT NULL DEFAULT 0,      -- seconds
  duration    REAL NOT NULL DEFAULT 0,
  completed   INTEGER NOT NULL DEFAULT 0,
  play_count  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, media_file_id)
);

CREATE INDEX IF NOT EXISTS idx_playback_user ON playback_state(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS watch_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id    INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  media_file_id INTEGER REFERENCES media_files(id) ON DELETE SET NULL,
  seconds_watched REAL NOT NULL DEFAULT 0,
  completed   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_user ON watch_events(user_id, created_at DESC);

-- Thumbs up / thumbs down, the strongest signal NOVA has.
CREATE TABLE IF NOT EXISTS ratings (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id   INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  score      INTEGER NOT NULL CHECK (score IN (-1, 1, 2)), -- down / up / love
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, title_id)
);

CREATE TABLE IF NOT EXISTS watchlist (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id   INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, title_id)
);

-- ---------------------------------------------------------------------------
-- NOVA conversations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nova_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  refs       TEXT NOT NULL DEFAULT '[]',  -- JSON array of title ids NOVA cited
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nova_user ON nova_messages(user_id, created_at);

-- ---------------------------------------------------------------------------
-- Server bookkeeping
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  added       INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  removed     INTEGER NOT NULL DEFAULT 0,
  errors      TEXT NOT NULL DEFAULT '[]'
);
