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
  -- What the file actually is, past codec names: container, how fast it runs,
  -- how many bits deep, and whether it carries HDR. All of it drives either a
  -- playback decision or the technical panel on the title page.
  container   TEXT,
  bitrate     INTEGER,               -- bits/sec, whole file
  video_bitrate INTEGER,
  frame_rate  REAL,
  bit_depth   INTEGER,
  pixel_format TEXT,
  color_space TEXT,
  color_transfer TEXT,
  color_primaries TEXT,
  hdr_format  TEXT,                  -- 'HDR10' | 'HDR10+' | 'Dolby Vision' | 'HLG'
  aspect_ratio TEXT,
  video_profile TEXT,
  stream_count INTEGER,
  -- Which generation of the prober last read this file. A file described by an
  -- older version is re-read on the next scan, so upgrades backfill themselves.
  probe_version INTEGER NOT NULL DEFAULT 0,
  scanned_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_files_title ON media_files(title_id);
CREATE INDEX IF NOT EXISTS idx_files_episode ON media_files(episode_id);

-- Subtitle files sitting next to the video. Embedded subtitle tracks live in
-- media_streams instead — they're part of the file, not separate from it.
CREATE TABLE IF NOT EXISTS subtitles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  language     TEXT,
  label        TEXT,
  forced       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (media_file_id, path)
);

-- Every stream inside a file, exactly as ffprobe reports it.
--
-- type_index is the position among streams of the same kind, which is what
-- ffmpeg's own "-map 0:a:1" syntax addresses; stream_index is the absolute
-- position in the container. Confusing the two is how a player ends up
-- playing the wrong language, so both are stored rather than derived later.
CREATE TABLE IF NOT EXISTS media_streams (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('video', 'audio', 'subtitle')),
  stream_index  INTEGER NOT NULL,
  type_index    INTEGER NOT NULL,
  codec         TEXT,
  codec_long    TEXT,
  language      TEXT,
  title         TEXT,
  label         TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0,
  is_forced     INTEGER NOT NULL DEFAULT 0,
  is_hearing_impaired INTEGER NOT NULL DEFAULT 0,
  is_visual_impaired  INTEGER NOT NULL DEFAULT 0,
  is_commentary INTEGER NOT NULL DEFAULT 0,
  -- Subtitles only: text can become WebVTT, pictures can only be burned in.
  is_text       INTEGER NOT NULL DEFAULT 0,
  is_extractable INTEGER NOT NULL DEFAULT 0,
  channels      INTEGER,
  channel_layout TEXT,
  sample_rate   INTEGER,
  bitrate       INTEGER,
  width         INTEGER,
  height        INTEGER,
  frame_rate    REAL,
  bit_depth     INTEGER,
  profile       TEXT,
  UNIQUE (media_file_id, stream_index)
);

CREATE INDEX IF NOT EXISTS idx_streams_file ON media_streams(media_file_id, kind, type_index);

CREATE TABLE IF NOT EXISTS chapters (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL,
  title         TEXT,
  start_time    REAL NOT NULL,
  end_time      REAL,
  UNIQUE (media_file_id, idx)
);

-- Skippable sections. Derived from chapter names rather than guessed at:
-- a chapter called "Opening Credits" is an intro, and that is the only claim
-- ECLIPSE can honestly make without fingerprinting the audio itself.
CREATE TABLE IF NOT EXISTS media_markers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('intro', 'credits', 'recap')),
  start_time    REAL NOT NULL,
  end_time      REAL NOT NULL,
  source        TEXT NOT NULL DEFAULT 'chapters',
  UNIQUE (media_file_id, kind)
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

-- How each viewer wants playback to behave. Separate from taste_profiles,
-- which is what N.O.V.A. reads — these are settings, not preferences about
-- what to watch.
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id             INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  autoplay_next       INTEGER NOT NULL DEFAULT 1,
  skip_intro          TEXT NOT NULL DEFAULT 'ask',    -- 'ask' | 'auto' | 'off'
  skip_credits        TEXT NOT NULL DEFAULT 'ask',
  audio_language      TEXT,                            -- preferred, when the file has it
  subtitle_language   TEXT,
  subtitles_default   INTEGER NOT NULL DEFAULT 0,
  subtitle_size       INTEGER NOT NULL DEFAULT 100,    -- percent
  subtitle_colour     TEXT NOT NULL DEFAULT '#ffffff',
  subtitle_background REAL NOT NULL DEFAULT 0.55,      -- 0-1 opacity behind the text
  subtitle_position   INTEGER NOT NULL DEFAULT 88,     -- percent down the frame
  playback_speed      REAL NOT NULL DEFAULT 1.0,
  max_height          INTEGER NOT NULL DEFAULT 0,      -- 0 = whatever the file is
  max_bitrate         INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
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

-- Devices that have connected. Keyed by a value the client generates once and
-- keeps, so a TV stays one row rather than becoming a new one every time its
-- user agent gains a version number.
CREATE TABLE IF NOT EXISTS devices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  device_key  TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'unknown',
  user_agent  TEXT,
  renamed     INTEGER NOT NULL DEFAULT 0,   -- a name its owner chose is never overwritten
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What the server has been doing, so the admin page can answer "why did that
-- fail" without anyone reading a terminal.
CREATE TABLE IF NOT EXISTS server_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  level      TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  scope      TEXT NOT NULL,
  message    TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_log_time ON server_log(created_at DESC);

CREATE TABLE IF NOT EXISTS scan_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  added       INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  removed     INTEGER NOT NULL DEFAULT 0,
  errors      TEXT NOT NULL DEFAULT '[]'
);
