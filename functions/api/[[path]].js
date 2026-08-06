/**
 * 街のモノまねすごろく API（Cloudflare Pages Functions + D1 版）
 *
 * 自前Apache版（api/index.php + api/lib.php）と同一仕様。
 * 違いは以下の2点のみ:
 *   - 写真はファイルではなく D1 の BLOB に保存する（R2不使用）
 *   - サーバ側の画像再エンコード(EXIF除去)は行わず、マジックバイト検証＋
 *     クライアント側でCanvas再エンコード済みであること（EXIFは落ちる）で代替する
 *
 * 全リクエストが functions/api/[[path]].js に集約され、context.params.path が
 * /api/ 以降のセグメント配列（例: ['rooms','ABC123','state']）になる。
 */

const ROOM_TTL_DAYS = 30;
const MAX_PLAYERS = 8;
const MAX_BOARD_JSON_BYTES = 300000;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 紛らわしい I/L/O/0/1 を除外
const REPORT_HIDE_THRESHOLD = 3;

// ===== AI判定（Cloudflare Workers AI ビジョン）=====
// 写真の「そっくり度」をビジョンモデルで採点し、人の相互採点を置き換える。
const AI_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const AI_TIMEOUT_MS = 20000;
// カテゴリ→日本語ラベル（プロンプト用。フロントの CATEGORIES と対応）
const CATEGORY_LABELS = {
  manhole: 'マンホール', tree: '街路樹', giant_tree: '巨樹・巨木', post: '郵便ポスト',
  bus_stop: 'バス停', vending: '自動販売機', phone: '公衆電話', hydrant: '消火栓', statue: '銅像・彫刻',
};

// 絵文字リアクションの許可リスト（得点には影響しない。フロントの REACTIONS と一致させること）
const REACTION_EMOJIS = ['😆', '👏', '😮', '❤️'];

/** AIの返答テキストから {stars, pole, comment} を頑健に取り出す */
function parseJudgement(text) {
  const raw = String(text ?? '');
  let obj = null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try { obj = JSON.parse(m[0]); } catch (e) { obj = null; }
  }
  let stars = obj && Number.isFinite(Number(obj.stars)) ? Math.round(Number(obj.stars)) : NaN;
  if (!Number.isFinite(stars)) {
    // JSONが壊れていたら本文から最初の1〜5の数字を拾う
    const d = raw.match(/[1-5]/);
    stars = d ? Number(d[0]) : 3;
  }
  stars = Math.min(5, Math.max(1, stars));
  const pole = obj ? (obj.pole === true || obj.pole === 1 || obj.pole === 'true') : /電柱|でんちゅう|pole/i.test(raw);
  let comment = obj && typeof obj.comment === 'string' ? obj.comment.trim() : '';
  if (!comment) comment = 'AIが判定しました';
  comment = [...comment].slice(0, 40).join('');
  return { stars, pole: pole ? 1 : 0, comment };
}

/** 写真をAIビジョンで採点する。失敗時は例外を投げず、呼び出し側でフォールバックする */
async function judgePhoto(env, bytes, spot) {
  if (!env || !env.AI) {
    throw new Error('AI binding 未設定');
  }
  const category = String(spot.category ?? '');
  const label = CATEGORY_LABELS[category] || String(spot.name ?? 'まちのもの');
  const prompt =
    `あなたは「街のモノまねすごろく」という遊びの審査員です。` +
    `写真に写っている人が「${label}」のモノマネ（そっくりなポーズ・見た目）をどれくらい上手にできているかを採点してください。\n` +
    `次のJSONだけを1行で出力してください。説明文やコードブロックは書かないこと:\n` +
    `{"stars":<1〜5の整数>,"pole":<電柱が写っていればtrue、なければfalse>,"comment":"<子ども向けの短くて楽しい日本語の講評。30文字以内>"}\n` +
    `starsの目安 → 5:そっくり / 4:似ている / 3:まあまあ / 2:あと一歩 / 1:あまり似ていない。`;
  const run = env.AI.run(AI_MODEL, {
    prompt,
    image: [...bytes],
    max_tokens: 200,
    temperature: 0.3,
  });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('AI応答がタイムアウトしました')), AI_TIMEOUT_MS));
  const res = await Promise.race([run, timeout]);
  const text = typeof res === 'string' ? res : (res && (res.response ?? res.description ?? res.text)) || '';
  return parseJudgement(text);
}

// exit相当。fail()でthrowし、onRequestのcatchでJSON応答に変換する
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function fail(status, message) {
  throw new HttpError(status, message);
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function nowIso() {
  // PHPの gmdate('Y-m-d\TH:i:s\Z') に合わせてミリ秒を落とす
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function randomHex(nBytes) {
  const a = new Uint8Array(nBytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const tokenHash = (token) => sha256hex(token);
const genToken = () => randomHex(24);

function randInt(maxExclusive) {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return Math.floor((a[0] / 2 ** 32) * maxExclusive);
}

async function readJsonBody(request) {
  const raw = await request.text();
  if (raw.length > 1000000) {
    fail(413, 'リクエストが大きすぎます');
  }
  if (raw === '') {
    return {};
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    fail(400, 'JSONを解釈できません');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    fail(400, 'JSONを解釈できません');
  }
  return data;
}

function validateNickname(nickname) {
  nickname = String(nickname ?? '').trim();
  const len = [...nickname].length; // コードポイント数（mb_strlen相当）
  if (len < 1 || len > 10) {
    fail(400, 'ニックネームは1〜10文字にしてください');
  }
  return nickname;
}

function validateIcon(icon) {
  icon = String(icon ?? '').trim();
  if (icon === '' || [...icon].length > 4) {
    return '🙂';
  }
  return icon;
}

async function genCode(db) {
  for (let t = 0; t < 20; t++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_CHARS[randInt(CODE_CHARS.length)];
    }
    const row = await db.prepare('SELECT 1 FROM rooms WHERE code = ?').bind(code).first();
    if (row === null) {
      return code;
    }
  }
  fail(500, '部屋コードを生成できませんでした');
}

function bearerToken(request) {
  const token = request.headers.get('X-Player-Token') || '';
  return token !== '' ? token : null;
}

/** 匿名投票者の識別子（Cookie + IP のハッシュ。個人特定はしない）。
 *  Cookieが無ければ新規発行し、setCookieヘッダを返す */
async function voterHash(request) {
  const cookies = request.headers.get('Cookie') || '';
  const m = cookies.match(/(?:^|;\s*)monomane_voter=([a-f0-9]{32})(?:;|$)/);
  let id = m ? m[1] : '';
  let setCookie = null;
  if (id === '') {
    id = randomHex(16);
    setCookie =
      `monomane_voter=${id}; Max-Age=${86400 * 365}; Path=/; SameSite=Lax`;
  }
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const hash = await sha256hex(id + '|' + ip);
  return { hash, setCookie };
}

/** D1のBLOB返却値（ArrayBuffer / number[] / TypedArray）をUint8Arrayへ正規化 */
function toBytes(blob) {
  if (blob instanceof Uint8Array) return blob;
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
  if (ArrayBuffer.isView(blob)) return new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
  if (Array.isArray(blob)) return new Uint8Array(blob);
  return new Uint8Array(blob);
}

/** マジックバイトによるMIME判定（getimagesize相当の代替） */
function detectMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** 期限切れ部屋の遅延削除（cron不要にするための簡易実装。1/20の確率で実行） */
async function cleanupExpired(db) {
  if (randInt(20) !== 0) {
    return;
  }
  await db.prepare('DELETE FROM rooms WHERE expires_at < ?').bind(nowIso()).run();
}

async function findRoom(db, code) {
  code = String(code).toUpperCase().trim();
  if (!/^[A-Z2-9]{6}$/.test(code)) {
    fail(400, '部屋コードの形式が不正です');
  }
  const room = await db.prepare('SELECT * FROM rooms WHERE code = ?').bind(code).first();
  if (room === null) {
    fail(404, '部屋が見つかりません');
  }
  if (room.expires_at < nowIso()) {
    fail(410, 'この部屋は期限切れです');
  }
  return room;
}

/** トークンからこの部屋のプレイヤーを特定し、last_seenを更新して返す */
async function authPlayer(db, request, room) {
  const token = bearerToken(request);
  if (token === null) {
    fail(401, 'X-Player-Tokenヘッダが必要です');
  }
  const player = await db
    .prepare('SELECT * FROM players WHERE room_id = ? AND token_hash = ?')
    .bind(room.id, await tokenHash(token))
    .first();
  if (player === null) {
    fail(403, 'この部屋のメンバーではありません');
  }
  await db.prepare('UPDATE players SET last_seen_at = ? WHERE id = ?').bind(nowIso(), player.id).run();
  return player;
}

async function roomState(db, room, viewerId = null) {
  const playersRes = await db
    .prepare(
      `SELECT id, nickname, icon, is_host, position, score, last_seen_at
       FROM players WHERE room_id = ? ORDER BY joined_at`
    )
    .bind(room.id)
    .all();
  const players = playersRes.results.map((p) => ({
    id: Number(p.id),
    nickname: p.nickname,
    icon: p.icon,
    isHost: !!p.is_host,
    position: Number(p.position),
    score: Number(p.score),
    lastSeenAt: p.last_seen_at,
  }));

  const rowsRes = await db
    .prepare(
      `SELECT p.id, p.player_id, p.spot_index, p.spot_name, p.category, p.base_points, p.created_at,
              p.ai_stars, p.ai_pole, p.ai_comment, p.ai_status,
              pl.nickname, pl.icon,
              (SELECT pub.id FROM published_photos pub WHERE pub.photo_id = p.id) AS published_id
       FROM photos p JOIN players pl ON pl.id = p.player_id
       WHERE p.room_id = ? ORDER BY p.created_at`
    )
    .bind(room.id)
    .all();
  const rows = rowsRes.results;

  // 絵文字リアクション集計（得点には一切影響しない）。写真ごとの emoji→件数 と、閲覧者自身の反応
  const reactionByPhoto = {};
  const myReaction = {};
  const rxRes = await db
    .prepare(
      `SELECT r.photo_id, r.emoji, COUNT(*) AS c
       FROM reactions r JOIN photos p ON p.id = r.photo_id
       WHERE p.room_id = ? GROUP BY r.photo_id, r.emoji`
    )
    .bind(room.id)
    .all();
  for (const r of rxRes.results) {
    const pid = Number(r.photo_id);
    (reactionByPhoto[pid] ??= {})[r.emoji] = Number(r.c);
  }
  if (viewerId !== null) {
    const mineRx = await db
      .prepare(
        `SELECT r.photo_id, r.emoji FROM reactions r JOIN photos p ON p.id = r.photo_id
         WHERE p.room_id = ? AND r.player_id = ?`
      )
      .bind(room.id, viewerId)
      .all();
    for (const r of mineRx.results) {
      myReaction[Number(r.photo_id)] = r.emoji;
    }
  }

  const scoreByPlayer = {};
  const photos = [];
  for (const row of rows) {
    // AIが採点した星（1〜5）を得点にする。未判定(NULL)は0点扱いで、判定完了後に反映される
    const stars = row.ai_stars !== null && row.ai_stars !== undefined ? Number(row.ai_stars) : null;
    const bonus = Number(row.ai_pole) > 0 ? 5 : 0;
    const points = stars !== null ? Math.round(Number(row.base_points) * stars) + bonus : 0;
    const pid = Number(row.player_id);
    scoreByPlayer[pid] = (scoreByPlayer[pid] ?? 0) + points;
    photos.push({
      id: Number(row.id),
      playerId: pid,
      nickname: row.nickname,
      icon: row.icon,
      spotIndex: Number(row.spot_index),
      spotName: row.spot_name,
      category: row.category,
      basePoints: Number(row.base_points),
      url: 'api/photos/' + Number(row.id),
      aiStatus: row.ai_status || 'pending',
      aiStars: stars,
      aiComment: row.ai_comment || null,
      // 既存フロント互換: avgStars=AIの星, poleBonus=電柱, ratingCount=判定済みなら1
      avgStars: stars,
      poleBonus: bonus > 0,
      ratingCount: stars !== null ? 1 : 0,
      points: points,
      reactions: reactionByPhoto[Number(row.id)] ?? {},
      myReaction: myReaction[Number(row.id)] ?? null,
      publishedId: row.published_id !== null ? Number(row.published_id) : null,
      createdAt: row.created_at,
    });
  }

  for (const player of players) {
    player.score = scoreByPlayer[player.id] ?? 0;
  }

  return {
    photos,
    room: {
      code: room.code,
      status: room.status,
      board: JSON.parse(room.board_json),
      createdAt: room.created_at,
      finishedAt: room.finished_at,
      expiresAt: room.expires_at,
    },
    players,
    serverTime: nowIso(),
  };
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const method = request.method;
  const segments = (Array.isArray(params.path) ? params.path : [params.path])
    .filter((s) => s !== '' && s !== undefined && s !== null);
  const db = env.DB;

  try {
    await cleanupExpired(db);

    // ===== POST /route … ORSキーをサーバに隠したまま徒歩経路を代理取得 =====
    if (method === 'POST' && segments.length === 1 && segments[0] === 'route') {
      const key = String(env.ORS_API_KEY || '');
      if (key === '') {
        fail(503, '経路APIキーが未設定です（環境変数 ORS_API_KEY）');
      }
      const body = await readJsonBody(request);
      const coordinates = body.coordinates ?? null;
      if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > 50) {
        fail(400, 'coordinates は2〜50点の配列で指定してください');
      }
      for (const pair of coordinates) {
        if (
          !Array.isArray(pair) || pair.length !== 2 ||
          typeof pair[0] !== 'number' || typeof pair[1] !== 'number' ||
          !isFinite(pair[0]) || !isFinite(pair[1]) ||
          Math.abs(pair[0]) > 180 || Math.abs(pair[1]) > 90
        ) {
          fail(400, '座標の形式が不正です');
        }
      }
      let orsRes;
      try {
        orsRes = await fetch('https://api.openrouteservice.org/v2/directions/foot-walking/geojson', {
          method: 'POST',
          headers: { Authorization: key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ coordinates }),
        });
      } catch (e) {
        fail(502, '経路APIに接続できませんでした');
      }
      if (!orsRes.ok) {
        fail(502, '経路APIに接続できませんでした');
      }
      return new Response(orsRes.body, {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // ===== POST /rooms … 部屋作成 =====
    if (method === 'POST' && segments.length === 1 && segments[0] === 'rooms') {
      const body = await readJsonBody(request);
      const nickname = validateNickname(body.nickname ?? '');
      const icon = validateIcon(body.icon ?? '');
      const board = body.board ?? null;
      if (board === null || typeof board !== 'object' || !Array.isArray(board.spots)) {
        fail(400, 'board.spots が必要です');
      }
      const spotCount = board.spots.length;
      if (spotCount < 2 || spotCount > 30) {
        fail(400, 'マス数は2〜30にしてください');
      }
      const boardJson = JSON.stringify(board);
      if (new TextEncoder().encode(boardJson).length > MAX_BOARD_JSON_BYTES) {
        fail(413, '盤面データが大きすぎます');
      }

      const code = await genCode(db);
      const token = genToken();
      const now = nowIso();
      const expiresAt = new Date(Date.now() + ROOM_TTL_DAYS * 86400 * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');

      const roomRes = await db
        .prepare(
          `INSERT INTO rooms(code, status, board_json, created_at, expires_at)
           VALUES(?, 'playing', ?, ?, ?)`
        )
        .bind(code, boardJson, now, expiresAt)
        .run();
      const roomId = roomRes.meta.last_row_id;
      const playerRes = await db
        .prepare(
          `INSERT INTO players(room_id, nickname, icon, token_hash, is_host, joined_at, last_seen_at)
           VALUES(?, ?, ?, ?, 1, ?, ?)`
        )
        .bind(roomId, nickname, icon, await tokenHash(token), now, now)
        .run();
      const playerId = playerRes.meta.last_row_id;

      return json(
        { code, playerToken: token, playerId: Number(playerId), expiresAt },
        201
      );
    }

    // ===== /rooms/{code}/... =====
    if (segments.length >= 3 && segments[0] === 'rooms') {
      const room = await findRoom(db, segments[1]);
      const action = segments[2];

      // POST /rooms/{code}/join
      if (method === 'POST' && action === 'join') {
        if (room.status !== 'playing') {
          fail(409, 'この部屋は終了しています');
        }
        const body = await readJsonBody(request);
        const nickname = validateNickname(body.nickname ?? '');
        const icon = validateIcon(body.icon ?? '');

        const cnt = await db.prepare('SELECT COUNT(*) AS c FROM players WHERE room_id = ?').bind(room.id).first();
        if (Number(cnt.c) >= MAX_PLAYERS) {
          fail(409, '満室です（最大' + MAX_PLAYERS + '人）');
        }

        const token = genToken();
        const now = nowIso();
        const res = await db
          .prepare(
            `INSERT INTO players(room_id, nickname, icon, token_hash, is_host, joined_at, last_seen_at)
             VALUES(?, ?, ?, ?, 0, ?, ?)`
          )
          .bind(room.id, nickname, icon, await tokenHash(token), now, now)
          .run();
        const playerId = Number(res.meta.last_row_id);

        const state = await roomState(db, room, playerId);
        state.playerToken = token;
        state.playerId = playerId;
        return json(state, 201);
      }

      // GET /rooms/{code}/state
      if (method === 'GET' && action === 'state') {
        const me = await authPlayer(db, request, room);
        return json(await roomState(db, room, Number(me.id)));
      }

      // POST /rooms/{code}/photos … 写真アップロード（multipart）
      if (method === 'POST' && action === 'photos') {
        const player = await authPlayer(db, request, room);
        const form = await request.formData();
        const file = form.get('photo');
        if (!file || typeof file === 'string') {
          fail(400, '写真を受け取れませんでした');
        }
        if (file.size > MAX_PHOTO_BYTES) {
          fail(413, '写真が大きすぎます（上限' + Math.floor(MAX_PHOTO_BYTES / 1024 / 1024) + 'MB）');
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const mime = detectMime(bytes);
        if (mime === null || !['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
          fail(415, '画像ファイル（JPEG/PNG/WebP）を送ってください');
        }
        const spotIndex = parseInt(form.get('spotIndex') ?? '-1', 10);
        const board = JSON.parse(room.board_json);
        const spots = board.spots ?? [];
        if (!Number.isInteger(spotIndex) || spotIndex < 0 || spotIndex >= spots.length) {
          fail(400, 'spotIndex が盤面の範囲外です');
        }
        const spot = spots[spotIndex];

        const res = await db
          .prepare(
            `INSERT INTO photos(room_id, player_id, spot_index, spot_name, category, base_points, mime, photo_blob, created_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            room.id,
            player.id,
            spotIndex,
            String(spot.name ?? 'スポット'),
            String(spot.category ?? 'manhole'),
            parseInt(spot.points ?? 10, 10) || 10,
            mime,
            bytes,
            nowIso()
          )
          .run();
        const photoId = Number(res.meta.last_row_id);

        // AIビジョンで即採点する。失敗しても写真は保存済みなので、星3のフォールバックで続行する
        let judged;
        try {
          judged = await judgePhoto(env, bytes, spot);
          await db
            .prepare('UPDATE photos SET ai_stars = ?, ai_pole = ?, ai_comment = ?, ai_status = ? WHERE id = ?')
            .bind(judged.stars, judged.pole, judged.comment, 'done', photoId)
            .run();
        } catch (aiError) {
          console.error('AI判定に失敗:', aiError && aiError.stack ? aiError.stack : aiError);
          judged = { stars: 3, pole: 0, comment: 'AIの判定が間に合いませんでした' };
          await db
            .prepare('UPDATE photos SET ai_stars = ?, ai_pole = ?, ai_comment = ?, ai_status = ? WHERE id = ?')
            .bind(judged.stars, judged.pole, judged.comment, 'failed', photoId)
            .run();
        }
        return json(
          { ok: true, photoId, aiStars: judged.stars, aiPole: !!judged.pole, aiComment: judged.comment },
          201
        );
      }

      // POST /rooms/{code}/progress
      if (method === 'POST' && action === 'progress') {
        if (room.status !== 'playing') {
          fail(409, 'この部屋は終了しています');
        }
        const player = await authPlayer(db, request, room);
        const body = await readJsonBody(request);
        const raw = body.position ?? null;
        if (!(typeof raw === 'number' && Number.isFinite(raw) && Math.trunc(raw) === raw)) {
          fail(400, 'position は整数で指定してください');
        }
        const position = raw;
        const board = JSON.parse(room.board_json);
        const max = Array.isArray(board.spots) ? board.spots.length - 1 : 0;
        if (position < -1 || position > max) {
          fail(400, 'position が盤面の範囲外です');
        }
        await db.prepare('UPDATE players SET position = ? WHERE id = ?').bind(position, player.id).run();
        return json({ ok: true, position });
      }

      // POST /rooms/{code}/finish
      if (method === 'POST' && action === 'finish') {
        const player = await authPlayer(db, request, room);
        if (!player.is_host) {
          fail(403, '終了できるのはホストだけです');
        }
        await db
          .prepare(`UPDATE rooms SET status = 'finished', finished_at = ? WHERE id = ?`)
          .bind(nowIso(), room.id)
          .run();
        return json({ ok: true, status: 'finished' });
      }

      // DELETE /rooms/{code}/players/me
      if (method === 'DELETE' && action === 'players' && segments[3] === 'me') {
        const player = await authPlayer(db, request, room);
        if (player.is_host) {
          fail(403, 'ホストは退出できません。部屋を終了してください');
        }
        await db.prepare('DELETE FROM players WHERE id = ?').bind(player.id).run();
        return json({ ok: true });
      }
    }

    // ===== ネット採点（公開ギャラリー） =====

    // GET /gallery … 公開一覧（認証不要）
    if (method === 'GET' && segments.length === 1 && segments[0] === 'gallery') {
      const res = await db
        .prepare(
          `SELECT pub.id, pub.spot_name, pub.category, pub.nickname, pub.published_at,
                  (SELECT COUNT(*) FROM net_votes v WHERE v.published_id = pub.id) AS vote_count,
                  (SELECT AVG(v.stars) FROM net_votes v WHERE v.published_id = pub.id) AS avg_stars
           FROM published_photos pub
           WHERE pub.hidden = 0
           ORDER BY pub.published_at DESC LIMIT 60`
        )
        .all();
      const items = res.results.map((row) => {
        const count = Number(row.vote_count);
        return {
          id: Number(row.id),
          url: 'api/gallery/' + Number(row.id) + '/image',
          spotName: row.spot_name,
          category: row.category,
          nickname: row.nickname,
          voteCount: count,
          avgStars: count > 0 ? Math.round(Number(row.avg_stars) * 10) / 10 : null,
          publishedAt: row.published_at,
        };
      });
      return json({ items });
    }

    // GET /gallery/{id}/image … 公開画像（認証不要）
    if (method === 'GET' && segments.length === 3 && segments[0] === 'gallery' && segments[2] === 'image') {
      const pub = await db
        .prepare('SELECT * FROM published_photos WHERE id = ? AND hidden = 0')
        .bind(parseInt(segments[1], 10) || 0)
        .first();
      if (pub === null) {
        fail(404, '公開写真が見つかりません');
      }
      const bytes = toBytes(pub.public_blob);
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': pub.mime || 'image/jpeg',
          'Cache-Control': 'public, max-age=3600',
          'Content-Length': String(bytes.length),
        },
      });
    }

    // POST /gallery/{id}/votes … 星投票（認証不要・1ブラウザ1票）
    if (method === 'POST' && segments.length === 3 && segments[0] === 'gallery' && segments[2] === 'votes') {
      const id = parseInt(segments[1], 10) || 0;
      const pub = await db.prepare('SELECT id FROM published_photos WHERE id = ? AND hidden = 0').bind(id).first();
      if (pub === null) {
        fail(404, '公開写真が見つかりません');
      }
      const body = await readJsonBody(request);
      const stars = parseInt(body.stars ?? 0, 10) || 0;
      if (stars < 1 || stars > 5) {
        fail(400, '星は1〜5で指定してください');
      }
      const { hash, setCookie } = await voterHash(request);
      await db
        .prepare(
          `INSERT INTO net_votes(published_id, voter_hash, stars, created_at)
           VALUES(?, ?, ?, ?)
           ON CONFLICT(published_id, voter_hash)
           DO UPDATE SET stars = excluded.stars`
        )
        .bind(id, hash, stars, nowIso())
        .run();
      return json({ ok: true }, 200, setCookie ? { 'Set-Cookie': setCookie } : {});
    }

    // POST /gallery/{id}/reports … 通報（閾値超過で自動非公開）
    if (method === 'POST' && segments.length === 3 && segments[0] === 'gallery' && segments[2] === 'reports') {
      const id = parseInt(segments[1], 10) || 0;
      const pub = await db.prepare('SELECT id FROM published_photos WHERE id = ?').bind(id).first();
      if (pub === null) {
        fail(404, '公開写真が見つかりません');
      }
      const { hash, setCookie } = await voterHash(request);
      await db
        .prepare('INSERT OR IGNORE INTO reports(published_id, reporter_hash, created_at) VALUES(?, ?, ?)')
        .bind(id, hash, nowIso())
        .run();
      const cnt = await db.prepare('SELECT COUNT(*) AS c FROM reports WHERE published_id = ?').bind(id).first();
      const count = Number(cnt.c);
      if (count >= REPORT_HIDE_THRESHOLD) {
        await db.prepare('UPDATE published_photos SET hidden = 1 WHERE id = ?').bind(id).run();
        console.log(`[monomane] published_photo #${id} を通報${count}件で自動非公開にしました`);
      }
      return json({ ok: true, hidden: count >= REPORT_HIDE_THRESHOLD }, 200, setCookie ? { 'Set-Cookie': setCookie } : {});
    }

    // POST/DELETE /photos/{id}/publish … ネット公開（本人のみ）
    if (segments.length === 3 && segments[0] === 'photos' && segments[2] === 'publish') {
      const photo = await db.prepare('SELECT * FROM photos WHERE id = ?').bind(parseInt(segments[1], 10) || 0).first();
      if (photo === null) {
        fail(404, '写真が見つかりません');
      }
      const room = await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(photo.room_id).first();
      const player = await authPlayer(db, request, room);
      if (Number(player.id) !== Number(photo.player_id)) {
        fail(403, '公開できるのは撮影した本人だけです');
      }

      // 取り下げ
      if (method === 'DELETE') {
        // 投票・通報はカスケードで消える
        await db.prepare('DELETE FROM published_photos WHERE photo_id = ?').bind(photo.id).run();
        return json({ ok: true, published: false });
      }

      if (method !== 'POST') {
        fail(405, 'メソッドが不正です');
      }
      const form = await request.formData();
      const file = form.get('photo');
      if (!file || typeof file === 'string') {
        fail(400, '公開用画像を受け取れませんでした');
      }
      if (file.size > MAX_PHOTO_BYTES) {
        fail(413, '画像が大きすぎます');
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = detectMime(bytes);
      if (mime === null || !['image/jpeg', 'image/png'].includes(mime)) {
        fail(415, '画像ファイルを送ってください');
      }

      await db
        .prepare(
          `INSERT INTO published_photos(photo_id, mime, public_blob, spot_name, category, nickname, published_at)
           VALUES(?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(photo_id) DO UPDATE SET
              mime = excluded.mime,
              public_blob = excluded.public_blob,
              published_at = excluded.published_at,
              hidden = 0`
        )
        .bind(photo.id, mime, bytes, photo.spot_name, photo.category, player.nickname, nowIso())
        .run();
      return json({ ok: true, published: true }, 201);
    }

    // GET /photos/{id} … 写真配信（部屋メンバーのみ）
    if (method === 'GET' && segments.length === 2 && segments[0] === 'photos') {
      const photo = await db
        .prepare(
          `SELECT ph.*, r.code AS room_code FROM photos ph
           JOIN rooms r ON r.id = ph.room_id WHERE ph.id = ?`
        )
        .bind(parseInt(segments[1], 10) || 0)
        .first();
      if (photo === null) {
        fail(404, '写真が見つかりません');
      }
      const url = new URL(request.url);
      const token = bearerToken(request) ?? (url.searchParams.get('t') ?? '');
      const allowed = await db
        .prepare('SELECT 1 FROM players WHERE room_id = ? AND token_hash = ?')
        .bind(photo.room_id, await tokenHash(String(token)))
        .first();
      if (allowed === null) {
        fail(403, 'この写真を見る権限がありません');
      }
      const bytes = toBytes(photo.photo_blob);
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': photo.mime || 'image/jpeg',
          'Cache-Control': 'private, max-age=86400',
          'Content-Length': String(bytes.length),
        },
      });
    }

    // POST /photos/{id}/reactions … 絵文字リアクション（得点に影響しない）
    // 1人1写真1つ。同じ絵文字を再送で取り消し、別の絵文字で差し替え
    if (method === 'POST' && segments.length === 3 && segments[0] === 'photos' && segments[2] === 'reactions') {
      const photo = await db.prepare('SELECT * FROM photos WHERE id = ?').bind(parseInt(segments[1], 10) || 0).first();
      if (photo === null) {
        fail(404, '写真が見つかりません');
      }
      const room = await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(photo.room_id).first();
      const player = await authPlayer(db, request, room);
      if (Number(player.id) === Number(photo.player_id)) {
        fail(403, '自分の写真にはリアクションできません');
      }
      const body = await readJsonBody(request);
      const emoji = String(body.emoji ?? '');
      if (!REACTION_EMOJIS.includes(emoji)) {
        fail(400, '使えない絵文字です');
      }
      const existing = await db
        .prepare('SELECT emoji FROM reactions WHERE photo_id = ? AND player_id = ?')
        .bind(photo.id, player.id)
        .first();
      let active;
      if (existing && existing.emoji === emoji) {
        // 同じ絵文字をもう一度 → 取り消し
        await db.prepare('DELETE FROM reactions WHERE photo_id = ? AND player_id = ?').bind(photo.id, player.id).run();
        active = null;
      } else {
        await db
          .prepare(
            `INSERT INTO reactions(photo_id, player_id, emoji, created_at)
             VALUES(?, ?, ?, ?)
             ON CONFLICT(photo_id, player_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at`
          )
          .bind(photo.id, player.id, emoji, nowIso())
          .run();
        active = emoji;
      }
      return json({ ok: true, myReaction: active });
    }

    // POST /photos/{id}/ratings … 旧・相互採点。AI判定へ移行したため廃止
    if (method === 'POST' && segments.length === 3 && segments[0] === 'photos' && segments[2] === 'ratings') {
      fail(410, '相互採点は廃止されました（写真はAIが採点し、人は絵文字リアクションを送れます）');
    }

    fail(404, 'エンドポイントが見つかりません');
  } catch (e) {
    if (e instanceof HttpError) {
      return json({ error: e.message }, e.status);
    }
    console.error('API error:', e && e.stack ? e.stack : e);
    return json({ error: 'サーバ内部エラー' }, 500);
  }
}
