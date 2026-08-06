-- 絵文字リアクション（得点に影響しない「みんなで笑う」用の反応）。
-- 旧 ratings（人の相互採点）はAI判定に置き換わったため、人の反応はこちらへ降格。
-- 1人1写真につき1リアクション（同じ絵文字をもう一度押すと取り消し、別を押すと差し替え）。
-- そっくり大賞=👏最多 / なにこれ大賞=😆最多 の集計に使う（得点には一切足さない）。
CREATE TABLE IF NOT EXISTS reactions(
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(photo_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_reactions_photo ON reactions(photo_id);
