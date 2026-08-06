<?php
/**
 * ローカル開発用ルーター
 * 使い方: php -S localhost:8080 router.php
 * /api/* を api/index.php へ渡し、それ以外は静的ファイルとして配信する
 */
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/api(/.*)?$#', $uri, $m)) {
    $_SERVER['PATH_INFO'] = $m[1] ?? '/';
    require __DIR__ . '/api/index.php';
    exit;
}
return false; // 静的ファイルをそのまま配信
