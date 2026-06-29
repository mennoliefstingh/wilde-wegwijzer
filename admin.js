const Leaflet = window.L;

const els = {
  loginPanel: document.querySelector("#loginPanel"),
  loginForm: document.querySelector("#loginForm"),
  adminPassword: document.querySelector("#adminPassword"),
  loginStatus: document.querySelector("#loginStatus"),
  workbench: document.querySelector("#adminWorkbench"),
  logoutBtn: document.querySelector("#logoutBtn"),
  map: document.querySelector("#adminMap"),
  newPointBtn: document.querySelector("#newPointBtn"),
  newAreaBtn: document.querySelector("#newAreaBtn"),
  finishAreaBtn: document.querySelector("#finishAreaBtn"),
  drawHint: document.querySelector("#drawHint"),
  featureForm: document.querySelector("#featureForm"),
  featureId: document.querySelector("#featureId"),
  featureTitle: document.querySelector("#featureTitle"),
  featureText: document.querySelector("#featureText"),
  featureType: document.querySelector("#featureType"),
  mapKind: document.querySelector("#mapKind"),
  displayKind: document.querySelector("#displayKind"),
  styleCategory: document.querySelector("#styleCategory"),
  pixelX: document.querySelector("#pixelX"),
  pixelY: document.querySelector("#pixelY"),
  pixelPoints: document.querySelector("#pixelPoints"),
  isVisible: document.querySelector("#isVisible"),
  isDim: document.querySelector("#isDim"),
  deleteFeatureBtn: document.querySelector("#deleteFeatureBtn"),
  featureList: document.querySelector("#featureList"),
  publicPinList: document.querySelector("#publicPinList"),
};

const state = {
  metadata: null,
  features: [],
  publicPins: [],
  map: null,
  bounds: null,
  featureLayer: null,
  pinLayer: null,
  draftLayer: null,
  drawMode: null,
  draftPoints: [],
  selectedFeatureId: null,
};

init();

function init() {
  els.loginForm.addEventListener("submit", login);
  els.logoutBtn.addEventListener("click", logout);
  els.newPointBtn.addEventListener("click", startNewPoint);
  els.newAreaBtn.addEventListener("click", startNewArea);
  els.finishAreaBtn.addEventListener("click", finishArea);
  els.featureForm.addEventListener("submit", saveFeature);
  els.deleteFeatureBtn.addEventListener("click", deleteFeature);
  loadAdmin();
}

async function login(event) {
  event.preventDefault();
  els.loginStatus.textContent = "Even kijken...";
  const response = await api("/api/admin/login", {
    method: "POST",
    body: { password: els.adminPassword.value },
    allowError: true,
  });
  if (!response.ok) {
    els.loginStatus.textContent = response.data?.error || "Inloggen mislukt";
    return;
  }
  els.adminPassword.value = "";
  await loadAdmin();
}

async function logout() {
  await api("/api/admin/logout", { method: "POST", allowError: true });
  els.workbench.hidden = true;
  els.loginPanel.hidden = false;
}

async function loadAdmin() {
  const [bootstrap, featuresResponse, pinsResponse] = await Promise.all([
    api("/api/bootstrap"),
    api("/api/admin/features", { allowError: true }),
    api("/api/admin/public-pins", { allowError: true }),
  ]);

  if (!featuresResponse.ok) {
    els.loginPanel.hidden = false;
    els.workbench.hidden = true;
    return;
  }

  state.metadata = bootstrap.data.metadata;
  state.features = featuresResponse.data.features || [];
  state.publicPins = pinsResponse.data?.pins || [];
  els.loginPanel.hidden = true;
  els.workbench.hidden = false;
  initMap();
  renderAll();
}

function initMap() {
  if (state.map) {
    state.map.invalidateSize();
    return;
  }
  const [imageW, imageH] = state.metadata.output_size_pixels;
  state.bounds = Leaflet.latLngBounds(pixelLatLng({ x: 0, y: imageH }), pixelLatLng({ x: imageW, y: 0 }));
  state.map = Leaflet.map(els.map, {
    attributionControl: false,
    crs: Leaflet.CRS.Simple,
    minZoom: -8,
    zoomControl: true,
  });
  Leaflet.imageOverlay("assets/map.webp?v=stateful-20260629", state.bounds, { interactive: false }).addTo(state.map);
  state.featureLayer = Leaflet.layerGroup().addTo(state.map);
  state.pinLayer = Leaflet.layerGroup().addTo(state.map);
  state.draftLayer = Leaflet.layerGroup().addTo(state.map);
  state.map.fitBounds(state.bounds, { animate: false, padding: [20, 20] });
  state.map.on("click", handleMapClick);
}

function renderAll() {
  renderFeatureList();
  renderPublicPinList();
  renderMap();
}

function renderMap() {
  state.featureLayer.clearLayers();
  state.pinLayer.clearLayers();
  state.draftLayer.clearLayers();

  for (const feature of state.features) {
    if (!feature.isVisible) continue;
    if (feature.featureType === "area" && feature.displayKind === "area" && feature.pixelPoints?.length >= 3) {
      const polygon = Leaflet.polygon(feature.pixelPoints.map(pixelLatLng), {
        color: "#050505",
        fillColor: colorForFeature(feature),
        fillOpacity: feature.isDim ? 0.45 : 0.25,
        weight: 2,
      }).addTo(state.featureLayer);
      polygon.on("click", () => selectFeature(feature.id));
    }

    const center = featureCenter(feature);
    if (center) {
      const marker = Leaflet.marker(pixelLatLng(center), {
        icon: Leaflet.divIcon({
          className: "admin-map-label",
          html: `<span>${escapeHtml(feature.title)}</span>`,
          iconAnchor: [0, 0],
          iconSize: [0, 0],
        }),
      }).addTo(state.featureLayer);
      marker.on("click", () => selectFeature(feature.id));
    }
  }

  for (const pin of state.publicPins.filter((item) => item.isVisible)) {
    const marker = Leaflet.marker(pixelLatLng(pin), {
      icon: Leaflet.divIcon({
        className: "admin-map-public-pin",
        html: `<span>📌</span><strong>${escapeHtml(pin.label || "Publieke pin")}</strong>`,
        iconAnchor: [0, 0],
        iconSize: [0, 0],
      }),
    }).addTo(state.pinLayer);
    marker.on("click", () => selectPublicPin(pin.id));
  }

  renderDraft();
}

function renderFeatureList() {
  els.featureList.innerHTML = "";
  for (const feature of state.features) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `admin-list-item${feature.id === state.selectedFeatureId ? " is-active" : ""}`;
    button.innerHTML = `<strong>${escapeHtml(feature.title)}</strong><span>${escapeHtml(feature.mapKind)} · ${escapeHtml(feature.displayKind)}</span>`;
    button.addEventListener("click", () => selectFeature(feature.id));
    els.featureList.append(button);
  }
}

function renderPublicPinList() {
  els.publicPinList.innerHTML = "";
  if (!state.publicPins.length) {
    els.publicPinList.textContent = "Nog geen publieke pins.";
    return;
  }
  for (const pin of state.publicPins) {
    const row = document.createElement("div");
    row.className = "admin-pin-row";
    row.innerHTML = `<span>${escapeHtml(pin.label || "Publieke pin")}</span><button type="button">Verwijder</button>`;
    row.querySelector("button").addEventListener("click", () => deletePublicPin(pin.id));
    els.publicPinList.append(row);
  }
}

function selectFeature(id) {
  const feature = state.features.find((item) => item.id === id);
  if (!feature) return;
  state.selectedFeatureId = id;
  state.drawMode = null;
  state.draftPoints = [];
  els.featureId.value = feature.id;
  els.featureTitle.value = feature.title || "";
  els.featureText.value = feature.text || "";
  els.featureType.value = feature.featureType || "area";
  els.mapKind.value = feature.mapKind || "facility";
  els.displayKind.value = feature.displayKind || "point";
  els.styleCategory.value = feature.styleCategory || "side";
  els.pixelX.value = numberValue(feature.pixelX);
  els.pixelY.value = numberValue(feature.pixelY);
  els.pixelPoints.value = JSON.stringify(feature.pixelPoints || [], null, 2);
  els.isVisible.checked = feature.isVisible !== false;
  els.isDim.checked = Boolean(feature.isDim);
  els.finishAreaBtn.hidden = true;
  els.drawHint.textContent = "";
  renderFeatureList();
  renderMap();
}

function selectPublicPin(id) {
  const pin = state.publicPins.find((item) => item.id === id);
  if (!pin) return;
  els.drawHint.textContent = `Publieke pin: ${pin.label || "zonder tekst"} (${Math.round(pin.x)}, ${Math.round(pin.y)})`;
}

function startNewPoint() {
  clearFeatureForm();
  els.featureTitle.value = "Nieuwe POI";
  els.featureType.value = "area";
  els.mapKind.value = "facility";
  els.displayKind.value = "point";
  els.styleCategory.value = "side";
  state.drawMode = "point";
  state.draftPoints = [];
  els.finishAreaBtn.hidden = true;
  els.drawHint.textContent = "Klik op de kaart om de POI te plaatsen.";
}

function startNewArea() {
  clearFeatureForm();
  els.featureTitle.value = "Nieuw gebied";
  els.featureType.value = "area";
  els.mapKind.value = "camping";
  els.displayKind.value = "area";
  els.styleCategory.value = "camping";
  state.drawMode = "area";
  state.draftPoints = [];
  els.finishAreaBtn.hidden = false;
  els.drawHint.textContent = "Klik punten rond het gebied. Druk daarna op Gebied klaar.";
  renderDraft();
}

function handleMapClick(event) {
  if (!state.drawMode) return;
  const point = mapPointFromLatLng(event.latlng);
  if (state.drawMode === "point") {
    els.pixelX.value = point.x.toFixed(1);
    els.pixelY.value = point.y.toFixed(1);
    els.drawHint.textContent = "Punt staat klaar. Vul tekst in en druk Opslaan.";
    state.drawMode = null;
    return;
  }
  state.draftPoints.push({ x: round1(point.x), y: round1(point.y) });
  els.pixelPoints.value = JSON.stringify(state.draftPoints, null, 2);
  els.drawHint.textContent = `${state.draftPoints.length} punten gezet.`;
  renderDraft();
}

function finishArea() {
  if (state.draftPoints.length < 3) {
    els.drawHint.textContent = "Minstens 3 punten nodig.";
    return;
  }
  els.pixelPoints.value = JSON.stringify(state.draftPoints, null, 2);
  state.drawMode = null;
  els.finishAreaBtn.hidden = true;
  els.drawHint.textContent = "Gebied staat klaar. Vul tekst in en druk Opslaan.";
}

function renderDraft() {
  state.draftLayer.clearLayers();
  if (!state.draftPoints.length) return;
  Leaflet.polyline(state.draftPoints.map(pixelLatLng), {
    color: "#c59d4e",
    dashArray: "5 5",
    weight: 3,
  }).addTo(state.draftLayer);
  for (const point of state.draftPoints) {
    Leaflet.circleMarker(pixelLatLng(point), {
      radius: 4,
      color: "#050505",
      fillColor: "#c59d4e",
      fillOpacity: 1,
      weight: 2,
    }).addTo(state.draftLayer);
  }
}

async function saveFeature(event) {
  event.preventDefault();
  const id = els.featureId.value;
  const payload = formPayload();
  const response = await api(id ? `/api/admin/features/${encodeURIComponent(id)}` : "/api/admin/features", {
    method: id ? "PATCH" : "POST",
    body: payload,
    allowError: true,
  });
  if (!response.ok) {
    els.drawHint.textContent = response.data?.error || "Opslaan mislukt";
    return;
  }
  const feature = response.data.feature;
  const index = state.features.findIndex((item) => item.id === feature.id);
  if (index >= 0) state.features[index] = feature;
  else state.features.push(feature);
  selectFeature(feature.id);
  els.drawHint.textContent = "Opgeslagen.";
}

async function deleteFeature() {
  const id = els.featureId.value;
  if (!id) return;
  const response = await api(`/api/admin/features/${encodeURIComponent(id)}`, { method: "DELETE", allowError: true });
  if (!response.ok) {
    els.drawHint.textContent = "Verwijderen mislukt";
    return;
  }
  state.features = state.features.filter((feature) => feature.id !== id);
  clearFeatureForm();
  renderAll();
}

async function deletePublicPin(id) {
  const response = await api(`/api/admin/public-pins/${encodeURIComponent(id)}`, { method: "DELETE", allowError: true });
  if (!response.ok) return;
  state.publicPins = state.publicPins.filter((pin) => pin.id !== id);
  renderAll();
}

function formPayload() {
  return {
    title: els.featureTitle.value,
    text: els.featureText.value,
    featureType: els.featureType.value,
    mapKind: els.mapKind.value,
    displayKind: els.displayKind.value,
    styleCategory: els.styleCategory.value,
    pixelX: els.pixelX.value || null,
    pixelY: els.pixelY.value || null,
    pixelPoints: parseJson(els.pixelPoints.value, []),
    isVisible: els.isVisible.checked,
    isDim: els.isDim.checked,
  };
}

function clearFeatureForm() {
  state.selectedFeatureId = null;
  els.featureForm.reset();
  els.featureId.value = "";
  els.isVisible.checked = true;
  els.isDim.checked = false;
  els.pixelPoints.value = "[]";
  renderFeatureList();
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok && !options.allowError) throw new Error(data?.error || "Request mislukt");
  return { ok: response.ok, status: response.status, data };
}

function featureCenter(feature) {
  if (Number.isFinite(Number(feature.pixelX)) && Number.isFinite(Number(feature.pixelY))) {
    return { x: Number(feature.pixelX), y: Number(feature.pixelY) };
  }
  const points = feature.pixelPoints || [];
  if (!points.length) return null;
  return {
    x: points.reduce((sum, point) => sum + Number(point.x), 0) / points.length,
    y: points.reduce((sum, point) => sum + Number(point.y), 0) / points.length,
  };
}

function colorForFeature(feature) {
  if (feature.isDim || feature.mapKind === "dim") return "#050505";
  if (feature.styleCategory === "camping" || feature.styleCategory === "wildlive") return "#ddacc0";
  if (feature.styleCategory === "stage") return "#ddacc0";
  return "#a3c2cf";
}

function pixelLatLng(point) {
  return Leaflet.latLng(-Number(point.y), Number(point.x));
}

function mapPointFromLatLng(latlng) {
  return { x: round1(latlng.lng), y: round1(-latlng.lat) };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function numberValue(value) {
  return Number.isFinite(Number(value)) ? String(Math.round(Number(value) * 10) / 10) : "";
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
