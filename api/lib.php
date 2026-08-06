<?php
declare(strict_types=1);

/**
 * 街のモノまねすごろく API 共通ライブラリ（P1）
 * DB: SQLite1ファイル。api/data/ 配下（.htaccessで外部アクセス拒否）
 */

const ROOM_TTL_DAYS = 30;
const MAX_PLAYERS = 8;
const MAX_BOARD_JSON_BYTES = 300000;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 紛らわしい I/L/O/0/1 を除外

function db(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $dir = __DIR__ . '/data';
        if (!is_dir($dir)) {
            mkdir($dir, 0770, true);
        }
        $pdo = new PDO('sqlite:' . $dir . '/app.sqlite');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $pdo->exec('PRAGMA journal_mode=WAL');
        $pdo->exec('PRAGMA foreign_keys=ON');
        migrate($pdo);
    }
    return $pdo;
}

function migrate(PDO $pdo): void {
    $pdo->exec('CREATE TABLE IF NOT EXISTS rooms(
        id INTEGER PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT "playing",
        board_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        expires_at TEXT NOT NULL
    )');
    $pdo->exec('CREATE TABLE IF NOT EXISTS players(
        id INTEGER PRIMARY KEY,
        room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        nickname TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT "🙂",
        token_hash TEXT NOT NULL,
        is_host INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT -1,
        score INTEGER NOT NULL DEFAULT 0,
        joined_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
    )');
    $pdo->exec('CREATE TABLE IF NOT EXISTS photos(
        id INTEGER PRIMARY KEY,
        room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        spot_index INTEGER NOT NULL,
        spot_name TEXT NOT NULL,
        category TEXT NOT NULL,
        base_points INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL
    )');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_photos_room ON photos(room_id)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS ratings(
        id INTEGER PRIMARY KEY,
        photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
        rater_player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        stars INTEGER NOT NULL,
        pole_bonus INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(photo_id, rater_player_id)
    )');
    $pdo->exec('CREATE TABLE IF NOT EXISTS published_photos(
        id INTEGER PRIMARY KEY,
        photo_id INTEGER NOT NULL UNIQUE REFERENCES photos(id) ON DELETE CASCADE,
        public_path TEXT NOT NULL,
        spot_name TEXT NOT NULL,
        category TEXT NOT NULL,
        nickname TEXT NOT NULL,
        published_at TEXT NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0
    )');
    $pdo->exec('CREATE TABLE IF NOT EXISTS net_votes(
        id INTEGER PRIMARY KEY,
        published_id INTEGER NOT NULL REFERENCES published_photos(id) ON DELETE CASCADE,
        voter_hash TEXT NOT NULL,
        stars INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(published_id, voter_hash)
    )');
    $pdo->exec('CREATE TABLE IF NOT EXISTS reports(
        id INTEGER PRIMARY KEY,
        published_id INTEGER NOT NULL REFERENCES published_photos(id) ON DELETE CASCADE,
        reporter_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(published_id, reporter_hash)
    )');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_id)');
    $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_players_token ON players(token_hash)');
}

function now_iso(): string {
    return gmdate('Y-m-d\TH:i:s\Z');
}

function json_out($data, int $status = 200): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(int $status, string $message): never {
    json_out(['error' => $message], $status);
}

function read_json_body(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > 1000000) {
        fail(413, 'リクエストが大きすぎます');
    }
    if ($raw === '') {
        return [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        fail(400, 'JSONを解釈できません');
    }
    return $data;
}

function gen_code(PDO $pdo): string {
    for ($try = 0; $try < 20; $try++) {
        $code = '';
        for ($i = 0; $i < 6; $i++) {
            $code .= CODE_CHARS[random_int(0, strlen(CODE_CHARS) - 1)];
        }
        $stmt = $pdo->prepare('SELECT 1 FROM rooms WHERE code = ?');
        $stmt->execute([$code]);
        if ($stmt->fetch() === false) {
            return $code;
        }
    }
    fail(500, '部屋コードを生成できませんでした');
}

function gen_token(): string {
    return bin2hex(random_bytes(24));
}

function token_hash(string $token): string {
    return hash('sha256', $token);
}

function bearer_token(): ?string {
    $token = $_SERVER['HTTP_X_PLAYER_TOKEN'] ?? '';
    return $token !== '' ? $token : null;
}

function validate_nickname(string $nickname): string {
    $nickname = trim($nickname);
    $len = mb_strlen($nickname, 'UTF-8');
    if ($len < 1 || $len > 10) {
        fail(400, 'ニックネームは1〜10文字にしてください');
    }
    return $nickname;
}

function validate_icon(string $icon): string {
    $icon = trim($icon);
    if ($icon === '' || mb_strlen($icon, 'UTF-8') > 4) {
        return '🙂';
    }
    return $icon;
}

/** 匿名投票者の識別子（Cookie + IP + UA のハッシュ。個人特定はしない） */
function voter_hash(): string {
    $id = $_COOKIE['monomane_voter'] ?? '';
    if ($id === '' || !preg_match('/^[a-f0-9]{32}$/', $id)) {
        $id = bin2hex(random_bytes(16));
        setcookie('monomane_voter', $id, [
            'expires' => time() + 86400 * 365,
            'path' => '/',
            'samesite' => 'Lax',
        ]);
    }
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    return hash('sha256', $id . '|' . $ip);
}

const REPORT_HIDE_THRESHOLD = 3;

/** 期限切れ部屋の遅延削除（cron不要にするための簡易実装） */
function cleanup_expired(PDO $pdo): void {
    if (random_int(1, 20) !== 1) {
        return; // 1/20の確率で実行、負荷を抑える
    }
    $stmt = $pdo->prepare('DELETE FROM rooms WHERE expires_at < ?');
    $stmt->execute([now_iso()]);
}

function find_room(PDO $pdo, string $code): array {
    $code = strtoupper(trim($code));
    if (!preg_match('/^[A-Z2-9]{6}$/', $code)) {
        fail(400, '部屋コードの形式が不正です');
    }
    $stmt = $pdo->prepare('SELECT * FROM rooms WHERE code = ?');
    $stmt->execute([$code]);
    $room = $stmt->fetch();
    if ($room === false) {
        fail(404, '部屋が見つかりません');
    }
    if ($room['expires_at'] < now_iso()) {
        fail(410, 'この部屋は期限切れです');
    }
    return $room;
}

/** トークンからこの部屋のプレイヤーを特定し、last_seenを更新して返す */
function auth_player(PDO $pdo, array $room): array {
    $token = bearer_token();
    if ($token === null) {
        fail(401, 'X-Player-Tokenヘッダが必要です');
    }
    $stmt = $pdo->prepare('SELECT * FROM players WHERE room_id = ? AND token_hash = ?');
    $stmt->execute([$room['id'], token_hash($token)]);
    $player = $stmt->fetch();
    if ($player === false) {
        fail(403, 'この部屋のメンバーではありません');
    }
    $upd = $pdo->prepare('UPDATE players SET last_seen_at = ? WHERE id = ?');
    $upd->execute([now_iso(), $player['id']]);
    return $player;
}

function room_state(PDO $pdo, array $room, ?int $viewerId = null): array {
    $stmt = $pdo->prepare(
        'SELECT id, nickname, icon, is_host, position, score, last_seen_at
         FROM players WHERE room_id = ? ORDER BY joined_at'
    );
    $stmt->execute([$room['id']]);
    $players = array_map(static function (array $p): array {
        return [
            'id' => (int)$p['id'],
            'nickname' => $p['nickname'],
            'icon' => $p['icon'],
            'isHost' => (bool)$p['is_host'],
            'position' => (int)$p['position'],
            'score' => (int)$p['score'],
            'lastSeenAt' => $p['last_seen_at'],
        ];
    }, $stmt->fetchAll());

    // 写真と採点
    $stmt = $pdo->prepare(
        'SELECT p.*, pl.nickname, pl.icon,
                (SELECT COUNT(*) FROM ratings r WHERE r.photo_id = p.id) AS rating_count,
                (SELECT AVG(r.stars) FROM ratings r WHERE r.photo_id = p.id) AS avg_stars,
                (SELECT MAX(r.pole_bonus) FROM ratings r WHERE r.photo_id = p.id) AS pole_bonus,
                (SELECT pub.id FROM published_photos pub WHERE pub.photo_id = p.id) AS published_id
         FROM photos p JOIN players pl ON pl.id = p.player_id
         WHERE p.room_id = ? ORDER BY p.created_at'
    );
    $stmt->execute([$room['id']]);
    $rows = $stmt->fetchAll();

    // 自分が採点済みの写真ID
    $myRated = [];
    if ($viewerId !== null) {
        $stmt2 = $pdo->prepare(
            'SELECT photo_id FROM ratings WHERE rater_player_id = ?'
        );
        $stmt2->execute([$viewerId]);
        foreach ($stmt2->fetchAll() as $r) {
            $myRated[(int)$r['photo_id']] = true;
        }
    }

    $scoreByPlayer = [];
    $photos = [];
    foreach ($rows as $row) {
        $count = (int)$row['rating_count'];
        $avg = $count > 0 ? round((float)$row['avg_stars'], 1) : null;
        $bonus = $count > 0 ? ((int)$row['pole_bonus'] > 0 ? 5 : 0) : 0;
        $points = $avg !== null ? (int)round((int)$row['base_points'] * $avg) + $bonus : 0;
        $pid = (int)$row['player_id'];
        $scoreByPlayer[$pid] = ($scoreByPlayer[$pid] ?? 0) + $points;
        $photos[] = [
            'id' => (int)$row['id'],
            'playerId' => $pid,
            'nickname' => $row['nickname'],
            'icon' => $row['icon'],
            'spotIndex' => (int)$row['spot_index'],
            'spotName' => $row['spot_name'],
            'category' => $row['category'],
            'basePoints' => (int)$row['base_points'],
            'url' => 'api/photos/' . (int)$row['id'],
            'ratingCount' => $count,
            'avgStars' => $avg,
            'poleBonus' => $bonus > 0,
            'points' => $points,
            'ratedByMe' => isset($myRated[(int)$row['id']]),
            'publishedId' => $row['published_id'] !== null ? (int)$row['published_id'] : null,
            'createdAt' => $row['created_at'],
        ];
    }

    foreach ($players as &$player) {
        $player['score'] = $scoreByPlayer[$player['id']] ?? 0;
    }
    unset($player);

    return [
        'photos' => $photos,
        'room' => [
            'code' => $room['code'],
            'status' => $room['status'],
            'board' => json_decode($room['board_json'], true),
            'createdAt' => $room['created_at'],
            'finishedAt' => $room['finished_at'],
            'expiresAt' => $room['expires_at'],
        ],
        'players' => $players,
        'serverTime' => now_iso(),
    ];
}
