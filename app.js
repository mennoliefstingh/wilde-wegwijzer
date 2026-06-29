const ASSET_VERSION = "30cm-areas-20260629-marktplaats";
const MAP_SCALE_METERS = 0.3;
const DESCRIPTION_MAX_LENGTH = 80;
const COMPACT_LABEL_LENGTH = 34;
const MAX_SHARED_PINS = 12;

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
  shareWhatsappBtn: document.querySelector("#shareWhatsappBtn"),
  pinsList: document.querySelector("#pinsList"),
  filterButtons: Array.from(document.querySelectorAll("[data-filter]")),
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
  filters: {
    stages: true,
    facilities: false,
    campings: false,
    info: true,
    festival: false,
  },
  locationWatch: null,
  lastLocation: null,
  locationHasCentered: false,
  locationDot: null,
  accuracyCircle: null,
  shareMode: null,
  shareClickHandler: null,
  sharedPins: [],
  sharedMarkers: new Map(),
};

init();
registerServiceWorker();

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
  renderMapFeatures();
  restoreSharedLocation();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const register = () => navigator.serviceWorker.register("/sw.js").catch(() => {});
  if (document.readyState === "complete") {
    register();
  } else {
    window.addEventListener("load", register, { once: true });
  }
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
    wheelPxPerZoomLevel: 36,
    zoomAnimation: true,
    zoomControl: false,
    zoomDelta: 0.5,
    zoomSnap: 0.25,
  });

  createPane("ww-image-pane", 200, "none");
  createPane("ww-dim-pane", 320, "none");
  createPane("ww-active-area-pane", 340, "none");
  createPane("ww-label-pane", 520, "auto");
  createPane("ww-location-pane", 650, "none");
  createPane("ww-shared-pane", 700, "auto");

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
  state.layers.facilities = Leaflet.layerGroup().addTo(state.map);
  state.layers.campings = Leaflet.layerGroup().addTo(state.map);
  state.layers.info = Leaflet.layerGroup().addTo(state.map);
  state.layers.stages = Leaflet.layerGroup().addTo(state.map);
  state.layers.location = Leaflet.layerGroup().addTo(state.map);
  state.layers.shared = Leaflet.layerGroup().addTo(state.map);

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
  els.shareWhatsappBtn.addEventListener("click", sharePinsToWhatsapp);
  for (const button of els.filterButtons) {
    button.addEventListener("click", () => toggleFilter(button.dataset.filter));
  }
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
  updateFilterButtons();
}

function openShare() {
  els.shareChoices.hidden = false;
  els.shareResult.hidden = state.sharedPins.length === 0;
  els.pinsList.hidden = state.sharedPins.length === 0;
  els.copyShareBtn.hidden = false;
  els.shareDescription.value = "";
  renderPinsList();
  updateShareUrl();
  els.shareModal.hidden = false;
}

function closeShare() {
  els.shareModal.hidden = true;
}

function toggleFilter(name) {
  if (!Object.prototype.hasOwnProperty.call(state.filters, name)) return;
  state.filters[name] = !state.filters[name];
  updateFilterButtons();
  renderMapFeatures();
}

function updateFilterButtons() {
  for (const button of els.filterButtons) {
    button.classList.toggle("is-active", Boolean(state.filters[button.dataset.filter]));
  }
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
    addSharedPin(point);
    els.shareModal.hidden = false;
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
    addSharedPin(wgs84ToPixel(state.lastLocation.coords.latitude, state.lastLocation.coords.longitude));
    return;
  }

  if (!navigator.geolocation) {
    showShareError("Geen GPS beschikbaar");
    return;
  }

  els.shareMyLocationBtn.textContent = "Zoeken...";
  navigator.geolocation.getCurrentPosition(
    (position) => {
      els.shareMyLocationBtn.textContent = "Mijn locatie toevoegen";
      addSharedPin(wgs84ToPixel(position.coords.latitude, position.coords.longitude));
    },
    () => {
      els.shareMyLocationBtn.textContent = "Mijn locatie toevoegen";
      showShareError("Locatie geweigerd");
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 },
  );
}

function showShareError(message) {
  els.shareChoices.hidden = false;
  els.shareResult.hidden = false;
  els.shareUrl.value = message;
  els.copyShareBtn.hidden = true;
}

function addSharedPin(point) {
  if (!insideMap(point.x, point.y)) {
    showShareError("Deze locatie valt buiten de kaart");
    return;
  }

  if (state.sharedPins.length >= MAX_SHARED_PINS) {
    showShareError(`Max ${MAX_SHARED_PINS} pins per link`);
    return;
  }

  state.sharedPins.push({
    id: `pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    x: Math.round(point.x * 10) / 10,
    y: Math.round(point.y * 10) / 10,
    label: els.shareDescription.value.trim().slice(0, DESCRIPTION_MAX_LENGTH),
  });
  els.shareDescription.value = "";
  renderSharedPins();
  renderPinsList();
  els.shareChoices.hidden = false;
  els.shareResult.hidden = false;
  els.pinsList.hidden = false;
  els.copyShareBtn.hidden = false;
  updateShareUrl();
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

async function sharePinsToWhatsapp() {
  updateShareUrl();
  const url = els.shareUrl.value;
  const text = `Pins op Wilde Wegwijzer: ${url}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: "Wilde Wegwijzer pins", text, url });
      return;
    } catch {}
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
}

function renderPinsList() {
  els.pinsList.innerHTML = "";
  if (state.sharedPins.length === 0) {
    els.pinsList.hidden = true;
    return;
  }

  els.pinsList.hidden = false;
  for (const pin of state.sharedPins) {
    const row = document.createElement("div");
    row.className = "pin-row";
    const label = pin.label || "Pin zonder naam";
    row.innerHTML = `<span>${escapeHtml(label)}</span><button type="button" aria-label="Pin verwijderen">×</button>`;
    row.querySelector("button").addEventListener("click", () => removeSharedPin(pin.id));
    els.pinsList.append(row);
  }
}

function removeSharedPin(id) {
  state.sharedPins = state.sharedPins.filter((pin) => pin.id !== id);
  renderSharedPins();
  renderPinsList();
  updateShareUrl();
  els.shareResult.hidden = state.sharedPins.length === 0;
}

function updateShareUrl() {
  els.shareUrl.value = state.sharedPins.length ? shareUrlForPins(state.sharedPins) : "";
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

function renderMapFeatures() {
  renderAreas();
  renderStages();
}

function renderAreas() {
  state.layers.dim.clearLayers();
  state.layers.facilities.clearLayers();
  state.layers.campings.clearLayers();
  state.layers.info.clearLayers();
  state.layers.active.clearLayers();
  state.activeAreaId = null;
  state.activeAreaLayer = null;
  state.areaLabelMarkers.clear();

  for (const area of state.areas) {
    const kind = areaKind(area);

    if (area.dim) {
      if (state.filters.festival) {
        createAreaPolygon(area, "ww-dim-pane", 0.76).addTo(state.layers.dim);
        if (area.label) renderAreaLabel(area, state.layers.dim, "dim");
      }
      continue;
    }

    if (!filterVisible(kind)) continue;

    if (isPoiArea(area) || kind === "facility" || kind === "info") {
      renderAreaPoi(area, layerForKind(kind), kind);
      continue;
    }

    renderAreaLabel(area, layerForKind(kind), kind);
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

function renderAreaPoi(area, layer, kind) {
  const center = polygonCenter(area.points);
  const wide = /blijkt dat niemand/i.test(area.label || area.text || area.title);
  const label = area.label || area.text || area.title;
  const marker = Leaflet.marker(pixelLatLng(center), {
    icon: divIcon(pointHtml({
      markerClass: `poi-marker is-${area.category} is-${kind}`,
      labelClass: `poi-label${wide ? " is-wide" : ""}`,
      icon: poiIcon(kind, label),
      label,
    })),
    pane: "ww-label-pane",
    riseOnHover: true,
  }).addTo(layer);
  marker.wwMeta = { point: center, label, compact: compactLabel(label) };

  marker.on("click", (event) => {
    Leaflet.DomEvent.stop(event.originalEvent);
    togglePointMarker(marker);
  });
}

function renderAreaLabel(area, layer, kind) {
  const center = polygonCenter(area.points);
  const labelText = area.label || area.text || area.title;
  const compact = compactLabel(labelText, 46);
  const html = area.dim
    ? `<span class="area-label is-dim-label">${escapeHtml(labelText)}</span>`
    : `<button class="area-label" type="button" data-area-id="${escapeHtml(area.id)}">
        <span class="area-label-tab">Gebied</span>
        <span class="area-label-body">${escapeHtml(compact)}</span>
      </button>`;

  const marker = Leaflet.marker(pixelLatLng(center), {
    icon: divIcon(html),
    interactive: !area.dim,
    pane: "ww-label-pane",
    riseOnHover: true,
  }).addTo(layer);
  marker.wwMeta = { label: labelText, compact, kind };

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
    const isActive = areaId === state.activeAreaId;
    const element = marker.getElement();
    element?.querySelector(".area-label")?.classList.toggle("is-active", isActive);
    const body = element?.querySelector(".area-label-body");
    if (body && marker.wwMeta) body.textContent = isActive ? marker.wwMeta.label : marker.wwMeta.compact;
  }
}

function renderStages() {
  state.layers.stages.clearLayers();
  if (!state.filters.stages) return;
  for (const stage of state.stages) {
    const point = stagePoint(stage);
    const marker = Leaflet.marker(pixelLatLng(point), {
      icon: divIcon(pointHtml({
        markerClass: "stage-marker",
        labelClass: "stage-label",
        icon: "",
        label: stage.name,
      })),
      pane: "ww-label-pane",
      riseOnHover: true,
    }).addTo(state.layers.stages);
    marker.wwMeta = { point, label: stage.name, compact: compactLabel(stage.name, 28) };

    marker.on("click", (event) => {
      Leaflet.DomEvent.stop(event.originalEvent);
      togglePointMarker(marker);
    });
  }
}

function toggleLocation() {
  if (state.locationWatch !== null) {
    navigator.geolocation.clearWatch(state.locationWatch);
    state.locationWatch = null;
    state.lastLocation = null;
    state.locationHasCentered = false;
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
  state.locationHasCentered = false;
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
      state.locationHasCentered = false;
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 },
  );
}

function renderLocation() {
  state.locationDot?.remove();
  state.accuracyCircle?.remove();
  state.locationDot = null;
  state.accuracyCircle = null;

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

  if (!state.locationHasCentered) {
    state.locationHasCentered = true;
    centerOn(point);
  }
}

function renderSharedPins() {
  state.layers.shared.clearLayers();
  state.sharedMarkers.clear();
  if (!state.sharedPins.length || !state.map) return;

  for (const pin of state.sharedPins) {
    const marker = Leaflet.marker(pixelLatLng(pin), {
      icon: divIcon(pointHtml({
        markerClass: "shared-pin-icon",
        labelClass: "shared-pin-label",
        icon: "📍",
        label: pin.label || "Gedeelde pin",
      }), "shared-pin"),
      pane: "ww-shared-pane",
      riseOnHover: true,
    }).addTo(state.layers.shared);
    marker.wwMeta = { point: pin, label: pin.label || "Gedeelde pin", compact: compactLabel(pin.label || "Gedeelde pin", 28) };
    state.sharedMarkers.set(pin.id, marker);

    marker.on("click", (event) => {
      Leaflet.DomEvent.stop(event.originalEvent);
      togglePointMarker(marker);
    });
  }
}

function togglePointMarker(marker) {
  const element = marker.getElement();
  const meta = marker.wwMeta;
  if (!element || !meta) return;
  const expanded = !element.classList.contains("is-expanded");
  element.classList.toggle("is-expanded", expanded);

  const label = element.querySelector("[data-label-text]");
  if (label) label.textContent = expanded ? meta.label : meta.compact;

  const distance = element.querySelector("[data-distance]");
  if (distance) distance.textContent = expanded ? distanceText(meta.point) : "";
}

function distanceText(point) {
  if (!state.lastLocation) return "Zet je locatie aan voor afstand";
  const myPoint = wgs84ToPixel(state.lastLocation.coords.latitude, state.lastLocation.coords.longitude);
  const meters = Math.hypot(myPoint.x - point.x, myPoint.y - point.y) * MAP_SCALE_METERS;
  const minutes = Math.max(1, Math.round((meters / 250) * 60));
  return `${Math.round(meters)} m · ${minutes} min dwalen`;
}

function restoreSharedLocation() {
  const params = new URLSearchParams(window.location.search);
  const pinsParam = params.get("pins");
  if (pinsParam) {
    state.sharedPins = pinsFromShareParam(pinsParam);
  } else {
    state.sharedPins = params
      .getAll("loc")
      .map(pointFromShareParam)
      .filter((point) => point && insideMap(point.x, point.y))
      .map((point, index) => ({ ...point, id: `shared-${index + 1}` }));
  }

  if (!state.sharedPins.length) return;
  renderSharedPins();
  focusSharedPins();
}

function centerOn(point, zoomBoost = 0.85) {
  if (!state.map) return;
  const targetZoom = Number.isFinite(state.defaultZoom) ? state.defaultZoom + zoomBoost : state.map.getMinZoom() + 1.6;
  const nextZoom = Math.max(state.map.getZoom(), targetZoom);
  state.map.setView(pixelLatLng(point), nextZoom, { animate: true });
}

function focusSharedPins() {
  if (state.sharedPins.length === 1) {
    centerOn(state.sharedPins[0], 1.9);
    return;
  }

  const bounds = Leaflet.latLngBounds(state.sharedPins.map(pixelLatLng));
  state.map.fitBounds(bounds, { animate: true, maxZoom: Number.isFinite(state.defaultZoom) ? state.defaultZoom + 1.6 : 2, padding: [72, 72] });
}

function shareUrlForPins(pins) {
  const url = new URL("/share", window.location.origin);
  url.searchParams.set("pins", shareParamForPins(pins));
  return url.toString();
}

function shareParamForPins(pins) {
  const payload = {
    v: 1,
    p: pins.slice(0, MAX_SHARED_PINS).map((pin) => ({
      x: Math.round(pin.x * 10) / 10,
      y: Math.round(pin.y * 10) / 10,
      ...(pin.label ? { t: pin.label.slice(0, DESCRIPTION_MAX_LENGTH) } : {}),
    })),
  };
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

function pointFromShareParam(value) {
  try {
    const data = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
    const point = { x: Number(data.x), y: Number(data.y), label: String(data.t || "").slice(0, DESCRIPTION_MAX_LENGTH) };
    return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
  } catch {
    return null;
  }
}

function pinsFromShareParam(value) {
  try {
    const data = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
    const rawPins = Array.isArray(data.p) ? data.p : [];
    return rawPins
      .slice(0, MAX_SHARED_PINS)
      .map((pin, index) => ({
        id: `shared-${index + 1}`,
        x: Number(pin.x),
        y: Number(pin.y),
        label: String(pin.t || "").slice(0, DESCRIPTION_MAX_LENGTH),
      }))
      .filter((pin) => Number.isFinite(pin.x) && Number.isFinite(pin.y) && insideMap(pin.x, pin.y));
  } catch {
    return [];
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

function filterVisible(kind) {
  if (kind === "stage") return state.filters.stages;
  if (kind === "facility") return state.filters.facilities;
  if (kind === "camping") return state.filters.campings;
  if (kind === "info") return state.filters.info;
  return true;
}

function layerForKind(kind) {
  if (kind === "camping") return state.layers.campings;
  if (kind === "info") return state.layers.info;
  return state.layers.facilities;
}

function areaKind(area) {
  const value = `${area.title} ${area.text}`.toLowerCase();
  if (area.dim) return "dim";
  if (area.title.toUpperCase() === "INFO") return "info";
  if (/(brandnetel|marktplaats|niemand zat te wachten|precies die camping|ik gok|hier ook niet|niet wat|no tent left behind)/.test(value)) return "info";
  if (/(camping|campers|tenten|vriendenvelden|accommodaties|huisjes)/.test(value)) return "camping";
  return "facility";
}

function isPoiArea(area) {
  const value = `${area.title} ${area.text}`.toLowerCase();
  return (
    value.includes("zweefhut") ||
    value.includes("lun-air") ||
    value.includes("luchtmixer") ||
    value.includes("helicopter") ||
    value.includes("helicopteeer") ||
    value.includes("straaljager") ||
    polygonArea(area.points) <= state.poiAreaThreshold
  );
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

function pointHtml({ markerClass, labelClass, icon, label }) {
  const compact = compactLabel(label);
  const labelClasses = `${labelClass}${isMultilineLabel(compact) ? " is-multiline" : ""}`;
  return `
    <span class="${markerClass}">${escapeHtml(icon)}</span>
    <strong class="${labelClasses}" data-label>
      <span data-label-text>${escapeHtml(compact)}</span>
      <small class="distance-line" data-distance></small>
    </strong>
  `;
}

function compactLabel(value, maxLength = COMPACT_LABEL_LENGTH) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text || "Pin";
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function isMultilineLabel(value) {
  const text = String(value || "");
  return text.includes("\n") || text.length > 18;
}

function poiIcon(kind, label) {
  const value = String(label || "").toLowerCase();
  if (kind === "info") return "!";
  if (value.includes("wc")) return "WC";
  if (value.includes("eten")) return "E";
  if (value.includes("ehbo")) return "+";
  if (value.includes("lucht") || value.includes("helic")) return "🚁";
  if (value.includes("straaljager")) return "✈";
  return "!";
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
