(() => {
  "use strict";

  const CONFIG = window.MONOMANE_CONFIG;
  const CATEGORIES = Object.freeze({
    manhole:    { label: "マンホール", emoji: "🕳️", difficulty: 1, points: 10, pose: "安全な場所で体を丸くして、マンホールの円を表現する。車道では絶対に行わない。" },
    tree:       { label: "街路樹", emoji: "🌳", difficulty: 2, points: 20, pose: "枝ぶりを全身で再現する。風が吹いたら少し揺れてもよい。" },
    giant_tree: { label: "巨樹・巨木", emoji: "🌲", difficulty: 2, points: 20, pose: "長い樹齢の貫禄を顔で表現し、枝のように腕を広げる。" },
    post:       { label: "ポスト", emoji: "📮", difficulty: 2, points: 20, pose: "直立不動になり、口を投函口のように細く開ける。" },
    bus_stop:   { label: "バス停", emoji: "🚏", difficulty: 2, points: 20, pose: "標識と同じ角度で立ち、時刻表を待つ顔をする。通行を妨げない。" },
    vending:    { label: "自販機", emoji: "🥤", difficulty: 3, points: 30, pose: "直方体になりきり、両腕を商品サンプルの棚に見立てる。" },
    phone:      { label: "公衆電話", emoji: "📞", difficulty: 3, points: 30, pose: "直立して、受話器の存在感を肩と手で表現する。設備には触れなくてよい。" },
    hydrant:    { label: "消火栓", emoji: "🧯", difficulty: 3, points: 30, pose: "低く構え、消火栓の力強さを表現する。消防活動の邪魔にならない位置で撮る。" },
    statue:     { label: "銅像・彫刻", emoji: "🗿", difficulty: 5, points: 50, pose: "作品の姿勢を安全に再現し、数秒だけ静止する。台座には登らない。" }
  });

  const state = {
    allSpots: [],
    center: null,
    route: [],
    routeMarkers: [],
    routeLine: null,
    roadLine: null,
    roadLegs: null,
    centerMarker: null,
    centerCircle: null,
    currentLocationMarker: null,
    currentAccuracyCircle: null,
    position: -1,
    score: 0,
    rating: 0,
    currentPhotoUrl: null,
    album: [],
    targetReached: false,
    importedSources: 0,
    room: null,          // { code, status, board }
    me: null,            // { token, playerId, isHost }
    peers: [],           // 他メンバー
    peerMarkers: new Map(),
    pollTimer: null,
    activeTab: "map",
    currentPhotoFile: null,
    photos: [],
    gallery: [],
    judgeMode: "room",
    editor: null
  };

  const $ = (id) => document.getElementById(id);
  const map = L.map("map", { zoomControl: false }).setView(CONFIG.initialCenter, CONFIG.initialZoom);
  L.tileLayer(CONFIG.mapTiles, {
    maxZoom: 20,
    subdomains: CONFIG.mapSubdomains || "abc",
    attribution: CONFIG.mapAttribution,
    detectRetina: true
  }).addTo(map);
  L.control.zoom({ position: "topright" }).addTo(map);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[char]);
  }

  function toast(message, duration = 2600) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("show"), duration);
  }

  /** 効果音エンジン（Web Audio APIで合成。外部ファイル不要でオフラインでも鳴る） */
  const sfx = (() => {
    let ctx = null;
    let muted = localStorage.getItem("monomaneMuted") === "1";
    const ensure = () => {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { ctx = new AC(); } catch { return null; }
      }
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      return ctx;
    };
    function tone(freq, start, dur, { type = "sine", gain = 0.2, glideTo = null } = {}) {
      const ac = ensure();
      if (!ac || muted) return;
      const t0 = ac.currentTime + start;
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(ac.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    }
    function noise(start, dur, gain = 0.2) {
      const ac = ensure();
      if (!ac || muted) return;
      const t0 = ac.currentTime + start;
      const len = Math.max(1, Math.floor(ac.sampleRate * dur));
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ac.createBufferSource();
      src.buffer = buf;
      const g = ac.createGain();
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(g).connect(ac.destination);
      src.start(t0);
    }
    const chord = (freqs, start, dur, opts) => freqs.forEach((f) => tone(f, start, dur, opts));
    return {
      unlock: () => ensure(),
      isMuted: () => muted,
      toggleMute() {
        muted = !muted;
        localStorage.setItem("monomaneMuted", muted ? "1" : "0");
        if (!muted) { ensure(); this.pop(); }
        return muted;
      },
      dice() { for (let i = 0; i < 8; i++) tone(280 + Math.random() * 520, i * 0.055, 0.05, { type: "square", gain: 0.1 }); },
      land() { chord([523, 659, 784], 0, 0.45, { type: "triangle", gain: 0.22 }); noise(0, 0.12, 0.12); },
      arrive() { tone(880, 0, 0.12, { type: "sine", gain: 0.25, glideTo: 1320 }); tone(1320, 0.12, 0.28, { type: "sine", gain: 0.2 }); },
      shutter() { noise(0, 0.05, 0.4); tone(1400, 0.02, 0.05, { type: "square", gain: 0.16 }); },
      star() { tone(1046, 0, 0.09, { type: "triangle", gain: 0.2 }); tone(1568, 0.08, 0.14, { type: "triangle", gain: 0.18 }); },
      win() { [523, 659, 784, 1046, 1319].forEach((f, i) => tone(f, i * 0.12, 0.38, { type: "triangle", gain: 0.22 })); noise(0.05, 0.4, 0.14); },
      pop() { tone(600, 0, 0.08, { type: "sine", gain: 0.2, glideTo: 1000 }); },
      error() { tone(320, 0, 0.2, { type: "sawtooth", gain: 0.18, glideTo: 150 }); }
    };
  })();

  function showDialog(dialog) {
    if (!dialog.open) dialog.showModal();
  }

  function closeDialog(dialog) {
    if (dialog.open) dialog.close();
  }

  function haversineMeters(a, b) {
    const toRad = (deg) => deg * Math.PI / 180;
    const R = 6371008.8;
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function formatDistance(meters) {
    if (!Number.isFinite(meters)) return "距離不明";
    return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
  }

  function normalizeFeature(feature, index, fallbackSource = "追加GeoJSON") {
    if (!feature || feature.type !== "Feature" || feature.geometry?.type !== "Point") return null;
    const coords = feature.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

    const p = feature.properties || {};
    const category = String(p.category || "");
    if (!CATEGORIES[category]) return null;
    const cat = CATEGORIES[category];

    return {
      id: String(p.id || `${category}-${index}-${lat.toFixed(6)}-${lon.toFixed(6)}`),
      category,
      name: String(p.name || cat.label),
      difficulty: Number.isFinite(Number(p.difficulty)) ? Number(p.difficulty) : cat.difficulty,
      points: Number.isFinite(Number(p.points)) ? Number(p.points) : cat.points,
      source: String(p.source || fallbackSource),
      license: String(p.license || "ライセンス要確認"),
      lat,
      lon
    };
  }

  function parseGeoJSON(data, fallbackSource) {
    const features = data?.type === "FeatureCollection" ? data.features : (data?.type === "Feature" ? [data] : []);
    if (!Array.isArray(features)) throw new Error("FeatureCollectionではありません。");
    if (features.length > CONFIG.maxImportFeatures) throw new Error(`件数が多すぎます（上限 ${CONFIG.maxImportFeatures.toLocaleString()} 件）。`);
    return features.map((f, i) => normalizeFeature(f, i, fallbackSource)).filter(Boolean);
  }

  async function loadDefaultData() {
    try {
      const response = await fetch(CONFIG.dataUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state.allSpots = parseGeoJSON(data, "同梱データ");
      updateDataSummary();
    } catch (error) {
      console.error(error);
      $("data-summary").textContent = "データ読込失敗：GeoJSONを追加してください";
      toast("同梱GeoJSONを読み込めませんでした。Apache経由で開いているか確認してください。", 5000);
    }
  }

  function updateDataSummary() {
    const categories = new Set(state.allSpots.map((s) => s.category));
    const summary = `${state.allSpots.length.toLocaleString()}地点・${categories.size}カテゴリ読込済み`;
    $("data-summary").textContent = summary;
    if ($("data-detail")) {
      const counts = {};
      state.allSpots.forEach((spot) => { counts[spot.category] = (counts[spot.category] || 0) + 1; });
      $("data-detail").textContent = summary + "　" + Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([key, value]) => `${CATEGORIES[key]?.emoji || ""}${value.toLocaleString()}`)
        .join("・");
    }
    updateCandidateCount();
    renderSources();
  }

  function updateCandidateCount() {
    if (!state.center) {
      $("candidate-chip").textContent = "候補 0件";
      $("btn-generate").disabled = true;
      return;
    }
    const radius = Number($("radius-range").value) * 1000;
    const count = state.allSpots.filter((s) => haversineMeters(state.center, [s.lat, s.lon]) <= radius).length;
    $("candidate-chip").textContent = `候補 ${count}件`;
    $("btn-generate").disabled = count < CONFIG.minRouteSpots;
    $("setup-status").textContent = count < CONFIG.minRouteSpots
      ? `候補が不足しています。半径を広げるかGeoJSONを追加してください（最低${CONFIG.minRouteSpots}件）。`
      : "盤面を生成できます。中心マーカーは地図タップで変更できます。";
  }

  function setCenter(latlng, pan = false) {
    state.center = [latlng.lat, latlng.lng];
    if (state.centerMarker) state.centerMarker.remove();
    if (state.centerCircle) state.centerCircle.remove();

    const icon = L.divIcon({ className: "", html: '<div class="center-marker">🎯</div>', iconSize: [32, 32], iconAnchor: [16, 28] });
    state.centerMarker = L.marker(latlng, { icon, zIndexOffset: 1200 }).addTo(map).bindTooltip("盤面の中心");
    drawCenterCircle();
    if (pan) map.setView(latlng, Math.max(map.getZoom(), 15));
    updateCandidateCount();
  }

  function drawCenterCircle() {
    if (!state.center) return;
    if (state.centerCircle) state.centerCircle.remove();
    state.centerCircle = L.circle(state.center, {
      radius: Number($("radius-range").value) * 1000,
      color: "#235b47",
      weight: 2,
      fillColor: "#2f7b5f",
      fillOpacity: .08,
      dashArray: "6 7"
    }).addTo(map);
  }

  /** 中心円の全体が、下部パネルに隠れない領域に収まるよう地図を調整する */
  function fitCenterCircle() {
    if (!state.centerCircle) return;
    if ($("setup-panel").classList.contains("hidden")) return;
    const bounds = state.centerCircle.getBounds();
    if (!bounds.isValid()) return;
    const panel = $("setup-panel");
    const panelHeight = panel.offsetHeight || 0;
    map.fitBounds(bounds, {
      paddingTopLeft: [24, 24],
      paddingBottomRight: [24, panelHeight + 24], // パネルの高さぶんを下に確保
      animate: true
    });
  }

  function currentPosition(options = {}) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("このブラウザは位置情報に対応していません。"));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, (error) => {
        const messages = {
          1: "位置情報の利用が許可されていません。ブラウザ設定を確認してください。",
          2: "現在地を取得できませんでした。屋外で再試行してください。",
          3: "位置情報の取得がタイムアウトしました。"
        };
        reject(new Error(messages[error.code] || "現在地を取得できませんでした。"));
      }, { enableHighAccuracy: true, timeout: 12000, maximumAge: options.maximumAge ?? 3000 });
    });
  }

  function showCurrentPosition(position, pan = true) {
    const latlng = [position.coords.latitude, position.coords.longitude];
    if (state.currentLocationMarker) state.currentLocationMarker.remove();
    if (state.currentAccuracyCircle) state.currentAccuracyCircle.remove();
    const icon = L.divIcon({ className: "", html: '<div class="location-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
    state.currentLocationMarker = L.marker(latlng, { icon, zIndexOffset: 1500 }).addTo(map).bindTooltip("現在地");
    state.currentAccuracyCircle = L.circle(latlng, {
      radius: position.coords.accuracy,
      color: "#2673d9",
      weight: 1,
      fillOpacity: .08
    }).addTo(map);
    if (pan) map.setView(latlng, Math.max(map.getZoom(), 16));
    return latlng;
  }

  function shuffle(array) {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function normalizeSpotName(name) {
    return String(name || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  }

  function deduplicateBusStopNames(candidates) {
    const seen = new Set();
    return candidates.filter((spot) => {
      if (spot.category !== "bus_stop") return true;
      const key = normalizeSpotName(spot.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function targetStepMeters(radiusMeters) {
    const raw = radiusMeters * (CONFIG.targetStepRadiusRatio || 0.24);
    return Math.round(Math.min(
      CONFIG.maxTargetStepMeters || 900,
      Math.max(CONFIG.minTargetStepMeters || 180, raw)
    ));
  }

  function buildDistanceAwareRoute(candidates, count, origin, radiusMeters) {
    const remaining = shuffle(deduplicateBusStopNames(candidates));
    const selected = [];
    const categoryUsage = new Map();
    const usedBusStopNames = new Set();
    const target = targetStepMeters(radiusMeters);
    let cursor = origin;
    let previousCategory = null;

    while (selected.length < count && remaining.length) {
      let bestIndex = -1;
      let bestScore = Infinity;

      remaining.forEach((spot, index) => {
        if (spot.category === "bus_stop" && usedBusStopNames.has(normalizeSpotName(spot.name))) return;

        const distance = haversineMeters(cursor, [spot.lat, spot.lon]);
        let score = Math.abs(distance - target) / target;

        // 近すぎる地点を強く避ける。候補不足時は完全除外せず、最善の地点を採る。
        const hardClose = target * 0.55;
        if (distance < hardClose) {
          score += 4 + ((hardClose - distance) / target) * 6;
        }

        // 遠すぎる地点も抑えるが、近すぎる地点よりは許容する。
        const softFar = target * 1.65;
        if (distance > softFar) {
          score += ((distance - softFar) / target) * 1.5;
        }

        const usedCount = categoryUsage.get(spot.category) || 0;
        score += usedCount * (CONFIG.categoryUsagePenalty || 0.58);
        if (spot.category === previousCategory) {
          score += CONFIG.consecutiveCategoryPenalty || 0.35;
        }

        // 過去のマスと重なって見えるループを抑える。
        if (selected.length) {
          const nearestPrevious = Math.min(...selected.map((chosen) => (
            haversineMeters([spot.lat, spot.lon], [chosen.lat, chosen.lon])
          )));
          const revisitLimit = target * 0.42;
          if (nearestPrevious < revisitLimit) {
            score += 2.5 + ((revisitLimit - nearestPrevious) / target) * 4;
          }
        }

        // 同点時に毎回同じ盤面にならない程度の小さな揺らぎ。
        score += Math.random() * 0.08;

        if (score < bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      });

      if (bestIndex < 0) break;
      const [chosen] = remaining.splice(bestIndex, 1);
      selected.push(chosen);
      categoryUsage.set(chosen.category, (categoryUsage.get(chosen.category) || 0) + 1);
      if (chosen.category === "bus_stop") usedBusStopNames.add(normalizeSpotName(chosen.name));
      previousCategory = chosen.category;
      cursor = [chosen.lat, chosen.lon];
    }

    return selected;
  }

  function routeLegDistances(route) {
    if (!state.center || !route.length) return [];
    const distances = [];
    let cursor = state.center;
    route.forEach((spot) => {
      const next = [spot.lat, spot.lon];
      distances.push(haversineMeters(cursor, next));
      cursor = next;
    });
    return distances;
  }

  function routeLengthMeters(route) {
    let total = state.center && route.length ? haversineMeters(state.center, [route[0].lat, route[0].lon]) : 0;
    for (let i = 1; i < route.length; i += 1) {
      total += haversineMeters([route[i - 1].lat, route[i - 1].lon], [route[i].lat, route[i].lon]);
    }
    return total;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return "時間不明";
    const minutes = Math.max(1, Math.round(seconds / 60));
    return minutes < 60 ? `${minutes}分` : `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
  }

  async function fetchRoadRoute(route) {
    if (!CONFIG.routeProxyUrl || !state.center || !route.length) return null;
    const coordinates = [[state.center[1], state.center[0]], ...route.map((s) => [s.lon, s.lat])];
    const response = await fetch(CONFIG.routeProxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordinates })
    });
    if (!response.ok) throw new Error(`経路API HTTP ${response.status}`);
    const data = await response.json();
    const feature = data?.features?.[0];
    const geometry = feature?.geometry;
    const segments = feature?.properties?.segments;
    if (geometry?.type !== "LineString" || !Array.isArray(segments) || !segments.length) {
      throw new Error("経路APIの応答形式が想定と異なります。");
    }
    return {
      latlngs: geometry.coordinates.map(([lon, lat]) => [lat, lon]),
      legs: segments.map((s) => ({ meters: s.distance, seconds: s.duration }))
    };
  }

  async function enhanceWithRoadRoute() {
    const route = state.route;
    if (!route.length) return;
    try {
      const road = await fetchRoadRoute(route);
      if (!road || state.route !== route) return; // 盤面が作り直されていたら破棄
      state.roadLegs = road.legs;
      if (state.roadLine) state.roadLine.remove();
      state.roadLine = L.layerGroup([
        L.polyline(road.latlngs, { color: "#ffffff", weight: 9, opacity: .95 }),
        L.polyline(road.latlngs, { color: "#1a73e8", weight: 5, opacity: .95, lineCap: "round", lineJoin: "round" })
      ]).addTo(map);
      if (state.routeLine) state.routeLine.remove();
      if (state.position < 0) {
        const meters = road.legs.map((l) => l.meters);
        const total = meters.reduce((sum, v) => sum + v, 0);
        const totalSeconds = road.legs.reduce((sum, l) => sum + l.seconds, 0);
        const average = total / meters.length;
        $("game-status").textContent =
          `${route.length}マス、徒歩の道のり約${formatDistance(total)}（約${formatDuration(totalSeconds)}）。` +
          `マス間の道のり 平均${formatDistance(average)}（最短${formatDistance(Math.min(...meters))}・最長${formatDistance(Math.max(...meters))}）。`;
      }
    } catch (error) {
      console.warn("経路APIに接続できませんでした。直線距離表示を継続します。", error);
      if (state.position < 0) $("game-status").textContent += "（直線距離表示。道のり表示にはORSキーの設定が必要です）";
    }
  }

  function clearRouteLayers() {
    state.routeMarkers.forEach((marker) => marker.remove());
    state.routeMarkers = [];
    if (state.routeLine) state.routeLine.remove();
    state.routeLine = null;
    if (state.roadLine) state.roadLine.remove();
    state.roadLine = null;
    state.roadLegs = null;
  }

  function renderRoute() {
    clearRouteLayers();
    const latlngs = state.route.map((s) => [s.lat, s.lon]);
    if (state.center) latlngs.unshift(state.center);
    // 白フチ＋青線の2本重ねで、地図の上でも視認しやすくする
    state.routeLine = L.layerGroup([
      L.polyline(latlngs, { color: "#ffffff", weight: 8, opacity: .9 }),
      L.polyline(latlngs, { color: "#8a9199", weight: 4, opacity: .9, dashArray: "1 9", lineCap: "round" })
    ]).addTo(map);

    state.route.forEach((spot, index) => {
      const cat = CATEGORIES[spot.category];
      const html = `<div class="emoji-marker" id="route-marker-${index}">${cat.emoji}<span class="route-number">${index + 1}</span></div>`;
      const icon = L.divIcon({ className: "", html, iconSize: [30, 30], iconAnchor: [15, 15] });
      const tooltip = `${index + 1}. ${escapeHtml(spot.name)}（${cat.label}・${spot.points}点）`;
      const marker = L.marker([spot.lat, spot.lon], { icon }).addTo(map).bindTooltip(tooltip);
      state.routeMarkers.push(marker);
    });

    const bounds = L.latLngBounds(latlngs);
    if (bounds.isValid()) map.fitBounds(bounds.pad(.18), { maxZoom: 16 });
  }

  function generateRoute() {
    if (!state.center) return;
    const radius = Number($("radius-range").value) * 1000;
    const requested = Number($("route-count").value);
    const candidates = state.allSpots
      .map((spot) => ({ ...spot, centerDistance: haversineMeters(state.center, [spot.lat, spot.lon]) }))
      .filter((spot) => spot.centerDistance <= radius)
      .sort((a, b) => a.centerDistance - b.centerDistance);

    if (candidates.length < CONFIG.minRouteSpots) {
      toast(`候補が${candidates.length}件しかありません。半径を広げてください。`);
      return;
    }

    const uniqueCandidates = deduplicateBusStopNames(candidates);
    const actualCount = Math.min(requested, uniqueCandidates.length);

    // 半径内の全候補を使う。中心に近い地点だけへ切り詰めない。
    state.route = buildDistanceAwareRoute(
      uniqueCandidates,
      actualCount,
      state.center,
      radius
    );
    resetGameState(false);
    renderRoute();

    $("setup-panel").classList.add("hidden");
    $("game-panel").classList.remove("hidden");
    $("progress-chip").textContent = `0 / ${state.route.length}`;
    const legDistances = routeLegDistances(state.route);
    const averageLeg = legDistances.length
      ? legDistances.reduce((sum, value) => sum + value, 0) / legDistances.length
      : 0;
    const shortestLeg = legDistances.length ? Math.min(...legDistances) : 0;
    const longestLeg = legDistances.length ? Math.max(...legDistances) : 0;
    const targetLeg = targetStepMeters(radius);
    $("game-status").textContent =
      `${state.route.length}マス、盤面距離約${formatDistance(routeLengthMeters(state.route))}。` +
      `目標マス間 約${formatDistance(targetLeg)}／実平均 ${formatDistance(averageLeg)}` +
      `（最短${formatDistance(shortestLeg)}・最長${formatDistance(longestLeg)}）。`;
    $("btn-demo-arrival").classList.toggle("hidden", !CONFIG.allowDemoArrival);
    $("btn-dice").disabled = false;
    $("btn-arrival").disabled = true;
    enhanceWithRoadRoute();
    if (!state.room) createRoom();
  }

  function resetGameState(resetRoute = true) {
    state.position = -1;
    state.score = 0;
    state.rating = 0;
    state.targetReached = false;
    state.album.forEach((item) => item.photoUrl && URL.revokeObjectURL(item.photoUrl));
    state.album = [];
    if (state.currentPhotoUrl) URL.revokeObjectURL(state.currentPhotoUrl);
    state.currentPhotoUrl = null;
    $("score-chip").textContent = "0点";
    $("target-card").classList.add("hidden");
    if (resetRoute) {
      state.route = [];
      clearRouteLayers();
    }
  }

  function markRouteProgress() {
    state.route.forEach((_, index) => {
      const el = document.querySelector(`#route-marker-${index}`);
      if (!el) return;
      el.classList.toggle("done", index < state.position);
      el.classList.toggle("current", index === state.position);
    });
  }

  function playDiceAnimation(finalRoll) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "dice-overlay";
      const face = document.createElement("div");
      face.className = "dice-face";
      overlay.append(face);
      document.body.append(overlay);
      const started = performance.now();
      const duration = 1200;
      const tick = () => {
        const elapsed = performance.now() - started;
        if (elapsed >= duration) {
          face.textContent = String(finalRoll);
          face.classList.add("settled");
          setTimeout(() => { overlay.remove(); resolve(); }, 700);
          return;
        }
        face.textContent = String(Math.floor(Math.random() * 6) + 1);
        const progress = elapsed / duration;
        setTimeout(tick, 60 + progress * progress * 260);
      };
      tick();
    });
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /** 通過するマスを一瞬だけ強調（スケールアップ→戻す） */
  function hopMarker(index) {
    const el = document.querySelector(`#route-marker-${index}`);
    if (!el) return;
    el.classList.remove("hop");
    void el.offsetWidth; // アニメーションを確実に再生するためリフローを挟む
    el.classList.add("hop");
    setTimeout(() => el.classList.remove("hop"), 340);
  }

  /** コマ（現在地マーカー）をルート上に1マスずつ進める */
  async function animatePieceTo(from, to, roll) {
    for (let i = from + 1; i <= to; i += 1) {
      state.position = i;
      markRouteProgress();
      hopMarker(i);
      const spot = state.route[i];
      map.panTo([spot.lat, spot.lon], { animate: true, duration: 0.3 });
      const remaining = to - i;
      $("game-status").textContent = remaining > 0
        ? `🎲 ${roll}！ コマが進んでいます…あと${remaining}マス`
        : `🎲 ${roll}！ ${to + 1}マス目に到着！`;
      await sleep(350);
    }
  }

  async function rollDice() {
    if (!state.route.length || rollDice.rolling) return;
    rollDice.rolling = true;
    $("btn-dice").disabled = true;
    $("btn-arrival").disabled = true; // アニメーション中の二重操作を防ぐ
    const roll = Math.floor(Math.random() * 6) + 1;
    sfx.dice();
    await playDiceAnimation(roll);

    const from = state.position;
    // ゴールを超える出目はゴールで止まる（既存仕様）
    const to = Math.min(state.position + roll, state.route.length - 1);
    state.targetReached = false;

    if (prefersReducedMotion() || to <= from) {
      // 動きを控える設定、または移動なしのときは即座に反映する
      state.position = to;
      markRouteProgress();
    } else {
      await animatePieceTo(from, to, roll);
      await sleep(400); // 最後のマスに着いたら少し間を置いてから目的地カードを出す
    }
    state.position = to;
    markRouteProgress();
    sfx.land();

    const target = state.route[state.position];
    const cat = CATEGORIES[target.category];
    $("target-card").classList.remove("hidden");
    $("target-emoji").textContent = cat.emoji;
    $("target-name").textContent = `${state.position + 1}. ${target.name}`;
    $("target-distance").textContent = "現地に移動して到着判定をしてください。";
    if (state.roadLegs) {
      let legMeters = 0;
      let legSeconds = 0;
      for (let i = from + 1; i <= state.position; i += 1) {
        const leg = state.roadLegs[i];
        if (leg) { legMeters += leg.meters; legSeconds += leg.seconds; }
      }
      if (legMeters > 0) {
        $("target-distance").textContent =
          `ここから徒歩 約${formatDistance(legMeters)}・約${formatDuration(legSeconds)}の道のり。到着したら判定してください。`;
      }
    }
    $("game-status").textContent = `🎲 ${roll}！ ${from < 0 ? "スタート" : `${from + 1}マス目`}から${state.position + 1}マス目へ。`;
    $("progress-chip").textContent = `${state.position + 1} / ${state.route.length}`;
    $("btn-arrival").disabled = false;
    map.setView([target.lat, target.lon], Math.max(map.getZoom(), 17));
    reportProgress();
    rollDice.rolling = false;
  }

  async function checkArrival() {
    const target = state.route[state.position];
    if (!target) return;
    $("btn-arrival").disabled = true;
    $("game-status").textContent = "現在地を高精度で確認中…";
    try {
      const position = await currentPosition({ maximumAge: 0 });
      const here = showCurrentPosition(position, false);
      const distance = haversineMeters(here, [target.lat, target.lon]);
      const accuracy = Math.round(position.coords.accuracy);
      $("target-distance").textContent = `対象まで ${formatDistance(distance)} ／ GPS精度 ±${accuracy}m`;

      if (position.coords.accuracy > CONFIG.maxGpsAccuracyMeters) {
        $("game-status").textContent = `GPS精度が±${accuracy}mのため判定保留。空が見える場所で再試行してください。`;
        $("btn-arrival").disabled = false;
        return;
      }
      if (distance <= CONFIG.arrivalRadiusMeters) {
        state.targetReached = true;
        openMission();
      } else {
        $("game-status").textContent = `まだ約${formatDistance(distance)}離れています。半径${CONFIG.arrivalRadiusMeters}m以内へ移動してください。`;
        $("btn-arrival").disabled = false;
      }
    } catch (error) {
      $("game-status").textContent = error.message;
      $("btn-arrival").disabled = false;
      toast(error.message, 4500);
    }
  }

  function demoArrival() {
    if (!CONFIG.allowDemoArrival || state.position < 0) return;
    state.targetReached = true;
    openMission();
  }

  function openMission() {
    const spot = state.route[state.position];
    const cat = CATEGORIES[spot.category];
    state.rating = 0;
    if (state.currentPhotoUrl) URL.revokeObjectURL(state.currentPhotoUrl);
    state.currentPhotoUrl = null;
    $("photo-input").value = "";
    $("photo-preview").src = "";
    $("photo-preview").classList.add("hidden");
    $("submit-section").classList.add("hidden");
    $("btn-submit-photo").disabled = false;
    $("btn-submit-photo").textContent = "みんなに送る";

    $("mission-emoji").textContent = cat.emoji;
    $("mission-kicker").textContent = `マス ${state.position + 1} ／ 基礎点 ${spot.points}`;
    $("mission-name").textContent = spot.name;
    $("mission-meta").textContent = `${cat.label}・難度★${spot.difficulty}｜${spot.source}｜${spot.license}`;
    $("mission-pose").textContent = `📸 ${cat.pose}`;
    sfx.arrive();
    showDialog($("mission-dialog"));
  }

  /** 端末側で長辺1000pxへ縮小してからアップロードする（D1のBLOB保存に収まるよう1枚150〜250KB想定） */
  async function shrinkImage(file, maxEdge = 1000, quality = 0.75) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  }

  async function submitPhoto() {
    if (!state.currentPhotoFile) return;
    if (!state.room || !state.me) {
      toast("部屋に参加していないため送信できません。");
      return;
    }
    const button = $("btn-submit-photo");
    button.disabled = true;
    button.textContent = "送信中…";
    try {
      const blob = await shrinkImage(state.currentPhotoFile);
      const form = new FormData();
      form.append("photo", blob, "photo.jpg");
      form.append("spotIndex", String(state.position));
      const response = await fetch(`api/rooms/${state.room.code}/photos`, {
        method: "POST",
        headers: { "X-Player-Token": state.me.token },
        body: form
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

      const destination = document.querySelector('input[name="destination"]:checked')?.value || "room";
      const photoId = data.photoId;
      const photoFile = state.currentPhotoFile;
      state.currentPhotoFile = null;
      state.targetReached = false;
      closeDialog($("mission-dialog"));
      if (destination === "net") {
        openPrivacyEditor(photoId, photoFile);
      }

      const marker = document.querySelector(`#route-marker-${state.position}`);
      if (marker) marker.classList.add("done");

      if (state.position >= state.route.length - 1) {
        $("game-status").textContent = "ゴール！ みんなの採点を待ちましょう。";
        pollState().then(showResult);
      } else {
        $("game-status").textContent = "送信しました。みんなの採点を待ちながら次のサイコロへ。";
        $("btn-arrival").disabled = true;
        $("btn-dice").disabled = false;
      }
      pollState();
      sfx.shutter();
      toast("写真を送りました。点数はみんながつけます。");
    } catch (error) {
      toast(`送信できません：${error.message}`, 5000);
      button.disabled = false;
      button.textContent = "みんなに送る";
    }
  }

  function showResult() {
    const name = profileNickname();
    const mine = state.photos.filter((photo) => photo.playerId === state.me?.playerId);
    $("result-summary").textContent = `${name}：総合 ${state.score}点 ／ 撮影 ${mine.length}枚`;

    // 二部門表彰（部屋全体から）
    const rated = state.photos.filter((photo) => photo.ratingCount > 0);
    const awards = $("awards");
    awards.replaceChildren();
    if (rated.length >= 2) {
      const best = rated.reduce((a, b) => (b.avgStars > a.avgStars ? b : a));
      const worst = rated.reduce((a, b) => (b.avgStars < a.avgStars ? b : a));
      [["🏆 そっくり大賞", best], ["🤔 なにこれ大賞", worst]].forEach(([title, photo]) => {
        const box = document.createElement("div");
        box.className = "award";
        box.innerHTML =
          `<p class="award-title">${title}</p>` +
          `<img class="award-image" src="${photo.url}?t=${encodeURIComponent(state.me?.token || "")}" alt="">` +
          `<p class="award-caption">${escapeHtml(photo.nickname)}／${escapeHtml(photo.spotName)}　★${photo.avgStars}</p>`;
        awards.append(box);
      });
    }

    const album = $("album");
    album.replaceChildren();
    mine.forEach((photo) => {
      const figure = document.createElement("figure");
      const image = document.createElement("img");
      image.src = `${photo.url}?t=${encodeURIComponent(state.me?.token || "")}`;
      image.alt = photo.spotName;
      const caption = document.createElement("figcaption");
      const cat = CATEGORIES[photo.category];
      caption.textContent = `${cat ? cat.emoji : "📷"} ${photo.spotName}　${
        photo.ratingCount ? `★${photo.avgStars}　${photo.points}点` : "採点待ち"}`;
      figure.append(image, caption);
      album.append(figure);
    });
    sfx.win();
    showDialog($("result-dialog"));
  }

  async function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  function drawCover(ctx, img, x, y, width, height) {
    const scale = Math.max(width / img.width, height / img.height);
    const sw = width / scale;
    const sh = height / scale;
    const sx = (img.width - sw) / 2;
    const sy = (img.height - sh) / 2;
    ctx.drawImage(img, sx, sy, sw, sh, x, y, width, height);
  }

  async function downloadAlbum() {
    const items = state.photos
      .filter((photo) => photo.playerId === state.me?.playerId)
      .map((photo) => ({
        photoUrl: `${photo.url}?t=${encodeURIComponent(state.me?.token || "")}`,
        spot: { name: photo.spotName, category: photo.category },
        rating: photo.avgStars ?? 0,
        gained: photo.points
      }));
    state.album = items;
    if (!state.album.length) return;
    const cols = 2;
    const cardW = 500;
    const cardH = 400;
    const gap = 24;
    const margin = 44;
    const headerH = 170;
    const rows = Math.ceil(state.album.length / cols);
    const canvas = document.createElement("canvas");
    canvas.width = margin * 2 + cols * cardW + gap;
    canvas.height = headerH + margin + rows * cardH + Math.max(0, rows - 1) * gap + margin;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f4f0e6";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#235b47";
    ctx.fillRect(0, 0, canvas.width, headerH);
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 44px sans-serif";
    ctx.fillText("街のモノまねすごろく", margin, 66);
    ctx.font = "700 30px sans-serif";
    const name = $("player-name").value.trim() || "挑戦者";
    ctx.fillText(`${name}　総合 ${state.score}点`, margin, 118);
    ctx.font = "18px sans-serif";
    ctx.fillText(new Date().toLocaleDateString("ja-JP"), canvas.width - 200, 118);

    const images = await Promise.all(state.album.map((item) => loadImage(item.photoUrl)));
    state.album.forEach((item, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = margin + col * (cardW + gap);
      const y = headerH + margin + row * (cardH + gap);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x, y, cardW, cardH);
      drawCover(ctx, images[index], x, y, cardW, 310);
      ctx.fillStyle = "#17201d";
      ctx.font = "700 20px sans-serif";
      const title = `${CATEGORIES[item.spot.category].emoji} ${item.spot.name}`.slice(0, 28);
      ctx.fillText(title, x + 16, y + 344);
      ctx.fillStyle = "#65716c";
      ctx.font = "16px sans-serif";
      ctx.fillText(`★${item.rating}　+${item.gained}点`, x + 16, y + 376);
    });

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return false;
    const filename = `monomane-sugoroku-${new Date().toISOString().slice(0, 10)}.png`;
    return saveImage(blob, filename);
  }

  /**
   * 画像を保存する。スマホでは共有シート経由（「画像を保存」でカメラロール＝写真アプリへ入る）を優先し、
   * 非対応環境（PCなど）ではファイルダウンロードにフォールバックする。
   * 戻り値: 保存/共有が完了すれば true、ユーザーがキャンセルすれば false。
   */
  async function saveImage(blob, filename) {
    const file = new File([blob], filename, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "モノまね旅のしおり" });
        return true;
      } catch (error) {
        if (error && error.name === "AbortError") return false; // ユーザーがキャンセルした
        // 共有に失敗した場合は下のダウンロードにフォールバックする
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  function renderSources() {
    const sources = new Map();
    state.allSpots.forEach((spot) => {
      const key = `${spot.source}\u0000${spot.license}`;
      if (!sources.has(key)) sources.set(key, { source: spot.source, license: spot.license, count: 0 });
      sources.get(key).count += 1;
    });
    const list = $("source-list");
    list.replaceChildren();
    [...sources.values()].sort((a, b) => b.count - a.count).forEach((entry) => {
      const item = document.createElement("div");
      item.className = "source-item";
      const strong = document.createElement("strong");
      strong.textContent = `${entry.source}（${entry.count}件）`;
      const span = document.createElement("span");
      span.textContent = entry.license;
      item.append(strong, span);
      list.append(item);
    });
    if (!sources.size) list.textContent = "データ未読込";
  }

  async function importGeoJSON(file) {
    if (!file) return;
    if (file.size > CONFIG.maxImportBytes) {
      toast(`ファイルが大きすぎます（上限 ${Math.round(CONFIG.maxImportBytes / 1024 / 1024)}MB）。`, 4500);
      return;
    }
    try {
      const data = JSON.parse(await file.text());
      const spots = parseGeoJSON(data, file.name);
      if (!spots.length) throw new Error("対応カテゴリのPoint地物がありません。category属性を確認してください。");
      state.allSpots.push(...spots);
      state.importedSources += 1;
      updateDataSummary();
      toast(`${spots.length.toLocaleString()}地点を追加しました。`);
    } catch (error) {
      console.error(error);
      toast(`GeoJSONを追加できません：${error.message}`, 5000);
    } finally {
      $("geojson-input").value = "";
    }
  }

  function resetToSetup() {
    closeDialog($("result-dialog"));
    closeDialog($("mission-dialog"));
    resetGameState(true);
    $("game-panel").classList.add("hidden");
    $("setup-panel").classList.remove("hidden");
    updateCandidateCount();
    if (state.center) map.setView(state.center, 14);
  }

  map.on("click", (event) => {
    if (!$("setup-panel").classList.contains("hidden")) {
      setCenter(event.latlng);
      fitCenterCircle(); // タップした中心の円全体が、パネルに隠れない位置に収まるよう調整
    }
  });

  function updateRadiusLabel(radiusKm) {
    const target = targetStepMeters(radiusKm * 1000);
    $("radius-label").textContent = `${radiusKm.toFixed(1)} km（目標マス間 約${formatDistance(target)}）`;
  }

  // input（ドラッグ中）は円の再描画だけ。毎フレームのfitBoundsは重いので避ける。
  $("radius-range").addEventListener("input", (event) => {
    updateRadiusLabel(Number(event.target.value));
    drawCenterCircle();
    updateCandidateCount();
  });
  // change（指を離した時）に円全体が見える位置・ズームへ地図を合わせる。
  $("radius-range").addEventListener("change", fitCenterCircle);

  // グリップのタップでパネルを折りたたみ／展開する
  document.querySelectorAll(".panel-grip").forEach((grip) => {
    const toggle = () => {
      const panel = grip.closest(".bottom-panel");
      if (!panel) return;
      const collapsed = panel.classList.toggle("collapsed");
      grip.setAttribute("aria-expanded", collapsed ? "false" : "true");
      // 折りたたみ/展開でパネル高さが変わるので、中心円の収まりを取り直す
      if (panel.id === "setup-panel") setTimeout(fitCenterCircle, 60);
    };
    grip.addEventListener("click", toggle); // <button>なのでEnter/Spaceは自動でclickになる
  });

  $("btn-current-location").addEventListener("click", async () => {
    try {
      const position = await currentPosition();
      const latlng = showCurrentPosition(position, true);
      if (!$("setup-panel").classList.contains("hidden")) setCenter(L.latLng(latlng[0], latlng[1]));
    } catch (error) {
      toast(error.message, 4500);
    }
  });

  $("geojson-input").addEventListener("change", (event) => importGeoJSON(event.target.files[0]));
  $("btn-generate").addEventListener("click", generateRoute);
  $("btn-dice").addEventListener("click", rollDice);
  $("btn-arrival").addEventListener("click", checkArrival);
  $("btn-demo-arrival").addEventListener("click", demoArrival);
  $("btn-reset").addEventListener("click", resetToSetup);
  $("btn-play-again").addEventListener("click", resetToSetup);
  $("btn-download-album").addEventListener("click", downloadAlbum);

  /** 選択／撮影した画像を採用してプレビューと送信欄を出す（ファイル選択・カメラ共通） */
  function usePhotoFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      toast("画像ファイルを選んでください。");
      return;
    }
    if (state.currentPhotoUrl) URL.revokeObjectURL(state.currentPhotoUrl);
    state.currentPhotoUrl = URL.createObjectURL(file);
    state.currentPhotoFile = file;
    $("photo-preview").src = state.currentPhotoUrl;
    $("photo-preview").classList.remove("hidden");
    $("submit-section").classList.remove("hidden");
  }

  $("photo-input").addEventListener("change", (event) => {
    usePhotoFile(event.target.files[0]);
  });

  // ===== ウェブカメラ撮影（PCのフロントカメラ・スマホのカメラ両対応） =====
  let cameraStream = null;
  let cameraFacing = "environment"; // スマホは背面優先。PCは前面(内蔵)カメラが使われる

  async function startCameraStream() {
    stopCameraStream();
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: cameraFacing } },
      audio: false
    });
    const video = $("camera-video");
    video.srcObject = cameraStream;
    video.classList.toggle("mirrored", cameraFacing === "user"); // フロントは鏡像で自然に
    await video.play().catch(() => {});
  }

  function stopCameraStream() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }
  }

  function closeCamera() {
    stopCameraStream();
    const video = $("camera-video");
    if (video) video.srcObject = null;
    closeDialog($("camera-dialog"));
  }

  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast("このブラウザはカメラ撮影に対応していません。「写真を撮る／選ぶ」からファイルを選んでください。", 5000);
      return;
    }
    showDialog($("camera-dialog"));
    try {
      await startCameraStream();
    } catch (error) {
      const msg = error?.name === "NotAllowedError"
        ? "カメラの使用が許可されていません。ブラウザのカメラ権限を許可してください。"
        : `カメラを起動できません：${error?.message || error}`;
      toast(msg, 5000);
      closeCamera();
    }
  }

  async function switchCamera() {
    cameraFacing = cameraFacing === "environment" ? "user" : "environment";
    try {
      await startCameraStream();
    } catch (error) {
      toast("このカメラに切り替えできませんでした。", 4000);
    }
  }

  function captureFromCamera() {
    const video = $("camera-video");
    if (!video || !video.videoWidth) {
      toast("カメラの準備中です。少し待ってからもう一度押してください。", 3500);
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) {
        toast("撮影に失敗しました。もう一度お試しください。");
        return;
      }
      sfx.shutter();
      usePhotoFile(new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" }));
      closeCamera();
    }, "image/jpeg", 0.92);
  }

  $("btn-open-camera").addEventListener("click", openCamera);
  $("btn-camera-shoot").addEventListener("click", captureFromCamera);
  $("btn-camera-switch").addEventListener("click", switchCamera);
  $("btn-camera-close").addEventListener("click", closeCamera);
  $("camera-dialog").addEventListener("close", stopCameraStream);
  $("camera-dialog").addEventListener("cancel", stopCameraStream);

  $("btn-submit-photo").addEventListener("click", submitPhoto);
  $("mission-dialog").addEventListener("close", () => {
    if (state.targetReached && state.position >= 0) {
      $("btn-arrival").disabled = false;
      $("game-status").textContent = "ミッションを閉じました。到着判定から再開できます。";
    }
  });

  $("safety-dialog").addEventListener("cancel", (event) => {
    if (!$("safety-check").checked) event.preventDefault();
  });
  $("safety-check").addEventListener("change", (event) => {
    $("btn-safety-ok").disabled = !event.target.checked;
  });
  $("btn-safety-ok").addEventListener("click", () => localStorage.setItem("monomaneSafetyAccepted", "1"));

  $("btn-sources").addEventListener("click", () => showDialog($("sources-dialog")));
  $("score-chip").addEventListener("click", () => showDialog($("sources-dialog")));

  // 効果音のオン／オフ
  $("btn-sound").textContent = sfx.isMuted() ? "🔇" : "🔊";
  $("btn-sound").addEventListener("click", () => {
    const muted = sfx.toggleMute();
    $("btn-sound").textContent = muted ? "🔇" : "🔊";
    toast(muted ? "効果音をオフにしました。" : "効果音をオンにしました。", 1600);
  });
  $("btn-close-sources").addEventListener("click", () => closeDialog($("sources-dialog")));

  window.addEventListener("beforeunload", () => {
    state.album.forEach((item) => item.photoUrl && URL.revokeObjectURL(item.photoUrl));
    if (state.currentPhotoUrl) URL.revokeObjectURL(state.currentPhotoUrl);
  });

  // ===================== P2: タブ・部屋連携 =====================

  const TABS = ["judge", "map", "profile"];

  function switchTab(name) {
    if (!TABS.includes(name)) return;
    state.activeTab = name;
    TABS.forEach((tab) => {
      $(`view-${tab}`).classList.toggle("hidden", tab !== name);
    });
    document.querySelectorAll(".tab-button").forEach((button) => {
      const active = button.dataset.tab === name;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    if (name === "map") setTimeout(() => map.invalidateSize(), 60);
    if (name === "judge") renderScoreboard();
  }

  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });

  // --- プロフィール（localStorage保持） ---
  function loadProfile() {
    $("profile-nickname").value = localStorage.getItem("monomaneNickname") || "";
    const icon = localStorage.getItem("monomaneIcon");
    if (icon) $("profile-icon").value = icon;
  }
  function profileNickname() {
    const value = $("profile-nickname").value.trim();
    return value || "挑戦者";
  }
  $("profile-nickname").addEventListener("change", () => {
    localStorage.setItem("monomaneNickname", $("profile-nickname").value.trim());
    $("player-name").value = profileNickname();
  });
  $("profile-icon").addEventListener("change", () => {
    localStorage.setItem("monomaneIcon", $("profile-icon").value);
  });

  // --- API ---
  async function api(path, { method = "GET", body = null, auth = true } = {}) {
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (auth && state.me?.token) headers["X-Player-Token"] = state.me.token;
    const response = await fetch(`api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function saveSession() {
    if (state.me && state.room) {
      localStorage.setItem("monomaneSession", JSON.stringify({
        code: state.room.code, token: state.me.token,
        playerId: state.me.playerId, isHost: state.me.isHost
      }));
    } else {
      localStorage.removeItem("monomaneSession");
    }
  }

  function boardToSpots() {
    return state.route.map((spot) => ({
      id: spot.id, category: spot.category, name: spot.name,
      lat: spot.lat, lon: spot.lon, points: spot.points,
      difficulty: spot.difficulty, source: spot.source, license: spot.license
    }));
  }

  function spotsToRoute(spots) {
    return spots.map((spot, index) => ({
      id: String(spot.id ?? `spot-${index}`),
      category: spot.category,
      name: spot.name,
      lat: Number(spot.lat),
      lon: Number(spot.lon),
      points: Number(spot.points) || CATEGORIES[spot.category]?.points || 10,
      difficulty: Number(spot.difficulty) || CATEGORIES[spot.category]?.difficulty || 1,
      source: spot.source || "共有された盤面",
      license: spot.license || "ライセンス要確認"
    })).filter((spot) => CATEGORIES[spot.category] && Number.isFinite(spot.lat));
  }

  async function createRoom() {
    if (!state.route.length) { toast("先に盤面を生成してください。"); return; }
    try {
      const result = await api("/rooms", {
        auth: false,
        method: "POST",
        body: {
          nickname: profileNickname(),
          icon: $("profile-icon").value,
          board: {
            center: { lat: state.center[0], lon: state.center[1] },
            radiusM: Number($("radius-range").value) * 1000,
            spots: boardToSpots()
          }
        }
      });
      state.me = { token: result.playerToken, playerId: result.playerId, isHost: true };
      state.room = { code: result.code, status: "playing" };
      saveSession();
      renderRoomCard();
      startPolling();
      toast(`部屋 ${result.code} を作成しました。コードを共有してください。`, 5000);
    } catch (error) {
      toast(`部屋を作成できません：${error.message}`, 5000);
    }
  }

  async function joinRoom() {
    const code = $("join-code").value.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) { toast("6桁の部屋コードを入力してください。"); return; }
    try {
      const result = await api(`/rooms/${code}/join`, {
        auth: false,
        method: "POST",
        body: { nickname: profileNickname(), icon: $("profile-icon").value }
      });
      state.me = { token: result.playerToken, playerId: result.playerId, isHost: false };
      applyRoomState(result);
      saveSession();
      startPolling();
      switchTab("map");
      toast(`部屋 ${code} に参加しました。`);
    } catch (error) {
      toast(`参加できません：${error.message}`, 5000);
    }
  }

  function applyRoomState(payload) {
    if (!payload?.room) return;
    const isNewBoard = !state.room || state.room.code !== payload.room.code || !state.route.length;
    state.room = { code: payload.room.code, status: payload.room.status };
    state.peers = (payload.players || []).filter((p) => p.id !== state.me?.playerId);

    // 盤面生成パネルを開いて操作中は、ポーリングで盤面を組み直して勝手に表示しない
    // （「盤面を作り直す」直後などにコマが振り出しで再表示されるのを防ぐ）
    const inSetup = !$("setup-panel").classList.contains("hidden");
    let boardRebuilt = false;
    if (isNewBoard && payload.room.board?.spots && !inSetup) {
      const route = spotsToRoute(payload.room.board.spots);
      if (route.length) {
        const center = payload.room.board.center;
        if (center) state.center = [Number(center.lat), Number(center.lon)];
        state.route = route;
        resetGameState(false);
        renderRoute();
        $("no-room-panel").classList.add("hidden");
        $("setup-panel").classList.add("hidden");
        $("game-panel").classList.remove("hidden");
        $("progress-chip").textContent = `0 / ${state.route.length}`;
        $("game-status").textContent = `部屋 ${state.room.code} の盤面。サイコロを振ってスタート。`;
        $("btn-dice").disabled = false;
        $("btn-demo-arrival").classList.toggle("hidden", !CONFIG.allowDemoArrival);
        enhanceWithRoadRoute();
        boardRebuilt = true;
      }
    }
    state.photos = payload.photos || [];
    const mine = (payload.players || []).find((p) => p.id === state.me?.playerId);
    if (mine) {
      state.score = mine.score;
      $("score-chip").textContent = `${state.score}点`;
      // リロードや再入室で盤面を組み直したとき、サーバが保持している現在マスへコマを戻す
      if (boardRebuilt && Number.isInteger(mine.position) && mine.position >= 0) {
        restorePosition(mine.position);
      }
    }
    renderRoomCard();
    renderPeers();
    renderScoreboard();
    renderJudgeFeed();
  }

  /** サーバに保存された現在マスへコマを戻す（リロードしても振り出しに戻らないように） */
  function restorePosition(pos) {
    pos = Math.min(pos, state.route.length - 1);
    state.position = pos;
    state.targetReached = false;
    markRouteProgress();
    const target = state.route[pos];
    if (!target) return;
    const cat = CATEGORIES[target.category];
    $("target-card").classList.remove("hidden");
    $("target-emoji").textContent = cat.emoji;
    $("target-name").textContent = `${pos + 1}. ${target.name}`;
    $("target-distance").textContent = "現在地に移動して到着判定をするか、サイコロで次のマスへ。";
    $("progress-chip").textContent = `${pos + 1} / ${state.route.length}`;
    $("game-status").textContent = `前回の続きから再開：${pos + 1}マス目です。`;
    $("btn-arrival").disabled = false;
    $("btn-dice").disabled = false;
  }

  // ===== 採点フィード =====
  function renderJudgeFeed() {
    const feed = $("judge-feed");
    if (!feed) return;
    feed.replaceChildren();

    const others = state.photos.filter((photo) => photo.playerId !== state.me?.playerId);
    const pending = others.filter((photo) => !photo.ratedByMe);
    const done = others.filter((photo) => photo.ratedByMe);
    const mine = state.photos.filter((photo) => photo.playerId === state.me?.playerId);

    const badge = $("judge-badge");
    badge.textContent = String(pending.length);
    badge.classList.toggle("hidden", pending.length === 0);

    $("judge-empty").classList.toggle("hidden", state.photos.length > 0);
    if (!state.photos.length) return;

    if (pending.length) {
      feed.append(sectionTitle(`採点待ち（${pending.length}）`));
      pending.forEach((photo) => feed.append(photoCard(photo, true)));
    }
    if (mine.length) {
      feed.append(sectionTitle("自分の写真"));
      mine.forEach((photo) => feed.append(photoCard(photo, false)));
    }
    if (done.length) {
      feed.append(sectionTitle("採点済み"));
      done.forEach((photo) => feed.append(photoCard(photo, false)));
    }
  }

  function sectionTitle(text) {
    const heading = document.createElement("h3");
    heading.className = "feed-section-title";
    heading.textContent = text;
    return heading;
  }

  function photoCard(photo, ratable) {
    const card = document.createElement("article");
    card.className = "photo-card";

    const image = document.createElement("img");
    image.className = "photo-card-image";
    image.loading = "lazy";
    image.alt = photo.spotName;
    image.src = `${photo.url}?t=${encodeURIComponent(state.me?.token || "")}`;
    card.append(image);

    const head = document.createElement("div");
    head.className = "photo-card-head";
    const cat = CATEGORIES[photo.category];
    head.innerHTML =
      `<span class="photo-card-emoji">${cat ? cat.emoji : "📷"}</span>` +
      `<span class="photo-card-title"><strong>${escapeHtml(photo.spotName)}</strong>` +
      `<small>${escapeHtml(photo.icon || "🙂")} ${escapeHtml(photo.nickname)}　基礎点${photo.basePoints}</small></span>`;
    card.append(head);

    if (ratable) {
      const hint = document.createElement("p");
      hint.className = "photo-card-hint";
      hint.textContent = "似ているほど星を増やす";
      card.append(hint);

      const stars = document.createElement("div");
      stars.className = "stars";
      for (let value = 1; value <= 5; value += 1) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.rating = String(value);
        button.textContent = "★";
        button.addEventListener("click", () => {
          stars.querySelectorAll("button").forEach((other) => {
            other.classList.toggle("on", Number(other.dataset.rating) <= value);
          });
          card.dataset.stars = String(value);
          send.disabled = false;
        });
        stars.append(button);
      }
      card.append(stars);

      const bonusLabel = document.createElement("label");
      bonusLabel.className = "check-row";
      const bonus = document.createElement("input");
      bonus.type = "checkbox";
      bonusLabel.append(bonus, document.createTextNode(" 電柱が写り込んだ（+5点）"));
      card.append(bonusLabel);

      const send = document.createElement("button");
      send.className = "button primary";
      send.type = "button";
      send.textContent = "採点する";
      send.disabled = true;
      send.addEventListener("click", async () => {
        send.disabled = true;
        send.textContent = "送信中…";
        try {
          await api(`/photos/${photo.id}/ratings`, {
            method: "POST",
            body: { stars: Number(card.dataset.stars), poleBonus: bonus.checked }
          });
          sfx.star();
          toast("採点しました。");
          pollState();
        } catch (error) {
          toast(`採点できません：${error.message}`, 4500);
          send.disabled = false;
          send.textContent = "採点する";
        }
      });
      card.append(send);
    } else {
      const result = document.createElement("p");
      result.className = "photo-card-result";
      result.textContent = photo.ratingCount
        ? `★${photo.avgStars}（${photo.ratingCount}人）　${photo.points}点${photo.poleBonus ? "　⚡+5" : ""}`
        : "まだ採点されていません";
      card.append(result);

      if (photo.playerId === state.me?.playerId) {
        const publish = document.createElement("button");
        publish.className = photo.publishedId ? "text-button danger" : "text-button";
        publish.type = "button";
        publish.textContent = photo.publishedId ? "🌐 公開を取り下げる" : "🌐 ネットにも公開する";
        publish.addEventListener("click", () => {
          if (photo.publishedId) {
            unpublishPhoto(photo.id);
          } else {
            toast("公開は撮影直後の画面から行えます。次回から送信時に選んでください。", 5000);
          }
        });
        card.append(publish);
      }
    }
    return card;
  }

  function renderRoomCard() {
    const hasRoom = Boolean(state.room);
    $("room-card").classList.toggle("hidden", !hasRoom);
    $("join-card").classList.toggle("hidden", hasRoom);
    $("create-card").classList.toggle("hidden", hasRoom);
    if (!hasRoom) return;
    $("room-code-text").textContent = state.room.code;

    // アルバム作成ボタン：自分の写真が1枚以上あるときだけ有効化する
    const myPhotos = state.photos.filter((photo) => photo.playerId === state.me?.playerId);
    const albumBtn = $("btn-make-album");
    if (albumBtn) {
      const canMake = myPhotos.length > 0;
      albumBtn.disabled = !canMake;
      $("album-hint").classList.toggle("hidden", canMake);
    }
    const list = $("member-list");
    list.replaceChildren();
    const all = [...state.peers];
    if (state.me) {
      all.unshift({ id: state.me.playerId, nickname: profileNickname(),
                    icon: $("profile-icon").value, isHost: state.me.isHost, score: state.score });
    }
    all.forEach((player) => {
      const chip = document.createElement("span");
      chip.className = "member-chip";
      chip.textContent = `${player.icon || "🙂"} ${player.nickname}`;
      if (player.isHost) {
        const mark = document.createElement("span");
        mark.className = "host-mark";
        mark.textContent = "主";
        chip.append(mark);
      }
      list.append(chip);
    });
  }

  function renderPeers() {
    state.peerMarkers.forEach((marker) => marker.remove());
    state.peerMarkers.clear();
    state.peers.forEach((peer) => {
      if (peer.position < 0 || !state.route[peer.position]) return;
      const spot = state.route[peer.position];
      const icon = L.divIcon({
        className: "",
        html: `<div class="peer-marker">${peer.icon || "🙂"}</div>`,
        iconSize: [26, 26], iconAnchor: [13, 26]
      });
      const marker = L.marker([spot.lat, spot.lon], { icon, zIndexOffset: 900 })
        .addTo(map)
        .bindTooltip(`${peer.nickname}（${peer.position + 1}マス目）`);
      state.peerMarkers.set(peer.id, marker);
    });
  }

  function renderScoreboard() {
    const board = $("scoreboard");
    if (!board) return;
    board.replaceChildren();
    if (!state.room) {
      $("judge-empty").classList.remove("hidden");
      return;
    }
    const rows = [...state.peers.map((p) => ({ ...p, isMe: false }))];
    if (state.me) {
      rows.push({ id: state.me.playerId, nickname: profileNickname(),
                  icon: $("profile-icon").value, score: state.score, isMe: true });
    }
    rows.sort((a, b) => b.score - a.score);
    rows.forEach((player, index) => {
      const row = document.createElement("div");
      row.className = `score-row${player.isMe ? " me" : ""}`;
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = `${index + 1}`;
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = `${player.icon || "🙂"} ${player.nickname}`;
      const pts = document.createElement("span");
      pts.className = "pts";
      pts.textContent = `${player.score || 0}点`;
      row.append(rank, who, pts);
      board.append(row);
    });
  }

  async function reportProgress() {
    if (!state.room || !state.me) return;
    try {
      await api(`/rooms/${state.room.code}/progress`, {
        method: "POST", body: { position: state.position }
      });
    } catch (error) {
      console.warn("進行の報告に失敗", error);
    }
  }

  async function pollState() {
    if (!state.room || !state.me) return;
    try {
      applyRoomState(await api(`/rooms/${state.room.code}/state`));
    } catch (error) {
      console.warn("同期に失敗", error);
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(pollState, 5000);
  }
  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  async function leaveRoom() {
    if (!state.room || !state.me) return;
    if (!confirm("部屋を出ますか？")) return;
    try {
      if (!state.me.isHost) {
        await api(`/rooms/${state.room.code}/players/me`, { method: "DELETE" });
      }
    } catch (error) {
      console.warn(error);
    }
    stopPolling();
    state.peerMarkers.forEach((marker) => marker.remove());
    state.peerMarkers.clear();
    state.room = null;
    state.me = null;
    state.peers = [];
    saveSession();
    resetGameState(true);
    $("game-panel").classList.add("hidden");
    $("setup-panel").classList.add("hidden");
    $("no-room-panel").classList.remove("hidden");
    renderRoomCard();
    renderScoreboard();
    toast("部屋を出ました。");
  }

  async function restoreSession() {
    const saved = localStorage.getItem("monomaneSession");
    if (!saved) return;
    try {
      const session = JSON.parse(saved);
      state.me = { token: session.token, playerId: session.playerId, isHost: session.isHost };
      state.room = { code: session.code };
      applyRoomState(await api(`/rooms/${session.code}/state`));
      startPolling();
      toast(`部屋 ${session.code} に復帰しました。`);
    } catch (error) {
      console.warn("セッション復帰に失敗", error);
      state.me = null;
      state.room = null;
      saveSession();
      $("no-room-panel").classList.remove("hidden");
    }
  }

  // ===================== P6: プライバシーエディタ & ネット採点 =====================

  function openPrivacyEditor(photoId, file) {
    const canvas = $("privacy-canvas");
    const ctx = canvas.getContext("2d");
    const image = new Image();
    image.onload = () => {
      const maxEdge = 900;
      const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      state.editor = { photoId, image, ctx, canvas, strokes: [], tool: "mosaic", drawing: false };
      redrawEditor();
      $("publish-consent").checked = false;
      $("btn-publish-confirm").disabled = true;
      document.querySelectorAll(".tool-button").forEach((button, index) => {
        button.classList.toggle("active", index === 0);
      });
      showDialog($("privacy-dialog"));
    };
    image.src = URL.createObjectURL(file);
  }

  function redrawEditor() {
    const ed = state.editor;
    if (!ed) return;
    ed.ctx.drawImage(ed.image, 0, 0, ed.canvas.width, ed.canvas.height);
    ed.strokes.forEach((stroke) => {
      if (stroke.tool === "mosaic") {
        stroke.points.forEach((point) => applyMosaic(ed, point.x, point.y, stroke.size));
      } else {
        ed.ctx.font = `${stroke.size * 1.6}px sans-serif`;
        ed.ctx.textAlign = "center";
        ed.ctx.textBaseline = "middle";
        stroke.points.forEach((point) => ed.ctx.fillText(stroke.tool, point.x, point.y));
      }
    });
  }

  /** 指定位置を縮小→拡大で塗り直してピクセル化する */
  function applyMosaic(ed, x, y, size) {
    const block = Math.max(6, Math.round(size / 3));
    const half = size / 2;
    const sx = Math.max(0, Math.round(x - half));
    const sy = Math.max(0, Math.round(y - half));
    const sw = Math.min(ed.canvas.width - sx, Math.round(size));
    const sh = Math.min(ed.canvas.height - sy, Math.round(size));
    if (sw <= 0 || sh <= 0) return;
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.round(sw / block));
    small.height = Math.max(1, Math.round(sh / block));
    const sctx = small.getContext("2d");
    sctx.drawImage(ed.canvas, sx, sy, sw, sh, 0, 0, small.width, small.height);
    ed.ctx.imageSmoothingEnabled = false;
    ed.ctx.drawImage(small, 0, 0, small.width, small.height, sx, sy, sw, sh);
    ed.ctx.imageSmoothingEnabled = true;
  }

  function editorPoint(event) {
    const ed = state.editor;
    const rect = ed.canvas.getBoundingClientRect();
    const source = event.touches ? event.touches[0] : event;
    return {
      x: (source.clientX - rect.left) * (ed.canvas.width / rect.width),
      y: (source.clientY - rect.top) * (ed.canvas.height / rect.height)
    };
  }

  function editorStart(event) {
    const ed = state.editor;
    if (!ed) return;
    event.preventDefault();
    ed.drawing = true;
    const size = Math.round(Math.max(ed.canvas.width, ed.canvas.height) * 0.11);
    ed.strokes.push({ tool: ed.tool, size, points: [editorPoint(event)] });
    redrawEditor();
  }

  function editorMove(event) {
    const ed = state.editor;
    if (!ed?.drawing) return;
    event.preventDefault();
    const stroke = ed.strokes[ed.strokes.length - 1];
    if (stroke.tool !== "mosaic") return; // スタンプは1タップ1個
    stroke.points.push(editorPoint(event));
    redrawEditor();
  }

  function editorEnd() {
    if (state.editor) state.editor.drawing = false;
  }

  async function confirmPublish() {
    const ed = state.editor;
    if (!ed) return;
    const button = $("btn-publish-confirm");
    button.disabled = true;
    button.textContent = "公開中…";
    try {
      const blob = await new Promise((resolve) => ed.canvas.toBlob(resolve, "image/jpeg", 0.85));
      const form = new FormData();
      form.append("photo", blob, "public.jpg");
      const response = await fetch(`api/photos/${ed.photoId}/publish`, {
        method: "POST",
        headers: { "X-Player-Token": state.me.token },
        body: form
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      closeDialog($("privacy-dialog"));
      state.editor = null;
      sfx.star();
      toast("ネットに公開しました。いつでも取り下げできます。", 4500);
      pollState();
      loadGallery();
    } catch (error) {
      toast(`公開できません：${error.message}`, 5000);
      button.disabled = false;
      button.textContent = "この内容で公開する";
    }
  }

  async function unpublishPhoto(photoId) {
    if (!confirm("ネットへの公開を取り下げますか？ 公開用の画像と投票は削除されます。")) return;
    try {
      const response = await fetch(`api/photos/${photoId}/publish`, {
        method: "DELETE",
        headers: { "X-Player-Token": state.me.token }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      toast("公開を取り下げました。");
      pollState();
      loadGallery();
    } catch (error) {
      toast(`取り下げできません：${error.message}`, 4500);
    }
  }

  async function loadGallery() {
    try {
      const data = await api("/gallery", { auth: false });
      state.gallery = data.items || [];
      if (state.judgeMode === "net") renderGallery();
    } catch (error) {
      console.warn("ギャラリー取得に失敗", error);
    }
  }

  function renderGallery() {
    const wrap = $("net-gallery");
    wrap.replaceChildren();
    if (!state.gallery.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "まだ公開された写真がありません";
      wrap.append(empty);
      return;
    }
    state.gallery.forEach((item) => {
      const card = document.createElement("article");
      card.className = "photo-card";

      const image = document.createElement("img");
      image.className = "photo-card-image";
      image.loading = "lazy";
      image.src = item.url;
      image.alt = item.spotName;
      card.append(image);

      const head = document.createElement("div");
      head.className = "photo-card-head";
      const cat = CATEGORIES[item.category];
      head.innerHTML =
        `<span class="photo-card-emoji">${cat ? cat.emoji : "📷"}</span>` +
        `<span class="photo-card-title"><strong>${escapeHtml(item.spotName)}</strong>` +
        `<small>${escapeHtml(item.nickname)}　${
          item.voteCount ? `★${item.avgStars}（${item.voteCount}票）` : "まだ投票なし"}</small></span>`;
      card.append(head);

      const stars = document.createElement("div");
      stars.className = "stars";
      for (let value = 1; value <= 5; value += 1) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "★";
        button.addEventListener("click", async () => {
          stars.querySelectorAll("button").forEach((other, index) => {
            other.classList.toggle("on", index < value);
          });
          try {
            await api(`/gallery/${item.id}/votes`, { auth: false, method: "POST", body: { stars: value } });
            toast("投票しました（得点には影響しません）");
            loadGallery();
          } catch (error) {
            toast(`投票できません：${error.message}`, 4000);
          }
        });
        stars.append(button);
      }
      card.append(stars);

      const report = document.createElement("button");
      report.className = "text-button danger report-button";
      report.type = "button";
      report.textContent = "通報";
      report.addEventListener("click", async () => {
        if (!confirm("この写真を通報しますか？")) return;
        try {
          await api(`/gallery/${item.id}/reports`, { auth: false, method: "POST" });
          toast("通報しました。ご協力ありがとうございます。");
          loadGallery();
        } catch (error) {
          toast(`通報できません：${error.message}`, 4000);
        }
      });
      card.append(report);
      wrap.append(card);
    });
  }

  function switchJudgeMode(mode) {
    state.judgeMode = mode;
    $("seg-room").classList.toggle("active", mode === "room");
    $("seg-net").classList.toggle("active", mode === "net");
    $("net-gallery").classList.toggle("hidden", mode !== "net");
    $("scoreboard").classList.toggle("hidden", mode === "net");
    $("judge-feed").classList.toggle("hidden", mode === "net");
    $("judge-empty").classList.add("hidden");
    if (mode === "net") {
      renderGallery();
      loadGallery();
    } else {
      renderJudgeFeed();
    }
  }

  $("seg-room").addEventListener("click", () => switchJudgeMode("room"));
  $("seg-net").addEventListener("click", () => switchJudgeMode("net"));

  document.querySelectorAll(".tool-button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tool-button").forEach((other) => other.classList.remove("active"));
      button.classList.add("active");
      if (state.editor) state.editor.tool = button.dataset.tool;
    });
  });

  const privacyCanvas = $("privacy-canvas");
  privacyCanvas.addEventListener("mousedown", editorStart);
  privacyCanvas.addEventListener("mousemove", editorMove);
  window.addEventListener("mouseup", editorEnd);
  privacyCanvas.addEventListener("touchstart", editorStart, { passive: false });
  privacyCanvas.addEventListener("touchmove", editorMove, { passive: false });
  privacyCanvas.addEventListener("touchend", editorEnd);

  $("btn-editor-undo").addEventListener("click", () => {
    if (state.editor?.strokes.length) {
      state.editor.strokes.pop();
      redrawEditor();
    }
  });
  $("btn-editor-clear").addEventListener("click", () => {
    if (state.editor) {
      state.editor.strokes = [];
      redrawEditor();
    }
  });
  $("publish-consent").addEventListener("change", (event) => {
    $("btn-publish-confirm").disabled = !event.target.checked;
  });
  $("btn-publish-confirm").addEventListener("click", confirmPublish);
  $("btn-privacy-cancel").addEventListener("click", () => {
    closeDialog($("privacy-dialog"));
    state.editor = null;
    toast("部屋にだけ送信済みです。ネット公開はしていません。", 4000);
  });

  // --- ボタン結線 ---
  $("btn-goto-profile").addEventListener("click", () => switchTab("profile"));
  $("btn-open-setup").addEventListener("click", () => {
    switchTab("map");
    $("no-room-panel").classList.add("hidden");
    $("game-panel").classList.add("hidden");
    $("setup-panel").classList.remove("hidden");
    $("player-name").value = profileNickname();
    setTimeout(fitCenterCircle, 80); // パネル表示後のレイアウト確定を待って円を映す
    toast("地図をタップして中心地点を選んでください。スライダーで探索半径を調整できます。", 3500);
  });
  $("btn-join-room").addEventListener("click", joinRoom);
  $("btn-leave-room").addEventListener("click", leaveRoom);
  // プロフィールタブから、あとでも自分の写真でアルバムPNGを作れる（部屋がfinishedでも可）
  $("btn-make-album").addEventListener("click", async () => {
    const myPhotos = state.photos.filter((photo) => photo.playerId === state.me?.playerId);
    if (!state.room || !myPhotos.length) {
      toast("まだアルバムを作れる写真がありません。");
      return;
    }
    const button = $("btn-make-album");
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "作成中…";
    try {
      const saved = await downloadAlbum();
      if (saved) toast("アルバム画像を書き出しました。共有メニューの「画像を保存」で写真に入ります。", 4500);
    } catch (error) {
      toast(`アルバムを作れません：${error.message}`, 4500);
    } finally {
      button.textContent = original;
      button.disabled = false;
    }
  });
  /** 一時inputを使ったコピー（iOS Safariでもクリックの同期パスで確実に書き込む） */
  function copyViaExecCommand(text) {
    const input = document.createElement("input");
    input.value = text;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.top = "-1000px";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    input.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    input.remove();
    return ok;
  }

  // クリックの同期パス内でコピーする（awaitを挟むとiOS Safariが拒否するため非async）。
  // 直前に /^[A-Z2-9]{6}$/ で検証し、成功トーストには実際にコピーした文字列を出す。
  $("btn-copy-code").addEventListener("click", () => {
    const code = String(state.room?.code || "").trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) {
      toast("有効な部屋コードがありません。");
      return;
    }
    // フォールバック（検証済みの同じ文字列を書き込む）を先に実行して確実性を担保
    const copied = copyViaExecCommand(code);
    // 対応環境では非同期APIでも上書きしておく（同じ検証済み文字列）
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).catch(() => {});
    }
    if (copied || navigator.clipboard?.writeText) {
      toast(`コピーしました: ${code}`);
    } else {
      toast(`部屋コード：${code}`);
    }
  });
  $("btn-open-sources").addEventListener("click", () => showDialog($("sources-dialog")));
  $("btn-open-safety").addEventListener("click", () => showDialog($("safety-dialog")));

  window.addEventListener("beforeunload", stopPolling);

  // ===== PWA: Service Worker 登録と更新検知 =====
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").then((registration) => {
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            $("update-bar").classList.remove("hidden");
            $("btn-update").onclick = () => {
              installing.postMessage("skipWaiting");
              location.reload();
            };
          }
        });
      });
    }).catch((error) => console.warn("Service Workerを登録できません", error));
  }

  function updateOnlineStatus() {
    $("offline-bar").classList.toggle("hidden", navigator.onLine);
  }
  window.addEventListener("online", updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);
  updateOnlineStatus();

  loadProfile();
  switchTab("map");
  restoreSession();

  updateRadiusLabel(Number($("radius-range").value));
  setCenter(L.latLng(CONFIG.initialCenter[0], CONFIG.initialCenter[1]));
  loadDefaultData();
  if (localStorage.getItem("monomaneSafetyAccepted") !== "1") showDialog($("safety-dialog"));
})();
