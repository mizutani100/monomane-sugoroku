#!/bin/bash
# Cloudflare版 APIテスト（test_api.sh のCloudflare Pages Functions + D1版）
#
# 前提: 別ターミナルで下記を起動しておく（migrations適用済みのローカルD1を使う）
#   npx wrangler d1 execute monomane-sugoroku --local --file=./migrations/0001_init.sql
#   npx wrangler pages dev . --d1 DB=monomane-sugoroku --port 8788
#
# 「絶対に変えてはいけない仕様」10項目を、番号付きで明示的に検証する。
set -e
BASE="${BASE:-http://localhost:8788/api}"
JAR="$(mktemp)"          # ネット投票者Cookie（1ブラウザ1票の検証用）
J() { python3 -c "import sys,json; d=json.load(sys.stdin); print(d$1)"; }
PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
ng()   { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
assert_http() { # $1=期待 $2=実際 $3=説明
  if [ "$1" = "$2" ]; then ok "$3 (HTTP $2)"; else ng "$3 期待HTTP$1 実際HTTP$2"; fi
}

echo "== 準備: 部屋作成（ホスト: みさと）"
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
EXPIRES=$(echo "$CREATE" | J "['expiresAt']")
echo "  部屋コード: $CODE"

echo "== 仕様8: 部屋コードは I/L/O/0/1 を除いた6桁英数"
python3 - "$CODE" << 'PY' && ok "コード形式 $CODE" || ng "コード形式が不正 $CODE"
import re, sys
c = sys.argv[1]
ok = bool(re.fullmatch(r'[A-HJ-NP-Z2-9]{6}', c)) and not (set(c) & set('ILO01'))
sys.exit(0 if ok else 1)
PY

echo "== 仕様7: 部屋は作成から約30日で自動削除（expiresAtが約30日先）"
python3 - "$EXPIRES" << 'PY' && ok "expiresAt=$EXPIRES" || ng "expiresが30日先でない $EXPIRES"
import sys, datetime
exp = datetime.datetime.strptime(sys.argv[1], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
days = (exp - datetime.datetime.now(datetime.timezone.utc)).total_seconds() / 86400
sys.exit(0 if 29.9 < days < 30.1 else 1)
PY

echo "== 仕様9: ニックネーム1〜10文字・1部屋最大8人"
E1=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/rooms/$CODE/join" -H "Content-Type: application/json" -d '{"nickname":""}')
assert_http 400 "$E1" "空ニックネームを拒否"
E2=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/rooms/$CODE/join" -H "Content-Type: application/json" -d '{"nickname":"あいうえおかきくけこさ"}')
assert_http 400 "$E2" "11文字ニックネームを拒否"

echo "== 2人目が参加（ゲスト: ゆき）"
JOIN=$(curl -s -X POST "$BASE/rooms/$CODE/join" -H "Content-Type: application/json" \
  -d '{"nickname": "ゆき", "icon": "📮"}')
GUEST_TOKEN=$(echo "$JOIN" | J "['playerToken']")
ok "参加OK"

echo "  最大人数チェック: 追加で6人参加（計8人）→ 9人目は409"
for i in 3 4 5 6 7 8; do
  curl -s -o /dev/null -X POST "$BASE/rooms/$CODE/join" -H "Content-Type: application/json" -d "{\"nickname\":\"p$i\"}"
done
FULL=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/rooms/$CODE/join" -H "Content-Type: application/json" -d '{"nickname":"over"}')
assert_http 409 "$FULL" "満室（9人目）を拒否"

echo "== ゲストが進行報告（2マス目へ）"
curl -s -o /dev/null -X POST "$BASE/rooms/$CODE/progress" -H "X-Player-Token: $GUEST_TOKEN" \
  -H "Content-Type: application/json" -d '{"position": 1}'
ok "進行報告OK"

echo "== テスト画像を生成してゲストがアップロード（spotIndex=1 消火栓30点）"
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
open('/tmp/test_photo_cf.png', 'wb').write(png)
PY
UPLOAD=$(curl -s -X POST "$BASE/rooms/$CODE/photos" -H "X-Player-Token: $GUEST_TOKEN" \
  -F "photo=@/tmp/test_photo_cf.png" -F "spotIndex=1")
PHOTO_ID=$(echo "$UPLOAD" | J "['photoId']")
ok "アップロードOK photoId=$PHOTO_ID"

echo "== 仕様1: 自分の写真は自分で採点できない（403）"
SELF=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/photos/$PHOTO_ID/ratings" \
  -H "X-Player-Token: $GUEST_TOKEN" -H "Content-Type: application/json" -d '{"stars":5}')
assert_http 403 "$SELF" "自分の写真の自己採点を拒否"

echo "== 仕様10: 星は1〜5の範囲外を拒否（400）"
S6=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/photos/$PHOTO_ID/ratings" \
  -H "X-Player-Token: $HOST_TOKEN" -H "Content-Type: application/json" -d '{"stars":6}')
assert_http 400 "$S6" "星6を拒否"
S0=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/photos/$PHOTO_ID/ratings" \
  -H "X-Player-Token: $HOST_TOKEN" -H "Content-Type: application/json" -d '{"stars":0}')
assert_http 400 "$S0" "星0を拒否"

echo "== 仕様2: 得点 = 基礎点 × 星平均(小数1位) + 電柱ボーナス(+5)"
echo "  ホストが★4＋電柱ボーナスで採点 → 30 × 4 + 5 = 125点になるはず"
curl -s -o /dev/null -X POST "$BASE/photos/$PHOTO_ID/ratings" -H "X-Player-Token: $HOST_TOKEN" \
  -H "Content-Type: application/json" -d '{"stars":4,"poleBonus":true}'
curl -s "$BASE/rooms/$CODE/state" -H "X-Player-Token: $GUEST_TOKEN" | python3 -c "
import sys, json
p = json.load(sys.stdin)['photos'][0]
print(f\"    写真: {p['spotName']} / 平均★{p['avgStars']} / {p['ratingCount']}人 / {p['points']}点 / 電柱{p['poleBonus']}\")
assert p['points'] == 125, f'期待125点 実際{p[\"points\"]}点'
assert p['poleBonus'] is True
" && ok "得点計算 125点" || ng "得点計算が不正"

echo "== 仕様6: 部屋の写真は部屋メンバーのみ（トークンなし403 / あり200）"
NOAUTH=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/photos/$PHOTO_ID")
assert_http 403 "$NOAUTH" "トークンなしの写真取得を拒否"
AUTH=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/photos/$PHOTO_ID" -H "X-Player-Token: $HOST_TOKEN")
assert_http 200 "$AUTH" "トークンありの写真取得を許可"
QAUTH=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/photos/$PHOTO_ID?t=$GUEST_TOKEN")
assert_http 200 "$QAUTH" "クエリtトークンでの写真取得を許可"

echo "== その他不正チェック（401 / 400）"
NST=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/rooms/$CODE/state")
assert_http 401 "$NST" "トークンなしstateを拒否"
POS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/rooms/$CODE/progress" \
  -H "X-Player-Token: $GUEST_TOKEN" -H "Content-Type: application/json" -d '{"position": 99}')
assert_http 400 "$POS" "範囲外positionを拒否"

echo "== 仕様4: ネット公開できるのは撮影した本人だけ（他人は403）"
PUB=$(curl -s -X POST "$BASE/photos/$PHOTO_ID/publish" -H "X-Player-Token: $GUEST_TOKEN" \
  -F "photo=@/tmp/test_photo_cf.png")
echo "$PUB" | J "['published']" >/dev/null && ok "本人がネット公開OK"
OTHER=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/photos/$PHOTO_ID/publish" \
  -H "X-Player-Token: $HOST_TOKEN" -F "photo=@/tmp/test_photo_cf.png")
assert_http 403 "$OTHER" "他人のネット公開を拒否"

echo "== ギャラリー（認証不要）と星投票"
GAL=$(curl -s "$BASE/gallery")
PUB_ID=$(echo "$GAL" | python3 -c "import sys,json; print(json.load(sys.stdin)['items'][0]['id'])")
echo "  公開ID: $PUB_ID"
curl -s -c "$JAR" -b "$JAR" -o /dev/null -X POST "$BASE/gallery/$PUB_ID/votes" \
  -H "Content-Type: application/json" -d '{"stars":5}'
# 同じCookieでもう一度投票しても票数は1のまま（1ブラウザ1票）
curl -s -c "$JAR" -b "$JAR" -o /dev/null -X POST "$BASE/gallery/$PUB_ID/votes" \
  -H "Content-Type: application/json" -d '{"stars":3}'
curl -s "$BASE/gallery" | python3 -c "
import sys, json
item = json.load(sys.stdin)['items'][0]
print(f\"    {item['spotName']} / ★{item['avgStars']} / {item['voteCount']}票\")
assert item['voteCount'] == 1, f'1ブラウザ1票のはずが{item[\"voteCount\"]}票'
" && ok "ネット投票（1ブラウザ1票）OK" || ng "ネット投票が不正"

echo "== 仕様10(ネット投票側): 星範囲外を拒否（400）"
GV6=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/gallery/$PUB_ID/votes" \
  -H "Content-Type: application/json" -d '{"stars":6}')
assert_http 400 "$GV6" "ギャラリー星6を拒否"

echo "== 仕様3: ネット投票は部屋の得点に一切影響しない"
curl -s "$BASE/rooms/$CODE/state" -H "X-Player-Token: $GUEST_TOKEN" | python3 -c "
import sys, json
p = json.load(sys.stdin)['photos'][0]
assert p['points'] == 125, f'ネット投票で部屋得点が変わった: {p[\"points\"]}'
assert p['publishedId'] is not None, '公開状態が反映されていない'
" && ok "部屋得点125点のまま・公開フラグあり" || ng "ネット投票が部屋得点に影響した"

echo "== 仕様5: 公開を取り下げると公開画像と投票が即座に削除される"
curl -s -o /dev/null -X DELETE "$BASE/photos/$PHOTO_ID/publish" -H "X-Player-Token: $GUEST_TOKEN"
curl -s "$BASE/gallery" | python3 -c "
import sys, json
items = json.load(sys.stdin)['items']
assert len(items) == 0, f'取り下げたのに残っている: {len(items)}件'
" && ok "取り下げでギャラリーから即消える" || ng "取り下げても残っている"
# 再公開すると票数が0にリセットされている（=投票がカスケード削除された証拠）
curl -s -o /dev/null -X POST "$BASE/photos/$PHOTO_ID/publish" -H "X-Player-Token: $GUEST_TOKEN" \
  -F "photo=@/tmp/test_photo_cf.png"
curl -s "$BASE/gallery" | python3 -c "
import sys, json
item = json.load(sys.stdin)['items'][0]
assert item['voteCount'] == 0, f'取り下げ前の投票が残っている: {item[\"voteCount\"]}票'
" && ok "取り下げで投票も削除されている（再公開後0票）" || ng "取り下げても投票が残っていた"
# 後片付けで再度取り下げ
curl -s -o /dev/null -X DELETE "$BASE/photos/$PHOTO_ID/publish" -H "X-Player-Token: $GUEST_TOKEN"

echo "== 片付け"
curl -s -o /dev/null -X DELETE "$BASE/rooms/$CODE/players/me" -H "X-Player-Token: $GUEST_TOKEN"
curl -s -o /dev/null -X POST "$BASE/rooms/$CODE/finish" -H "X-Player-Token: $HOST_TOKEN"
rm -f /tmp/test_photo_cf.png "$JAR"

echo ""
echo "======================================"
echo "  PASS: $PASS  /  FAIL: $FAIL"
echo "======================================"
[ "$FAIL" -eq 0 ] || { echo "テスト失敗あり"; exit 1; }
echo "== 全テスト完了（10項目の不変条件すべて検証）"
