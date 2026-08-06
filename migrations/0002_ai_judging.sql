-- AI判定（Cloudflare Workers AI ビジョン）で人の相互採点を置き換える。
-- 写真アップロード時にAIが「そっくり度」を星1〜5＋電柱の写り込みで判定し、それを得点にする。
-- 既存の ratings テーブルは残すが、得点計算には使わない（裏方化）。
ALTER TABLE photos ADD COLUMN ai_stars INTEGER;                       -- AIが付けた星（1〜5）。未判定はNULL
ALTER TABLE photos ADD COLUMN ai_pole INTEGER NOT NULL DEFAULT 0;     -- 電柱が写っていれば1
ALTER TABLE photos ADD COLUMN ai_comment TEXT;                        -- 子ども向けの短い講評
ALTER TABLE photos ADD COLUMN ai_status TEXT NOT NULL DEFAULT 'pending'; -- pending | done | failed

-- AI導入前に撮られた写真はai_starsがNULL＝得点0になってしまう。
-- 過去写真は中立の星3・判定済み扱いにして、合計得点が壊れないようにする。
UPDATE photos SET ai_stars = 3, ai_status = 'done', ai_comment = '（AI導入前の写真）'
  WHERE ai_stars IS NULL;
