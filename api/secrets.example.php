<?php
/**
 * このファイルを api/secrets.php にコピーして、自分のAPIキーを設定してください。
 * secrets.php は .gitignore で除外されており、リポジトリには含まれません。
 *
 *   cp api/secrets.example.php api/secrets.php
 */
return [
    // openrouteservice のAPIキー（https://openrouteservice.org/dev/#/signup で無料取得）
    // 未設定でもアプリは動作します（徒歩の道のり表示が直線距離表示になります）
    'ors_api_key' => '',
];
