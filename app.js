const ASSET_VERSION = "30cm-areas-20260627";

const els = {
  viewport: document.querySelector("#viewport"),
  world: document.querySelector("#world"),
  image: document.querySelector("#mapImage"),
  areaLayer: document.querySelector("#areaLayer"),
  stageLayer: document.querySelector("#stageLayer"),
  locationLayer: document.querySelector("#locationLayer"),
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
  zoom: 1,
  panX: 0,
  panY: 0,
  pointer: null,
  locationWatch: null,
  lastLocation: null,
  activeAreaId: null,
  shareMode: null,
  sharedPoint: null,
};

init();

async function init() {
  bindEvents();
  const [metadata, stages, areas] = await Promise.all([
    fetchJson(`assets/map.metadata.json?v=${ASSET_VERSION}`),
    fetchJson(`assets/stages.geojson?v=${ASSET_VERSION}`),
    fetchJson(`assets/areas.geojson?v=${ASSET_VERSION}`),
    waitForImage(els.image),
  ]);

  state.metadata = metadata;
  state.stages = normalizeStages(stages.features || []);
  state.areas = normalizeAreas(areas.features || []);
  state.poiAreaThreshold = poiAreaThreshold(state.areas);
  state.imageW = els.image.naturalWidth;
  state.imageH = els.image.naturalHeight;

  els.world.style.width = `${state.imageW}px`;
  els.world.style.height = `${state.imageH}px`;
  els.areaLayer.setAttribute("viewBox", `0 0 ${state.imageW} ${state.imageH}`);

  fitMap();
  renderAreas();
  renderStages();
  restoreSharedLocation();
}

function bindEvents() {
  window.addEventListener("resize", fitMap);
  els.viewport.addEventListener("pointerdown", onPointerDown);
  els.viewport.addEventListener("pointermove", onPointerMove);
  els.viewport.addEventListener("pointerup", onPointerUp);
  els.viewport.addEventListener("pointercancel", onPointerUp);
  els.viewport.addEventListener("wheel", onWheel, { passive: false });
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
  els.zoomInBtn.addEventListener("click", () => zoomAtCenter(1.22));
  els.zoomOutBtn.addEventListener("click", () => zoomAtCenter(1 / 1.22));
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
}

function cancelSharePin() {
  state.shareMode = null;
  els.shareHint.hidden = true;
  els.viewport.classList.remove("is-placing-pin");
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

function waitForImage(image) {
  if (image.complete && image.naturalWidth) return Promise.resolve();
  return new Promise((resolve, reject) => {
    image.addEventListener("load", resolve, { once: true });
    image.addEventListener("error", reject, { once: true });
  });
}

function normalizeStages(features) {
  return features
    .map((feature, index) => {
      const props = feature.properties || {};
      const coords = feature.geometry?.coordinates || [];
      return {
        id: props.id || `stage-${index + 1}`,
        index: index + 1,
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

function fitMap() {
  if (!state.imageW || !state.imageH) return;
  const rect = els.viewport.getBoundingClientRect();
  const nextZoom = Math.max(rect.width / state.imageW, rect.height / state.imageH);
  state.zoom = clamp(nextZoom, 0.18, 8);
  state.panX = (rect.width - state.imageW * state.zoom) / 2;
  state.panY = (rect.height - state.imageH * state.zoom) / 2;
  applyTransform();
}

function applyTransform() {
  els.world.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
}

function zoomAtCenter(factor) {
  const rect = els.viewport.getBoundingClientRect();
  zoomAt(rect.width / 2, rect.height / 2, factor);
}

function zoomAt(viewportX, viewportY, factor) {
  const oldZoom = state.zoom;
  const nextZoom = clamp(oldZoom * factor, fitZoom() * 0.7, 12);
  const worldX = (viewportX - state.panX) / oldZoom;
  const worldY = (viewportY - state.panY) / oldZoom;
  state.zoom = nextZoom;
  state.panX = viewportX - worldX * nextZoom;
  state.panY = viewportY - worldY * nextZoom;
  applyTransform();
}

function fitZoom() {
  const rect = els.viewport.getBoundingClientRect();
  return Math.max(rect.width / state.imageW, rect.height / state.imageH);
}

function onWheel(event) {
  event.preventDefault();
  const rect = els.viewport.getBoundingClientRect();
  zoomAt(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1.12 : 1 / 1.12);
}

function onPointerDown(event) {
  if (event.target.closest(".area-label, .poi-label")) return;

  state.pointer = {
    id: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startPanX: state.panX,
    startPanY: state.panY,
  };
  els.viewport.classList.add("is-panning");
  safeSetPointerCapture(els.viewport, event.pointerId);
}

function onPointerMove(event) {
  if (!state.pointer || state.pointer.id !== event.pointerId) return;
  state.panX = state.pointer.startPanX + event.clientX - state.pointer.startClientX;
  state.panY = state.pointer.startPanY + event.clientY - state.pointer.startClientY;
  applyTransform();
}

function onPointerUp(event) {
  const pointer = state.pointer;
  if (state.pointer) safeReleasePointerCapture(els.viewport, event.pointerId);
  state.pointer = null;
  els.viewport.classList.remove("is-panning");

  if (state.shareMode === "pin" && pointer && pointer.id === event.pointerId) {
    const moved = Math.hypot(event.clientX - pointer.startClientX, event.clientY - pointer.startClientY);
    if (moved < 10) {
      cancelSharePin();
      showShareLink(viewportToWorld(event.clientX, event.clientY));
    }
  }
}

function safeSetPointerCapture(element, pointerId) {
  try {
    element.setPointerCapture?.(pointerId);
  } catch {}
}

function safeReleasePointerCapture(element, pointerId) {
  try {
    element.releasePointerCapture?.(pointerId);
  } catch {}
}

function renderAreas() {
  els.areaLayer.innerHTML = "";
  els.areaLayer.append(createFuzzyFilter());
  for (const area of state.areas) {
    if (isPoiArea(area)) {
      renderAreaPoi(area);
      continue;
    }

    const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    polygon.setAttribute("points", area.points.map((point) => `${point.x},${point.y}`).join(" "));
    polygon.classList.add("area-shape");
    polygon.classList.add(`is-${area.category}`);
    polygon.dataset.id = area.id;
    if (area.dim) polygon.classList.add("is-dim");
    els.areaLayer.append(polygon);

    if (!area.dim || area.label) renderAreaLabel(area);
  }
}

function createFuzzyFilter() {
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `
    <filter id="fuzzy-edge" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="20" result="blur"></feGaussianBlur>
      <feFlood flood-color="currentColor" flood-opacity="1" result="color"></feFlood>
      <feComposite in="color" in2="blur" operator="in" result="soft"></feComposite>
      <feMerge>
        <feMergeNode in="soft"></feMergeNode>
        <feMergeNode in="SourceGraphic"></feMergeNode>
      </feMerge>
    </filter>
  `;
  return defs;
}

function renderAreaPoi(area) {
  const center = polygonCenter(area.points);
  const marker = document.createElement("div");
  marker.className = `poi-marker is-${area.category}`;
  marker.textContent = "!";
  marker.style.left = `${center.x}px`;
  marker.style.top = `${center.y}px`;
  marker.addEventListener("click", (event) => {
    event.stopPropagation();
    showPointDistance(marker, center);
  });
  els.stageLayer.append(marker);

  const label = document.createElement("div");
  label.className = "poi-label";
  if (/blijkt dat niemand/i.test(area.label || area.text || area.title)) label.classList.add("is-wide");
  label.textContent = area.label || area.text || area.title;
  label.style.left = `${center.x}px`;
  label.style.top = `${center.y}px`;
  els.stageLayer.append(label);
}

function renderAreaLabel(area) {
  const center = polygonCenter(area.points);
  const label = document.createElement("div");
  label.className = `area-label${area.dim ? " is-dim-label" : ""}`;
  label.dataset.id = area.id;
  label.textContent = area.label || area.text || area.title;
  label.style.left = `${center.x}px`;
  label.style.top = `${center.y}px`;
  label.addEventListener("click", (event) => {
    event.stopPropagation();
    setActiveArea(area.id);
  });
  els.stageLayer.append(label);
}

function setActiveArea(id) {
  state.activeAreaId = state.activeAreaId === id ? null : id;
  for (const shape of els.areaLayer.querySelectorAll(".area-shape")) {
    shape.classList.toggle("is-active", shape.dataset.id === state.activeAreaId);
  }
  for (const label of els.stageLayer.querySelectorAll(".area-label")) {
    label.classList.toggle("is-active", label.dataset.id === state.activeAreaId);
  }
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

function renderStages() {
  for (const stage of state.stages) {
    const point = stagePoint(stage);
    const marker = document.createElement("div");
    marker.className = "stage-marker";
    marker.style.left = `${point.x}px`;
    marker.style.top = `${point.y}px`;
    els.stageLayer.append(marker);

    const label = document.createElement("div");
    label.className = "stage-label";
    label.textContent = stage.name;
    label.style.left = `${point.x}px`;
    label.style.top = `${point.y}px`;
    els.stageLayer.append(label);
  }
}

function polygonCenter(points) {
  const sum = points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function stagePoint(stage) {
  if (Number.isFinite(stage.x) && Number.isFinite(stage.y)) return { x: stage.x, y: stage.y };
  return wgs84ToPixel(stage.lat, stage.lon);
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
  els.locationLayer.querySelectorAll(".location-dot").forEach((node) => node.remove());
  renderSharedPoint();
  if (!state.lastLocation || !state.metadata || !state.imageW) return;

  const { latitude, longitude, accuracy } = state.lastLocation.coords;
  const point = wgs84ToPixel(latitude, longitude);
  if (!insideMap(point.x, point.y)) {
    els.locateBtn.querySelector("span:last-child").textContent = "Buiten kaart";
    return;
  }

  const dot = document.createElement("div");
  dot.className = "location-dot";
  dot.style.left = `${point.x}px`;
  dot.style.top = `${point.y}px`;
  dot.style.setProperty("--accuracy-radius", `${Math.max(28, accuracy / 0.3)}px`);
  els.locationLayer.append(dot);
  centerOn(point);
}

function renderSharedPoint() {
  els.locationLayer.querySelectorAll(".shared-pin").forEach((node) => node.remove());
  if (!state.sharedPoint) return;

  const pin = document.createElement("div");
  pin.className = "shared-pin";
  pin.style.left = `${state.sharedPoint.x}px`;
  pin.style.top = `${state.sharedPoint.y}px`;
  pin.innerHTML = `<span>📍</span><strong>${escapeHtml(state.sharedPoint.label || "Gedeelde locatie")}</strong>`;
  pin.addEventListener("click", () => showSharedDistance(pin));
  els.locationLayer.append(pin);
}

function showSharedDistance(pin) {
  if (state.sharedPoint) showPointDistance(pin, state.sharedPoint);
}

function showPointDistance(element, point) {
  if (!state.lastLocation) {
    setDistanceText(element, "Zet je locatie aan voor afstand");
    return;
  }

  const myPoint = wgs84ToPixel(state.lastLocation.coords.latitude, state.lastLocation.coords.longitude);
  const meters = Math.hypot(myPoint.x - point.x, myPoint.y - point.y) * 0.3;
  const minutes = Math.max(1, Math.round((meters / 250) * 60));
  setDistanceText(element, `${Math.round(meters)} m · ${minutes} min dwalen`);
}

function setDistanceText(element, text) {
  const target = element.querySelector("strong") || element;
  target.textContent = text;
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
  const rect = els.viewport.getBoundingClientRect();
  state.zoom = Math.max(state.zoom, fitZoom() * 1.6);
  state.panX = rect.width / 2 - point.x * state.zoom;
  state.panY = rect.height / 2 - point.y * state.zoom;
  applyTransform();
}

function viewportToWorld(clientX, clientY) {
  const rect = els.viewport.getBoundingClientRect();
  return {
    x: (clientX - rect.left - state.panX) / state.zoom,
    y: (clientY - rect.top - state.panY) / state.zoom,
  };
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
