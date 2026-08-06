window.MONOMANE_CONFIG = Object.freeze({
  initialCenter: [38.2601, 140.8824],
  initialZoom: 14,
  dataUrl: "data/spots.geojson",
  arrivalRadiusMeters: 70,
  maxGpsAccuracyMeters: 100,
  minRouteSpots: 6,
  minTargetStepMeters: 180,
  maxTargetStepMeters: 900,
  targetStepRadiusRatio: 0.24,
  categoryUsagePenalty: 0.58,
  consecutiveCategoryPenalty: 0.35,
  maxImportFeatures: 100000,
  maxImportBytes: 25 * 1024 * 1024,
  allowDemoArrival: true,
  // CARTO Voyager: OpenStreetMapのデータを、Googleマップに近い見やすい配色で描いたタイル
  mapTiles: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  mapSubdomains: "abcd",
  mapAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
  // 徒歩経路はサーバのプロキシ経由で取得する（APIキーはサーバ側の環境変数ORS_API_KEYに置きブラウザへ出さない）
  routeProxyUrl: "api/route"
});
