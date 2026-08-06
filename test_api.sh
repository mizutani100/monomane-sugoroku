#!/bin/bash
# APIテスト（v5）
# 前提: 別ターミナルで `php -S localhost:8080 router.php` をwebapp_v4直下で起動しておく
set -e
BASE="http://localhost:8080/api"
J() { python3 -c "import sys,json; d=json.load(sys.stdin); print(d$1)"; }

echo "== 1. 部屋作成（ホスト: みさと）"
CREATE=$(curl -s -X POST "$BASE/rooms" -H "Content-Type: application/json" -d '{
  "nickname": "みさと", "icon": "🗿",
  "board": { "center": {"lat": 38.2601, "lon": 140.8824}, "radiusM": 1800,
    "spots": [
      {"id":"s1","category":"bus_stop","name":"テストバス停","lat":38.261,"lon":140.883,"points":20},
      {"id":"s2","category":"hydrant","name":"テスト消火栓","lat":38.263,"lon":140.885,"points":30},
      {"id":"s3","category":"statue","name":"テスト彫刻","lat":38.265,"lon":140.887,"points":50}
    ] } }')
CODE=$(echo "$CREATE" | J "['code']")
HOST_TOKEN=$(echo "$CREATE" | J "['playerToken']")
echo "部屋コード: $CODE"

echo "== 2. 2人目が参加（ゲスト: ゆき）"
JOIN=$(curl -s -X POST "$BASE/rooms/$CODE/join" -H "Content-Type: application/json" \
  -d '{"nickname": "ゆき", "icon": "📮"}')
GUEST_TOKEN=$(echo "$JOIN" | J "['playerToken']")
echo "参加OK"

echo "== 3. ゲストが進行報告（2マス目へ）"
curl -s -X POST "$BASE/rooms/$CODE/progress" -H "X-Player-Token: $GUEST_TOKEN" \
  -H "Content-Type: application/json" -d '{"position": 1}'; echo

echo "== 4. テスト画像を生成してゲストがアップロード"
python3 - << 'PY'
import zlib, struct
def chunk(t, d):
    c = t + d
    return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c))
w = h = 64
rows = []
for y in range(h):
    row = bytearray(b'\x00')
    for x in range(w):
        row += bytes([(x * 4) % 256, (y * 4) % 256, 160])
    rows.append(bytes(row))
raw = b''.join(rows)
png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(raw))
       + chunk(b'IEND', b''))
open('/tmp/test_photo.png', 'wb').write(png)
PY
UPLOAD=$(curl -s -X POST "$BASE/rooms/$CODE/photos" -H "X-Player-Token: $GUEST_TOKEN" \
  -F "photo=@/tmp/test_photo.png" -F "spotIndex=1")
echo "$UPLOAD"
PHOTO_ID=$(echo "$UPLOAD" | J "['photoId']")

echo "== 5. 自分の写真を自分で採点 → 403になるはず"
curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST "$BASE/photos/$PHOTO_ID/ratings" \
  -H "X-Player-Token: $GUEST_TOKEN" -H "Content-Type: application/json" -d '{"stars":5}'

echo "== 6. ホストが★4＋電柱ボーナスで採点"
curl -s -X POST "$BASE/photos/$PHOTO_ID/ratings" -H "X-Player-Token: $HOST_TOKEN" \
  -H "Content-Type: application/json" -d '{"stars":4,"poleBonus":true}'; echo

echo "== 7. state確認（消火栓30点 × ★4 + 5 = 125点になるはず）"
curl -s "$BASE/rooms/$CODE/state" -H "X-Player-Token: $GUEST_TOKEN" | python3 -c "
import sys, json
d = json.load(sys.stdin)
p = d['photos'][0]
print(f\"  写真: {p['spotName']} / 平均★{p['avgStars']} / {p['ratingCount']}人 / {p['points']}点 / 電柱{p['poleBonus']}\")
for pl in d['players']:
    print(f\"  {pl['nickname']}: {pl['score']}点\")
assert p['points'] == 125, f\"期待125点、実際{p['points']}点\"
print('  → 得点計算 OK')
"

echo "== 8. 写真配信（トークンなしは403、ありは200）"
curl -s -o /dev/null -w "  トークンなし: HTTP %{http_code}\n" "$BASE/photos/$PHOTO_ID"
curl -s -o /dev/null -w "  トークンあり: HTTP %{http_code}\n" "$BASE/photos/$PHOTO_ID" -H "X-Player-Token: $HOST_TOKEN"

echo "== 9. 不正チェック（401 / 400）"
curl -s -o /dev/null -w "  トークンなしstate: HTTP %{http_code}\n" "$BASE/rooms/$CODE/state"
curl -s -o /dev/null -w "  範囲外position: HTTP %{http_code}\n" -X POST "$BASE/rooms/$CODE/progress" \
  -H "X-Player-Token: $GUEST_TOKEN" -H "Content-Type: application/json" -d '{"position": 99}'
curl -s -o /dev/null -w "  星6での採点: HTTP %{http_code}\n" -X POST "$BASE/photos/$PHOTO_ID/ratings" \
  -H "X-Player-Token: $HOST_TOKEN" -H "Content-Type: application/json" -d '{"stars":6}'

echo "== 10. ネット公開（本人のみ）"
PUB=$(curl -s -X POST "$BASE/photos/$PHOTO_ID/publish" -H "X-Player-Token: $GUEST_TOKEN" \
  -F "photo=@/tmp/test_photo.png")
echo "  $PUB"
curl -s -o /dev/null -w "  他人が公開しようとする: HTTP %{http_code}（403のはず）\n" \
  -X POST "$BASE/photos/$PHOTO_ID/publish" -H "X-Player-Token: $HOST_TOKEN" \
  -F "photo=@/tmp/test_photo.png"

echo "== 11. ギャラリー（認証不要）と投票"
GAL=$(curl -s "$BASE/gallery")
PUB_ID=$(echo "$GAL" | python3 -c "import sys,json; print(json.load(sys.stdin)['items'][0]['id'])")
echo "  公開ID: $PUB_ID"
curl -s -X POST "$BASE/gallery/$PUB_ID/votes" -H "Content-Type: application/json" -d '{"stars":5}'; echo
curl -s "$BASE/gallery" | python3 -c "
import sys, json
item = json.load(sys.stdin)['items'][0]
print(f\"  {item['spotName']} / ★{item['avgStars']} / {item['voteCount']}票\")
assert item['voteCount'] == 1
print('  → ネット投票 OK')
"

echo "== 12. 部屋の得点はネット投票に影響されないことを確認"
curl -s "$BASE/rooms/$CODE/state" -H "X-Player-Token: $GUEST_TOKEN" | python3 -c "
import sys, json
d = json.load(sys.stdin)
p = d['photos'][0]
assert p['points'] == 125, f\"ネット投票で部屋得点が変わった: {p['points']}\"
assert p['publishedId'] is not None, '公開状態が反映されていない'
print('  → 部屋得点125点のまま・公開フラグあり OK')
"

echo "== 13. 公開の取り下げ"
curl -s -X DELETE "$BASE/photos/$PHOTO_ID/publish" -H "X-Player-Token: $GUEST_TOKEN"; echo
curl -s "$BASE/gallery" | python3 -c "
import sys, json
items = json.load(sys.stdin)['items']
assert len(items) == 0, f'取り下げたのに残っている: {len(items)}件'
print('  → 取り下げで即消える OK')
"

echo "== 14. 片付け"
curl -s -X DELETE "$BASE/rooms/$CODE/players/me" -H "X-Player-Token: $GUEST_TOKEN" > /dev/null
curl -s -X POST "$BASE/rooms/$CODE/finish" -H "X-Player-Token: $HOST_TOKEN" > /dev/null
rm -f /tmp/test_photo.png

echo "== 全テスト完了"
