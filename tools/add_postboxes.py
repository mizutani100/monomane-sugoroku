#!/usr/bin/env python3
"""OpenStreetMap の郵便ポスト(amenity=post_box)を data/spots.geojson へ追加する。

取得（別途実行）:
    curl -G 'https://overpass-api.de/api/interpreter' \\
      --data-urlencode 'data=[out:json][timeout:60];
        node["amenity"="post_box"](38.15,140.55,38.45,141.05);
        out body;' \\
      -o /tmp/postbox.json

変換方針:
  - category="post" / points=20 / difficulty=2
  - name: OSMのname属性 → 近くの住所(addr:*)から「◯◯のポスト」→ どちらも無ければ「郵便ポスト」
  - id: "post-" + OSMのnode id
  - source="OpenStreetMap contributors" / license="ODbL 1.0"
  - geometryはPoint、座標は[経度, 緯度]

間引き:
  - 既存の消火栓と同様、採用済みポストから100m未満の地点は捨てる（盤面がポストだらけになるのを防ぐ）

マージ:
  - data/spots.geojson の既存feature（バス停・消火栓・彫刻）は変更せず、postだけ入れ替える
  - metadata.featureCount と metadata.categoryCounts を実データに合わせて更新する

使い方:
    python3 tools/add_postboxes.py            # /tmp/postbox.json → data/spots.geojson
    python3 tools/add_postboxes.py IN OUT     # 入出力を明示
"""
import json
import math
import sys
from pathlib import Path

MIN_INTERVAL_M = 100.0        # 採用済みポストからこの距離未満なら間引く
POST_PROPS = dict(
    category="post",
    difficulty=2,
    points=20,
    source="OpenStreetMap contributors",
    license="ODbL 1.0",
)
# 近隣地名として使うaddrタグの優先順位
ADDR_KEYS = ["addr:quarter", "addr:neighbourhood", "addr:suburb", "addr:city", "addr:province"]


def haversine_m(a_lat, a_lon, b_lat, b_lon):
    R = 6371008.8
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dlat = math.radians(b_lat - a_lat)
    dlon = math.radians(b_lon - a_lon)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def post_name(tags):
    name = (tags.get("name") or "").strip()
    if name:
        return name
    for key in ADDR_KEYS:
        locality = (tags.get(key) or "").strip()
        if locality:
            return f"{locality}のポスト"
    return "郵便ポスト"


def build_posts(elements):
    posts = []
    for el in elements:
        if el.get("type") != "node":
            continue
        lat, lon = el.get("lat"), el.get("lon")
        if lat is None or lon is None:
            continue
        tags = el.get("tags", {}) or {}
        posts.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(float(lon), 7), round(float(lat), 7)]},
            "properties": {
                "id": f"post-{el['id']}",
                "name": post_name(tags),
                **POST_PROPS,
            },
        })
    return posts


def thin(posts, min_interval_m):
    """採用済みから min_interval_m 未満の地点を捨てる貪欲法。順序を安定させるためid順で処理。"""
    posts = sorted(posts, key=lambda f: f["properties"]["id"])
    kept = []
    for feat in posts:
        lon, lat = feat["geometry"]["coordinates"]
        if all(haversine_m(lat, lon, k[1], k[0]) >= min_interval_m
               for k in (f["geometry"]["coordinates"] for f in kept)):
            kept.append(feat)
    return kept


def main():
    in_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/postbox.json")
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("data/spots.geojson")

    overpass = json.loads(in_path.read_text(encoding="utf-8"))
    raw_posts = build_posts(overpass.get("elements", []))
    posts = thin(raw_posts, MIN_INTERVAL_M)
    print(f"postboxes: 取得 {len(raw_posts)} → 間引き後 {len(posts)}（最小間隔{int(MIN_INTERVAL_M)}m）")

    doc = json.loads(out_path.read_text(encoding="utf-8"))
    # 既存のpostだけ除去し（再実行の冪等性）、他カテゴリはそのまま維持
    features = [f for f in doc["features"] if f["properties"].get("category") != "post"]
    features.extend(posts)
    doc["features"] = features

    counts = {}
    for feat in features:
        cat = feat["properties"].get("category")
        counts[cat] = counts.get(cat, 0) + 1
    doc["metadata"]["featureCount"] = len(features)
    doc["metadata"]["categoryCounts"] = counts
    doc["metadata"].setdefault("processing", {})["postBoxes"] = {
        "input": len(raw_posts),
        "output": len(posts),
        "rule": f"OSM amenity=post_box を最小間隔{int(MIN_INTERVAL_M)}mで間引き",
    }

    out_path.write_text(
        json.dumps(doc, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"wrote {out_path}: featureCount={len(features)} categoryCounts={counts}")


if __name__ == "__main__":
    main()
