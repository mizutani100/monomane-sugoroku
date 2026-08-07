<?php
declare(strict_types=1);

/**
 * 旅すご API ルーター（P1）
 *
 * エンドポイント:
 *   POST   /api/rooms                    部屋作成（ホスト）
 *   POST   /api/rooms/{code}/join        参加
 *   GET    /api/rooms/{code}/state       状態取得（要トークン）
 *   POST   /api/rooms/{code}/progress    自分の進行を報告（要トークン）
 *   POST   /api/rooms/{code}/finish      部屋終了（ホストのみ）
 *   DELETE /api/rooms/{code}/players/me  退出（ホスト以外）
 */

// APIの応答はJSON/画像のみ。警告やDeprecatedが混ざるとクライアントが壊れるため画面出力を止める
ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);

require __DIR__ . '/lib.php';

function request_path(): string {
    if (!empty($_SERVER['PATH_INFO'])) {
        return $_SERVER['PATH_INFO'];
    }
    $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
    $pos = strpos($uri, '/api');
    return $pos === false ? $uri : (substr($uri, $pos + 4) ?: '/');
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$segments = array_values(array_filter(explode('/', request_path()), static fn($s) => $s !== ''));

try {
    $pdo = db();
    cleanup_expired($pdo);

    // POST /route  … ORSキーをサーバに隠したまま徒歩経路を代理取得する
    if ($method === 'POST' && count($segments) === 1 && $segments[0] === 'route') {
        $secrets = @include __DIR__ . '/secrets.php';
        $key = is_array($secrets) ? (string)($secrets['ors_api_key'] ?? '') : '';
        if ($key === '') {
            fail(503, '経路APIキーが未設定です（api/secrets.php）');
        }
        $body = read_json_body();
        $coordinates = $body['coordinates'] ?? null;
        if (!is_array($coordinates) || count($coordinates) < 2 || count($coordinates) > 50) {
            fail(400, 'coordinates は2〜50点の配列で指定してください');
        }
        foreach ($coordinates as $pair) {
            if (!is_array($pair) || count($pair) !== 2
                || !is_numeric($pair[0]) || !is_numeric($pair[1])
                || abs((float)$pair[0]) > 180 || abs((float)$pair[1]) > 90) {
                fail(400, '座標の形式が不正です');
            }
        }
        $ch = curl_init('https://api.openrouteservice.org/v2/directions/foot-walking/geojson');
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_HTTPHEADER => ['Authorization: ' . $key, 'Content-Type: application/json'],
            CURLOPT_POSTFIELDS => json_encode(['coordinates' => $coordinates]),
        ]);
        $response = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($response === false || $status < 200 || $status >= 300) {
            fail(502, '経路APIに接続できませんでした');
        }
        http_response_code(200);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo $response;
        exit;
    }

    // POST /rooms
    if ($method === 'POST' && count($segments) === 1 && $segments[0] === 'rooms') {
        $body = read_json_body();
        $nickname = validate_nickname((string)($body['nickname'] ?? ''));
        $icon = validate_icon((string)($body['icon'] ?? ''));
        $board = $body['board'] ?? null;
        if (!is_array($board) || !isset($board['spots']) || !is_array($board['spots'])) {
            fail(400, 'board.spots が必要です');
        }
        $spotCount = count($board['spots']);
        if ($spotCount < 2 || $spotCount > 30) {
            fail(400, 'マス数は2〜30にしてください');
        }
        $boardJson = json_encode($board, JSON_UNESCAPED_UNICODE);
        if ($boardJson === false || strlen($boardJson) > MAX_BOARD_JSON_BYTES) {
            fail(413, '盤面データが大きすぎます');
        }

        $code = gen_code($pdo);
        $token = gen_token();
        $now = now_iso();
        $expires = gmdate('Y-m-d\TH:i:s\Z', time() + ROOM_TTL_DAYS * 86400);

        $pdo->beginTransaction();
        $stmt = $pdo->prepare(
            'INSERT INTO rooms(code, status, board_json, created_at, expires_at)
             VALUES(?, "playing", ?, ?, ?)'
        );
        $stmt->execute([$code, $boardJson, $now, $expires]);
        $roomId = (int)$pdo->lastInsertId();
        $stmt = $pdo->prepare(
            'INSERT INTO players(room_id, nickname, icon, token_hash, is_host, joined_at, last_seen_at)
             VALUES(?, ?, ?, ?, 1, ?, ?)'
        );
        $stmt->execute([$roomId, $nickname, $icon, token_hash($token), $now, $now]);
        $playerId = (int)$pdo->lastInsertId();
        $pdo->commit();

        json_out([
            'code' => $code,
            'playerToken' => $token,
            'playerId' => $playerId,
            'expiresAt' => $expires,
        ], 201);
    }

    // /rooms/{code}/...
    if (count($segments) >= 3 && $segments[0] === 'rooms') {
        $room = find_room($pdo, $segments[1]);
        $action = $segments[2];

        // POST /rooms/{code}/join
        if ($method === 'POST' && $action === 'join') {
            if ($room['status'] !== 'playing') {
                fail(409, 'この部屋は終了しています');
            }
            $body = read_json_body();
            $nickname = validate_nickname((string)($body['nickname'] ?? ''));
            $icon = validate_icon((string)($body['icon'] ?? ''));

            $stmt = $pdo->prepare('SELECT COUNT(*) AS c FROM players WHERE room_id = ?');
            $stmt->execute([$room['id']]);
            if ((int)$stmt->fetch()['c'] >= MAX_PLAYERS) {
                fail(409, '満室です（最大' . MAX_PLAYERS . '人）');
            }

            $token = gen_token();
            $now = now_iso();
            $stmt = $pdo->prepare(
                'INSERT INTO players(room_id, nickname, icon, token_hash, is_host, joined_at, last_seen_at)
                 VALUES(?, ?, ?, ?, 0, ?, ?)'
            );
            $stmt->execute([$room['id'], $nickname, $icon, token_hash($token), $now, $now]);
            $playerId = (int)$pdo->lastInsertId();

            $state = room_state($pdo, $room, $playerId);
            $state['playerToken'] = $token;
            $state['playerId'] = $playerId;
            json_out($state, 201);
        }

        // GET /rooms/{code}/state
        if ($method === 'GET' && $action === 'state') {
            $me = auth_player($pdo, $room);
            json_out(room_state($pdo, $room, (int)$me['id']));
        }

        // POST /rooms/{code}/photos  … 写真アップロード（multipart）
        if ($method === 'POST' && $action === 'photos') {
            $player = auth_player($pdo, $room);
            if (!isset($_FILES['photo']) || $_FILES['photo']['error'] !== UPLOAD_ERR_OK) {
                fail(400, '写真を受け取れませんでした');
            }
            $file = $_FILES['photo'];
            if ($file['size'] > MAX_PHOTO_BYTES) {
                fail(413, '写真が大きすぎます（上限' . (int)(MAX_PHOTO_BYTES / 1024 / 1024) . 'MB）');
            }
            $info = @getimagesize($file['tmp_name']);
            if ($info === false || !in_array($info['mime'], ['image/jpeg', 'image/png', 'image/webp'], true)) {
                fail(415, '画像ファイル（JPEG/PNG/WebP）を送ってください');
            }
            $spotIndex = (int)($_POST['spotIndex'] ?? -1);
            $board = json_decode($room['board_json'], true);
            $spots = $board['spots'] ?? [];
            if ($spotIndex < 0 || $spotIndex >= count($spots)) {
                fail(400, 'spotIndex が盤面の範囲外です');
            }
            $spot = $spots[$spotIndex];

            $dir = __DIR__ . '/data/photos/' . $room['code'];
            if (!is_dir($dir) && !mkdir($dir, 0770, true)) {
                fail(500, '保存先を作成できません');
            }
            $name = bin2hex(random_bytes(12)) . '.jpg';
            $path = $dir . '/' . $name;
            // EXIF（GPS含む）を落とすため再エンコードして保存
            $source = match ($info['mime']) {
                'image/jpeg' => @imagecreatefromjpeg($file['tmp_name']),
                'image/png' => @imagecreatefrompng($file['tmp_name']),
                'image/webp' => @imagecreatefromwebp($file['tmp_name']),
                default => false,
            };
            if ($source === false) {
                fail(500, '画像を処理できませんでした');
            }
            imagejpeg($source, $path, 82);

            $stmt = $pdo->prepare(
                'INSERT INTO photos(room_id, player_id, spot_index, spot_name, category, base_points, file_path, created_at)
                 VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
            );
            $stmt->execute([
                $room['id'], $player['id'], $spotIndex,
                (string)($spot['name'] ?? 'スポット'),
                (string)($spot['category'] ?? 'manhole'),
                (int)($spot['points'] ?? 10),
                $room['code'] . '/' . $name, now_iso(),
            ]);
            json_out(['ok' => true, 'photoId' => (int)$pdo->lastInsertId()], 201);
        }

        // POST /rooms/{code}/progress
        if ($method === 'POST' && $action === 'progress') {
            if ($room['status'] !== 'playing') {
                fail(409, 'この部屋は終了しています');
            }
            $player = auth_player($pdo, $room);
            $body = read_json_body();
            $position = $body['position'] ?? null;
            if (!is_int($position) && !(is_numeric($position) && (int)$position == $position)) {
                fail(400, 'position は整数で指定してください');
            }
            $position = (int)$position;
            $board = json_decode($room['board_json'], true);
            $max = is_array($board['spots'] ?? null) ? count($board['spots']) - 1 : 0;
            if ($position < -1 || $position > $max) {
                fail(400, 'position が盤面の範囲外です');
            }
            $stmt = $pdo->prepare('UPDATE players SET position = ? WHERE id = ?');
            $stmt->execute([$position, $player['id']]);
            json_out(['ok' => true, 'position' => $position]);
        }

        // POST /rooms/{code}/finish
        if ($method === 'POST' && $action === 'finish') {
            $player = auth_player($pdo, $room);
            if (!(bool)$player['is_host']) {
                fail(403, '終了できるのはホストだけです');
            }
            $stmt = $pdo->prepare(
                'UPDATE rooms SET status = "finished", finished_at = ? WHERE id = ?'
            );
            $stmt->execute([now_iso(), $room['id']]);
            json_out(['ok' => true, 'status' => 'finished']);
        }

        // DELETE /rooms/{code}/players/me
        if ($method === 'DELETE' && $action === 'players'
            && isset($segments[3]) && $segments[3] === 'me') {
            $player = auth_player($pdo, $room);
            if ((bool)$player['is_host']) {
                fail(403, 'ホストは退出できません。部屋を終了してください');
            }
            $stmt = $pdo->prepare('DELETE FROM players WHERE id = ?');
            $stmt->execute([$player['id']]);
            json_out(['ok' => true]);
        }
    }

    // ===== ネット採点（公開ギャラリー） =====

    // GET /gallery  … 公開一覧（認証不要）
    if ($method === 'GET' && count($segments) === 1 && $segments[0] === 'gallery') {
        $stmt = $pdo->query(
            'SELECT pub.*,
                    (SELECT COUNT(*) FROM net_votes v WHERE v.published_id = pub.id) AS vote_count,
                    (SELECT AVG(v.stars) FROM net_votes v WHERE v.published_id = pub.id) AS avg_stars
             FROM published_photos pub
             WHERE pub.hidden = 0
             ORDER BY pub.published_at DESC LIMIT 60'
        );
        $items = array_map(static function (array $row): array {
            $count = (int)$row['vote_count'];
            return [
                'id' => (int)$row['id'],
                'url' => 'api/gallery/' . (int)$row['id'] . '/image',
                'spotName' => $row['spot_name'],
                'category' => $row['category'],
                'nickname' => $row['nickname'],
                'voteCount' => $count,
                'avgStars' => $count > 0 ? round((float)$row['avg_stars'], 1) : null,
                'publishedAt' => $row['published_at'],
            ];
        }, $stmt->fetchAll());
        json_out(['items' => $items]);
    }

    // GET /gallery/{id}/image  … 公開画像（認証不要）
    if ($method === 'GET' && count($segments) === 3
        && $segments[0] === 'gallery' && $segments[2] === 'image') {
        $stmt = $pdo->prepare('SELECT * FROM published_photos WHERE id = ? AND hidden = 0');
        $stmt->execute([(int)$segments[1]]);
        $pub = $stmt->fetch();
        if ($pub === false) {
            fail(404, '公開写真が見つかりません');
        }
        $path = __DIR__ . '/data/public/' . $pub['public_path'];
        if (!is_file($path)) {
            fail(404, 'ファイルがありません');
        }
        header('Content-Type: image/jpeg');
        header('Cache-Control: public, max-age=3600');
        header('Content-Length: ' . filesize($path));
        readfile($path);
        exit;
    }

    // POST /gallery/{id}/votes  … 星投票（認証不要・1ブラウザ1票）
    if ($method === 'POST' && count($segments) === 3
        && $segments[0] === 'gallery' && $segments[2] === 'votes') {
        $stmt = $pdo->prepare('SELECT * FROM published_photos WHERE id = ? AND hidden = 0');
        $stmt->execute([(int)$segments[1]]);
        if ($stmt->fetch() === false) {
            fail(404, '公開写真が見つかりません');
        }
        $body = read_json_body();
        $stars = (int)($body['stars'] ?? 0);
        if ($stars < 1 || $stars > 5) {
            fail(400, '星は1〜5で指定してください');
        }
        $stmt = $pdo->prepare(
            'INSERT INTO net_votes(published_id, voter_hash, stars, created_at)
             VALUES(?, ?, ?, ?)
             ON CONFLICT(published_id, voter_hash)
             DO UPDATE SET stars = excluded.stars'
        );
        $stmt->execute([(int)$segments[1], voter_hash(), $stars, now_iso()]);
        json_out(['ok' => true]);
    }

    // POST /gallery/{id}/reports  … 通報（閾値超過で自動非公開）
    if ($method === 'POST' && count($segments) === 3
        && $segments[0] === 'gallery' && $segments[2] === 'reports') {
        $id = (int)$segments[1];
        $stmt = $pdo->prepare('SELECT * FROM published_photos WHERE id = ?');
        $stmt->execute([$id]);
        if ($stmt->fetch() === false) {
            fail(404, '公開写真が見つかりません');
        }
        $stmt = $pdo->prepare(
            'INSERT OR IGNORE INTO reports(published_id, reporter_hash, created_at) VALUES(?, ?, ?)'
        );
        $stmt->execute([$id, voter_hash(), now_iso()]);
        $stmt = $pdo->prepare('SELECT COUNT(*) AS c FROM reports WHERE published_id = ?');
        $stmt->execute([$id]);
        $count = (int)$stmt->fetch()['c'];
        if ($count >= REPORT_HIDE_THRESHOLD) {
            $pdo->prepare('UPDATE published_photos SET hidden = 1 WHERE id = ?')->execute([$id]);
            error_log("[monomane] published_photo #$id を通報{$count}件で自動非公開にしました");
        }
        json_out(['ok' => true, 'hidden' => $count >= REPORT_HIDE_THRESHOLD]);
    }

    // POST /photos/{id}/publish  … ネット公開（本人のみ・モザイク焼き込み済み画像を受け取る）
    if (count($segments) === 3 && $segments[0] === 'photos' && $segments[2] === 'publish') {
        $stmt = $pdo->prepare('SELECT * FROM photos WHERE id = ?');
        $stmt->execute([(int)$segments[1]]);
        $photo = $stmt->fetch();
        if ($photo === false) {
            fail(404, '写真が見つかりません');
        }
        $stmt = $pdo->prepare('SELECT * FROM rooms WHERE id = ?');
        $stmt->execute([$photo['room_id']]);
        $room = $stmt->fetch();
        $player = auth_player($pdo, $room);
        if ((int)$player['id'] !== (int)$photo['player_id']) {
            fail(403, '公開できるのは撮影した本人だけです');
        }

        // 取り下げ
        if ($method === 'DELETE') {
            $stmt = $pdo->prepare('SELECT * FROM published_photos WHERE photo_id = ?');
            $stmt->execute([$photo['id']]);
            $pub = $stmt->fetch();
            if ($pub !== false) {
                $path = __DIR__ . '/data/public/' . $pub['public_path'];
                if (is_file($path)) {
                    unlink($path);
                }
                // 投票・通報はカスケードで消える
                $pdo->prepare('DELETE FROM published_photos WHERE id = ?')->execute([$pub['id']]);
            }
            json_out(['ok' => true, 'published' => false]);
        }

        if ($method !== 'POST') {
            fail(405, 'メソッドが不正です');
        }
        if (!isset($_FILES['photo']) || $_FILES['photo']['error'] !== UPLOAD_ERR_OK) {
            fail(400, '公開用画像を受け取れませんでした');
        }
        $file = $_FILES['photo'];
        if ($file['size'] > MAX_PHOTO_BYTES) {
            fail(413, '画像が大きすぎます');
        }
        $info = @getimagesize($file['tmp_name']);
        if ($info === false || !in_array($info['mime'], ['image/jpeg', 'image/png'], true)) {
            fail(415, '画像ファイルを送ってください');
        }
        $dir = __DIR__ . '/data/public';
        if (!is_dir($dir) && !mkdir($dir, 0770, true)) {
            fail(500, '保存先を作成できません');
        }
        $name = bin2hex(random_bytes(12)) . '.jpg';
        $source = $info['mime'] === 'image/png'
            ? @imagecreatefrompng($file['tmp_name'])
            : @imagecreatefromjpeg($file['tmp_name']);
        if ($source === false) {
            fail(500, '画像を処理できませんでした');
        }
        imagejpeg($source, $dir . '/' . $name, 82);

        $stmt = $pdo->prepare(
            'INSERT INTO published_photos(photo_id, public_path, spot_name, category, nickname, published_at)
             VALUES(?, ?, ?, ?, ?, ?)
             ON CONFLICT(photo_id) DO UPDATE SET
                public_path = excluded.public_path,
                published_at = excluded.published_at,
                hidden = 0'
        );
        $stmt->execute([
            $photo['id'], $name, $photo['spot_name'], $photo['category'],
            $player['nickname'], now_iso(),
        ]);
        json_out(['ok' => true, 'published' => true], 201);
    }

    // GET /photos/{id}  … 写真配信（部屋メンバーのみ）
    if ($method === 'GET' && count($segments) === 2 && $segments[0] === 'photos') {
        $stmt = $pdo->prepare(
            'SELECT ph.*, r.code AS room_code FROM photos ph
             JOIN rooms r ON r.id = ph.room_id WHERE ph.id = ?'
        );
        $stmt->execute([(int)$segments[1]]);
        $photo = $stmt->fetch();
        if ($photo === false) {
            fail(404, '写真が見つかりません');
        }
        $token = bearer_token() ?? ($_GET['t'] ?? '');
        $stmt = $pdo->prepare('SELECT 1 FROM players WHERE room_id = ? AND token_hash = ?');
        $stmt->execute([$photo['room_id'], token_hash((string)$token)]);
        if ($stmt->fetch() === false) {
            fail(403, 'この写真を見る権限がありません');
        }
        $path = __DIR__ . '/data/photos/' . $photo['file_path'];
        if (!is_file($path)) {
            fail(404, '写真ファイルがありません');
        }
        header('Content-Type: image/jpeg');
        header('Cache-Control: private, max-age=86400');
        header('Content-Length: ' . filesize($path));
        readfile($path);
        exit;
    }

    // POST /photos/{id}/ratings  … 相互採点
    if ($method === 'POST' && count($segments) === 3
        && $segments[0] === 'photos' && $segments[2] === 'ratings') {
        $stmt = $pdo->prepare('SELECT * FROM photos WHERE id = ?');
        $stmt->execute([(int)$segments[1]]);
        $photo = $stmt->fetch();
        if ($photo === false) {
            fail(404, '写真が見つかりません');
        }
        $stmt = $pdo->prepare('SELECT * FROM rooms WHERE id = ?');
        $stmt->execute([$photo['room_id']]);
        $room = $stmt->fetch();
        $player = auth_player($pdo, $room);
        if ((int)$player['id'] === (int)$photo['player_id']) {
            fail(403, '自分の写真は採点できません');
        }
        $body = read_json_body();
        $stars = (int)($body['stars'] ?? 0);
        if ($stars < 1 || $stars > 5) {
            fail(400, '星は1〜5で指定してください');
        }
        $bonus = !empty($body['poleBonus']) ? 1 : 0;
        $stmt = $pdo->prepare(
            'INSERT INTO ratings(photo_id, rater_player_id, stars, pole_bonus, created_at)
             VALUES(?, ?, ?, ?, ?)
             ON CONFLICT(photo_id, rater_player_id)
             DO UPDATE SET stars = excluded.stars, pole_bonus = excluded.pole_bonus'
        );
        $stmt->execute([$photo['id'], $player['id'], $stars, $bonus, now_iso()]);
        json_out(['ok' => true]);
    }

    fail(404, 'エンドポイントが見つかりません');
} catch (PDOException $e) {
    error_log('DB error: ' . $e->getMessage());
    fail(500, 'サーバ内部エラー（DB）');
}
