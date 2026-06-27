const ASSET_VERSION = "30cm-areas-20260627";
const MAP_SCALE_METERS = 0.3;

const Leaflet = window.L;

const els = {
  viewport: document.querySelector("#viewport"),
  map: document.querySelector("#map"),
  locateBtn: document.querySelector("#locateBtn"),
  shareBtn: document.querySelector("#shareBtn"),
  shareHint: document.querySelector("#shareHint"),
  shareCancelBtn: document.querySelector("#shareCancelBtn"),
  shareModal: document.querySelector("#shareModal"),
  shareCloseBtn: document.querySelector("#shareCloseBtn"),
  shareXBtn: document.querySelector("#shareXBtn"),
  shareMyLocationBtn: document.querySelector("#shareMyLocationBtn"),
  sharePinBtn: document.querySelector("#sharePinBtn"),
  shareChoices: document.querySelector("#shareChoices"),
  shareResult: document.querySelector("#shareResult"),
  shareDescription: document.querySelector("#shareDescription"),
  shareUrl: document.querySelector("#shareUrl"),
  copyShareBtn: document.querySelector("#copyShareBtn"),
  infoBtn: document.querySelector("#infoBtn"),
  infoModal: document.querySelector("#infoModal"),
  infoCloseBtn: document.querySelector("#infoCloseBtn"),
  infoXBtn: document.querySelector("#infoXBtn"),
  zoomInBtn: document.querySelector("#zoomInBtn"),
  zoomOutBtn: document.querySelector("#zoomOutBtn"),
};

const state = {
  metadata: null,
  stages: [],
  areas: [],
  poiAreaThreshold: 0,
  imageW: 0,
  imageH: 0,
  bounds: null,
  map: null,
  defaultZoom: null,
  layers: {},
  activeAreaLayer: null,
  activeAreaId: null,
  areaLabelMarkers: new Map(),
  locationWatch: null,
  lastLocation: null,
  locationDot: null,
  accuracyCircle: null,
  shareMode: null,
  shareClickHandler: null,
  sharedPoint: null,
  sharedMarker: null,
};

init();

async function init() {
  if (!Leaflet) throw new Error("Leaflet is niet geladen");

  bindEvents();
  const [metadata, stages, areas] = await Promise.all([
    fetchJson(`assets/map.metadata.json?v=${ASSET_VERSION}`),
    fetchJson(`assets/stages.geojson?v=${ASSET_VERSION}`),
    fetchJson(`assets/areas.geojson?v=${ASSET_VERSION}`),
  ]);

  state.metadata = metadata;
  state.imageW = Number(metadata.output_size_pixels?.[0] || 0);
  state.imageH = Number(metadata.output_size_pixels?.[1] || 0);
  state.stages = normalizeStages(stages.features || []);
  state.areas = normalizeAreas(areas.features || []);
  state.poiAreaThreshold = poiAreaThreshold(state.areas);

  initMap();
  renderAreas();
  renderStages();
  restoreSharedLocation();
}

function initMap() {
  state.bounds = Leaflet.latLngBounds(pixelLatLng({ x: 0, y: state.imageH }), pixelLatLng({ x: state.imageW, y: 0 }));
  state.map = Leaflet.map(els.map, {
    attributionControl: false,
    bounceAtZoomLimits: false,
    boxZoom: false,
    crs: Leaflet.CRS.Simple,
    dragging: true,
    doubleClickZoom: true,
    fadeAnimation: false,
    inertia: true,
    keyboard: false,
    markerZoomAnimation: false,
    minZoom: -8,
    preferCanvas: true,
    tap: false,
    touchZoom: true,
    wheelPxPerZoomLevel: 90,
    zoomAnimation: true,
    zoomControl: false,
    zoomDelta: 0.5,
    zoomSnap: 0.25,
  });

  createPane("ww-image-pane", 200, "none");
  createPane("ww-dim-pane", 320, "none");
  createPane("ww-active-area-pane", 340, "none");
  createPane("ww-label-pane", 520, "auto");
  createPane("ww-location-pane", 650, "auto");

  const image = Leaflet.imageOverlay(`assets/map.webp?v=${ASSET_VERSION}`, state.bounds, {
    pane: "ww-image-pane",
    interactive: false,
  }).addTo(state.map);

  image.once("error", () => {
    state.map.removeLayer(image);
    Leaflet.imageOverlay(`assets/map.png?v=${ASSET_VERSION}`, state.bounds, {
      pane: "ww-image-pane",
      interactive: false,
    }).addTo(state.map);
  });

  state.layers.dim = Leaflet.layerGroup().addTo(state.map);
  state.layers.active = Leaflet.layerGroup().addTo(state.map);
  state.layers.labels = Leaflet.layerGroup().addTo(state.map);
  state.layers.pois = Leaflet.layerGroup().addTo(state.map);
  state.layers.stages = Leaflet.layerGroup().addTo(state.map);
  state.layers.location = Leaflet.layerGroup().addTo(state.map);

  fitMapToOverview();
  state.map.on("resize", fitMapToOverview);
  window.visualViewport?.addEventListener("resize", () => state.map.invalidateSize({ pan: false }));
}

function createPane(name, zIndex, pointerEvents) {
  const pane = state.map.createPane(name);
  pane.style.zIndex = String(zIndex);
  pane.style.pointerEvents = pointerEvents;
}

function fitMapToOverview() {
  requestAnimationFrame(() => {
    if (!state.map || !state.bounds) return;
    state.map.invalidateSize({ pan: false });
    const overviewZoom = state.map.getBoundsZoom(state.bounds, false, [14, 14]);
    state.defaultZoom = overviewZoom;
    if (!Number.isFinite(state.map.getZoom())) {
      state.map.fitBounds(state.bounds, { animate: false, padding: [14, 14] });
      return;
    }
  });
}

function bindEvents() {
  els.locateBtn.addEventListener("click", toggleLocation);
  els.shareBtn.addEventListener("click", openShare);
  els.shareCloseBtn.addEventListener("click", closeShare);
  els.shareXBtn.addEventListener("click", closeShare);
  els.shareCancelBtn.addEventListener("click", cancelSharePin);
  els.shareMyLocationBtn.addEventListener("click", shareMyLocation);
  els.sharePinBtn.addEventListener("click", startSharePin);
  els.copyShareBtn.addEventListener("click", copyShareUrl);
  els.infoBtn.addEventListener("click", openInfo);
  els.infoCloseBtn.addEventListener("click", closeInfo);
  els.infoXBtn.addEventListener("click", closeInfo);
  els.zoomInBtn.addEventListener("click", () => state.map?.zoomIn(0.5));
  els.zoomOutBtn.addEventListener("click", () => state.map?.zoomOut(0.5));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeInfo();
      closeShare();
      cancelSharePin();
    }
  });
}

function openShare() {
  els.shareChoices.hidden = false;
  els.shareResult.hidden = true;
  els.copyShareBtn.hidden = false;
  els.shareDescription.value = state.sharedPoint?.label || "";
  els.shareModal.hidden = false;
}

function closeShare() {
  els.shareModal.hidden = true;
}

function startSharePin() {
  closeShare();
  state.shareMode = "pin";
  els.shareHint.hidden = false;
  els.viewport.classList.add("is-placing-pin");
  els.map.classList.add("is-placing-pin");

  state.shareClickHandler = (event) => {
    const point = mapPointFromLatLng(event.latlng);
    cancelSharePin();
    showShareLink(point);
  };
  state.map.once("click", state.shareClickHandler);
}

function cancelSharePin() {
  if (state.shareClickHandler && state.map) state.map.off("click", state.shareClickHandler);
  state.shareClickHandler = null;
  state.shareMode = null;
  els.shareHint.hidden = true;
  els.viewport.classList.remove("is-placing-pin");
  els.map.classList.remove("is-placing-pin");
}

function shareMyLocation() {
  if (state.lastLocation) {
    showShareLink(wgs84ToPixel(state.lastLocation.coords.latitude, state.lastLocation.coords.longitude));
    return;
  }

  if (!navigator.geolocation) {
    showShareError("Geen GPS beschikbaar");
    return;
  }

  els.shareMyLocationBtn.textContent = "Zoeken...";
  navigator.geolocation.getCurrentPosition(
    (position) => {
      els.shareMyLocationBtn.textContent = "Mijn locatie";
      showShareLink(wgs84ToPixel(position.coords.latitude, position.coords.longitude));
    },
    () => {
      els.shareMyLocationBtn.textContent = "Mijn locatie";
      showShareError("Locatie geweigerd");
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 },
  );
}

function showShareError(message) {
  els.shareChoices.hidden = true;
  els.shareResult.hidden = false;
  els.shareUrl.value = message;
  els.copyShareBtn.hidden = true;
}

function showShareLink(point) {
  if (!insideMap(point.x, point.y)) {
    showShareError("Deze locatie valt buiten de kaart");
    return;
  }

  state.sharedPoint = { ...point, label: els.shareDescription.value.trim().slice(0, 140) };
  renderSharedPoint();
  els.shareChoices.hidden = true;
  els.shareResult.hidden = false;
  els.copyShareBtn.hidden = false;
  els.shareUrl.value = shareUrlForPoint(state.sharedPoint);
  els.shareUrl.select();
  els.shareModal.hidden = false;
}

async function copyShareUrl() {
  try {
    await navigator.clipboard.writeText(els.shareUrl.value);
    els.copyShareBtn.textContent = "Gekopieerd";
    setTimeout(() => {
      els.copyShareBtn.textContent = "Kopieer link";
    }, 1400);
  } catch {
    els.shareUrl.select();
  }
}

function openInfo() {
  els.infoModal.hidden = false;
}

function closeInfo() {
  els.infoModal.hidden = true;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Kon ${url} niet laden`);
  return response.json();
}

function normalizeStages(features) {
  return features
    .map((feature, index) => {
      const props = feature.properties || {};
      const coords = feature.geometry?.coordinates || [];
      return {
        id: props.id || `stage-${index + 1}`,
        name: props.name || `Plek ${index + 1}`,
        lon: Number(coords[0]),
        lat: Number(coords[1]),
        x: Number(props.pixelX),
        y: Number(props.pixelY),
      };
    })
    .filter((stage) => Number.isFinite(stage.lon) && Number.isFinite(stage.lat))
    .filter((stage) => !/ver?wilderij/i.test(stage.name));
}

function normalizeAreas(features) {
  return features
    .map((feature, index) => {
      const props = feature.properties || {};
      const title = String(props.title || `Gebied ${index + 1}`).trim();
      const text = String(props.text || title).trim();
      const pixelPoints = Array.isArray(props.pixelPoints) ? props.pixelPoints : [];
      return {
        id: props.id || `area-${index + 1}`,
        title,
        text,
        dim: title.toUpperCase() === "DIM" || text.toUpperCase() === "DIM",
        label: title.toUpperCase() === "DIM" ? textLabel(text) : text,
        category: areaCategory(title, text),
        points: pixelPoints
          .map((point) => ({ x: Number(point.x), y: Number(point.y) }))
          .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
      };
    })
    .filter((area) => area.points.length >= 3);
}

function renderAreas() {
  state.layers.dim.clearLayers();
  state.layers.labels.clearLayers();
  state.layers.pois.clearLayers();
  state.areaLabelMarkers.clear();

  for (const area of state.areas) {
    if (isPoiArea(area)) {
      renderAreaPoi(area);
      continue;
    }

    if (area.dim) createAreaPolygon(area, "ww-dim-pane", 0.76).addTo(state.layers.dim);
    if (!area.dim || area.label) renderAreaLabel(area);
  }
}

function createAreaPolygon(area, pane, opacity) {
  return Leaflet.polygon(area.points.map(pixelLatLng), {
    className: `area-shape is-${area.category}${area.dim ? " is-dim" : ""}`,
    color: "transparent",
    fillColor: areaFill(area),
    fillOpacity: opacity,
    interactive: false,
    pane,
    stroke: false,
    weight: 0,
  });
}

function renderAreaPoi(area) {
  const center = polygonCenter(area.points);
  const wide = /blijkt dat niemand/i.test(area.label || area.text || area.title);
  const label = area.label || area.text || area.title;
  const marker = Leaflet.marker(pixelLatLng(center), {
    icon: divIcon(`
      <span class="poi-marker is-${area.category}">!</span>
      <strong class="poi-label${wide ? " is-wide" : ""}" data-distance-target>${escapeHtml(label)}</strong>
    `),
    pane: "ww-label-pane",
    riseOnHover: true,
  }).addTo(state.layers.pois);

  marker.on("click", (event) => {
    Leaflet.DomEvent.stop(event.originalEvent);
    showPointDistance(marker, center);
  });
}

function renderAreaLabel(area) {
  const center = polygonCenter(area.points);
  const labelText = area.label || area.text || area.title;
  const html = area.dim
    ? `<span class="area-label is-dim-label">${escapeHtml(labelText)}</span>`
    : `<button class="area-label" type="button" data-area-id="${escapeHtml(area.id)}">
        <span class="area-label-tab">Gebied</span>
        <span class="area-label-body">${escapeHtml(labelText)}</span>
      </button>`;

  const marker = Leaflet.marker(pixelLatLng(center), {
    icon: divIcon(html),
    interactive: !area.dim,
    pane: "ww-label-pane",
    riseOnHover: true,
  }).addTo(state.layers.labels);

  state.areaLabelMarkers.set(area.id, marker);

  if (!area.dim) {
    marker.on("click", (event) => {
      Leaflet.DomEvent.stop(event.originalEvent);
      setActiveArea(area.id);
    });
  }

  requestAnimationFrame(() => fitAreaLabelTab(marker));
}

function fitAreaLabelTab(marker) {
  const element = marker.getElement();
  const tab = element?.querySelector(".area-label-tab");
  const body = element?.querySelector(".area-label-body");
  if (!tab || !body) return;
  body.style.minWidth = `${Math.ceil(tab.offsetWidth * 1.1)}px`;
}

function setActiveArea(id) {
  state.activeAreaId = state.activeAreaId === id ? null : id;
  state.layers.active.clearLayers();

  const activeArea = state.areas.find((area) => area.id === state.activeAreaId);
  if (activeArea && !activeArea.dim) {
    state.activeAreaLayer = createAreaPolygon(activeArea, "ww-active-area-pane", 0.72).addTo(state.layers.active);
  } else {
    state.activeAreaLayer = null;
  }

  for (const [areaId, marker] of state.areaLabelMarkers) {
    marker.getElement()?.querySelector(".area-label")?.classList.toggle("is-active", areaId === state.activeAreaId);
  }
}

function renderStages() {
  state.layers.stages.clearLayers();
  for (const stage of state.stages) {
    const point = stagePoint(stage);
    const marker = Leaflet.marker(pixelLatLng(point), {
      icon: divIcon(`
        <span class="stage-marker"></span>
        <strong class="stage-label" data-distance-target>${escapeHtml(stage.name)}</strong>
      `),
      pane: "ww-label-pane",
      riseOnHover: true,
    }).addTo(state.layers.stages);

    marker.on("click", (event) => {
      Leaflet.DomEvent.stop(event.originalEvent);
      showPointDistance(marker, point);
    });
  }
}

function toggleLocation() {
  if (state.locationWatch !== null) {
    navigator.geolocation.clearWatch(state.locationWatch);
    state.locationWatch = null;
    state.lastLocation = null;
    els.locateBtn.classList.remove("is-active");
    renderLocation();
    return;
  }

  if (!navigator.geolocation) {
    els.locateBtn.querySelector("span:last-child").textContent = "Geen GPS";
    return;
  }

  els.locateBtn.querySelector("span:last-child").textContent = "Zoeken...";
  els.locateBtn.classList.add("is-active");
  state.locationWatch = navigator.geolocation.watchPosition(
    (position) => {
      state.lastLocation = position;
      els.locateBtn.querySelector("span:last-child").textContent = `±${Math.round(position.coords.accuracy)} m`;
      renderLocation();
    },
    () => {
      els.locateBtn.querySelector("span:last-child").textContent = "Geweigerd";
      els.locateBtn.classList.remove("is-active");
      state.locationWatch = null;
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 },
  );
}

function renderLocation() {
  state.locationDot?.remove();
  state.accuracyCircle?.remove();
  state.locationDot = null;
  state.accuracyCircle = null;
  renderSharedPoint();

  if (!state.lastLocation || !state.metadata || !state.imageW) return;

  const { latitude, longitude, accuracy } = state.lastLocation.coords;
  const point = wgs84ToPixel(latitude, longitude);
  if (!insideMap(point.x, point.y)) {
    els.locateBtn.querySelector("span:last-child").textContent = "Buiten kaart";
    return;
  }

  state.accuracyCircle = Leaflet.circle(pixelLatLng(point), {
    className: "location-accuracy",
    color: "#2778ff",
    fillColor: "#2778ff",
    fillOpacity: 0.16,
    interactive: false,
    pane: "ww-location-pane",
    radius: Math.max(28, accuracy / MAP_SCALE_METERS),
    weight: 2,
  }).addTo(state.layers.location);

  state.locationDot = Leaflet.marker(pixelLatLng(point), {
    icon: divIcon('<span class="location-dot"></span>'),
    interactive: false,
    pane: "ww-location-pane",
  }).addTo(state.layers.location);

  centerOn(point);
}

function renderSharedPoint() {
  state.sharedMarker?.remove();
  state.sharedMarker = null;
  if (!state.sharedPoint || !state.map) return;

  state.sharedMarker = Leaflet.marker(pixelLatLng(state.sharedPoint), {
    icon: divIcon(`
      <span class="shared-pin-icon">📍</span>
      <strong class="shared-pin-label" data-distance-target>${escapeHtml(state.sharedPoint.label || "Gedeelde locatie")}</strong>
    `, "shared-pin"),
    pane: "ww-location-pane",
    riseOnHover: true,
  }).addTo(state.layers.location);

  state.sharedMarker.on("click", (event) => {
    Leaflet.DomEvent.stop(event.originalEvent);
    showSharedDistance();
  });
}

function showSharedDistance() {
  if (state.sharedPoint && state.sharedMarker) showPointDistance(state.sharedMarker, state.sharedPoint);
}

function showPointDistance(target, point) {
  if (!state.lastLocation) {
    setDistanceText(target, "Zet je locatie aan voor afstand");
    return;
  }

  const myPoint = wgs84ToPixel(state.lastLocation.coords.latitude, state.lastLocation.coords.longitude);
  const meters = Math.hypot(myPoint.x - point.x, myPoint.y - point.y) * MAP_SCALE_METERS;
  const minutes = Math.max(1, Math.round((meters / 250) * 60));
  setDistanceText(target, `${Math.round(meters)} m · ${minutes} min dwalen`);
}

function setDistanceText(target, text) {
  const element = typeof target.getElement === "function" ? target.getElement() : target;
  const textTarget = element?.querySelector("[data-distance-target]");
  if (textTarget) textTarget.textContent = text;
}

function restoreSharedLocation() {
  const params = new URLSearchParams(window.location.search);
  const encoded = params.get("loc");
  if (!encoded) return;

  const point = pointFromShareParam(encoded);
  if (!point || !insideMap(point.x, point.y)) return;
  state.sharedPoint = point;
  renderSharedPoint();
  centerOn(point);
}

function centerOn(point) {
  if (!state.map) return;
  const targetZoom = Number.isFinite(state.defaultZoom) ? state.defaultZoom + 0.85 : state.map.getMinZoom() + 1.6;
  const nextZoom = Math.max(state.map.getZoom(), targetZoom);
  state.map.setView(pixelLatLng(point), nextZoom, { animate: true });
}

function shareUrlForPoint(point) {
  const url = new URL("/share", window.location.origin);
  url.searchParams.set("loc", shareParamForPoint(point));
  return url.toString();
}

function shareParamForPoint(point) {
  const payload = {
    x: Math.round(point.x * 10) / 10,
    y: Math.round(point.y * 10) / 10,
  };
  if (point.label) payload.t = point.label.slice(0, 140);
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

function pointFromShareParam(value) {
  try {
    const data = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
    const point = { x: Number(data.x), y: Number(data.y), label: String(data.t || "").slice(0, 140) };
    return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
  } catch {
    return null;
  }
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function pixelLatLng(point) {
  return Leaflet.latLng(-point.y, point.x);
}

function mapPointFromLatLng(latlng) {
  return { x: latlng.lng, y: -latlng.lat };
}

function divIcon(html, className = "ww-div-icon") {
  return Leaflet.divIcon({
    className,
    html,
    iconAnchor: [0, 0],
    iconSize: [0, 0],
  });
}

function textLabel(value) {
  const text = String(value || "").trim();
  return text && text.toUpperCase() !== "DIM" ? text : "";
}

function isPoiArea(area) {
  const value = `${area.title} ${area.text}`.toLowerCase();
  return value.includes("zweefhut") || value.includes("lun-air") || polygonArea(area.points) <= state.poiAreaThreshold;
}

function poiAreaThreshold(areas) {
  const benchmark = areas.find((area) => {
    const value = `${area.title} ${area.text}`.toLowerCase();
    return value.includes("wc") && value.includes("douchen");
  });
  return benchmark ? polygonArea(benchmark.points) : 0;
}

function polygonArea(points) {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum / 2);
}

function polygonCenter(points) {
  const sum = points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function areaFill(area) {
  if (area.dim) return "#050505";
  if (area.category === "camping" || area.category === "wildlive") return "#ddacc0";
  if (area.category === "side") return "#a3c2cf";
  return "#fff8df";
}

function areaCategory(title, text) {
  const value = `${title} ${text}`.toLowerCase();
  if (title.toUpperCase() === "DIM" || text.toUpperCase() === "DIM") return "dim";
  if (/(campingwinkel|zweefhut|lun-air|wc|kakkerlakkencasino|luchtmixer|recyclepunt|straaljager|ehbo|no tent|vuurtorenstrand|niet wat|iets te doen)/.test(value)) {
    return "side";
  }
  if (/(camping|campers|tenten|vriendenvelden|accommodaties|huisjes)/.test(value)) return "camping";
  if (value.includes("wildlive")) return "wildlive";
  if (value.includes("verwilderij")) return "wildlive";
  return "side";
}

function stagePoint(stage) {
  if (Number.isFinite(stage.x) && Number.isFinite(stage.y)) return { x: stage.x, y: stage.y };
  return wgs84ToPixel(stage.lat, stage.lon);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function wgs84ToPixel(lat, lon) {
  const rd = wgs84ToRd(lat, lon);
  const axes = rdAxes();
  const dx = rd.x - axes.center.x;
  const dy = rd.y - axes.center.y;
  const det = axes.top.x * axes.side.y - axes.top.y * axes.side.x;
  const du = (dx * axes.side.y - dy * axes.side.x) / det;
  const dv = (axes.top.x * dy - axes.top.y * dx) / det;
  return {
    x: (du + 0.5) * (state.imageW - 1),
    y: (dv + 0.5) * (state.imageH - 1),
  };
}

function rdAxes() {
  const corners = state.metadata.rd_corners;
  const tl = rdPoint(corners.top_left);
  const tr = rdPoint(corners.top_right);
  const bl = rdPoint(corners.bottom_left);
  const br = rdPoint(corners.bottom_right);
  return {
    center: {
      x: (tl.x + tr.x + bl.x + br.x) / 4,
      y: (tl.y + tr.y + bl.y + br.y) / 4,
    },
    top: {
      x: (tr.x - tl.x + br.x - bl.x) / 2,
      y: (tr.y - tl.y + br.y - bl.y) / 2,
    },
    side: {
      x: (bl.x - tl.x + br.x - tr.x) / 2,
      y: (bl.y - tl.y + br.y - tr.y) / 2,
    },
  };
}

function rdPoint(pair) {
  return { x: pair[0], y: pair[1] };
}

function wgs84ToRd(lat, lon) {
  const lat0 = 52.1551744;
  const lon0 = 5.38720621;
  const dLat = 0.36 * (lat - lat0);
  const dLon = 0.36 * (lon - lon0);
  const xTerms = [
    [0, 1, 190094.945],
    [1, 1, -11832.228],
    [2, 1, -114.221],
    [0, 3, -32.391],
    [1, 0, -0.705],
    [3, 1, -2.34],
    [1, 3, -0.608],
    [0, 2, -0.008],
    [2, 3, 0.148],
  ];
  const yTerms = [
    [1, 0, 309056.544],
    [0, 2, 3638.893],
    [2, 0, 73.077],
    [1, 2, -157.984],
    [3, 0, 59.788],
    [0, 1, 0.433],
    [2, 2, -6.439],
    [1, 1, -0.032],
    [0, 4, 0.092],
    [1, 4, -0.054],
  ];

  return {
    x: 155000 + polynomial(xTerms, dLat, dLon),
    y: 463000 + polynomial(yTerms, dLat, dLon),
  };
}

function polynomial(terms, a, b) {
  return terms.reduce((sum, [pa, pb, coefficient]) => sum + coefficient * a ** pa * b ** pb, 0);
}

function insideMap(x, y) {
  return x >= 0 && y >= 0 && x <= state.imageW && y <= state.imageH;
}
