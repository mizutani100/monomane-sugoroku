-- 旅すご D1 スキーマ（Cloudflare版）
-- 自前Apache版（api/lib.php の migrate()）と同一構造だが、
-- 写真はファイルではなく D1 の BLOB に保存する（file_path → photo_blob / public_path → public_blob）。
-- 1行あたり最大2MB・DB最大500MBのD1無料枠に収まるよう、写真はクライアント側で
-- 長辺1000px・JPEG品質0.75へ縮小してから送る（1枚150〜250KB想定）。

CREATE TABLE IF NOT EXISTS rooms(
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'playing',
    board_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS players(
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    nickname TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '🙂',
    token_hash TEXT NOT NULL,
    is_host INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT -1,
    score INTEGER NOT NULL DEFAULT 0,
    joined_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photos(
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    spot_index INTEGER NOT NULL,
    spot_name TEXT NOT NULL,
    category TEXT NOT NULL,
    base_points INTEGER NOT NULL,
    mime TEXT NOT NULL DEFAULT 'image/jpeg',
    photo_blob BLOB NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_room ON photos(room_id);

CREATE TABLE IF NOT EXISTS ratings(
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    rater_player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    stars INTEGER NOT NULL,
    pole_bonus INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(photo_id, rater_player_id)
);

CREATE TABLE IF NOT EXISTS published_photos(
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL UNIQUE REFERENCES photos(id) ON DELETE CASCADE,
    mime TEXT NOT NULL DEFAULT 'image/jpeg',
    public_blob BLOB NOT NULL,
    spot_name TEXT NOT NULL,
    category TEXT NOT NULL,
    nickname TEXT NOT NULL,
    published_at TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS net_votes(
    id INTEGER PRIMARY KEY,
    published_id INTEGER NOT NULL REFERENCES published_photos(id) ON DELETE CASCADE,
    voter_hash TEXT NOT NULL,
    stars INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(published_id, voter_hash)
);

CREATE TABLE IF NOT EXISTS reports(
    id INTEGER PRIMARY KEY,
    published_id INTEGER NOT NULL REFERENCES published_photos(id) ON DELETE CASCADE,
    reporter_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(published_id, reporter_hash)
);

CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_token ON players(token_hash);
