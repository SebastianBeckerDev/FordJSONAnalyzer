/* Offline Ford location and charging timeline. Requires no network resources. */
(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const DAY_MS = 86400000;

  function finite(value) {
    if (value === "" || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function validPosition(lat, lon) {
    return lat !== null && lon !== null && lat >= -85 && lat <= 85 && lon >= -180 && lon <= 180;
  }

  function mercX(lon) { return (lon + 180) / 360; }

  function mercY(lat) {
    const radians = Math.max(-85, Math.min(85, lat)) * Math.PI / 180;
    return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
  }

  function coordinateLabel(lat, lon) {
    const ns = lat < 0 ? "S" : "N";
    const ew = lon < 0 ? "W" : "E";
    return "≈ " + Math.abs(lat).toFixed(1) + "° " + ns + " · " + Math.abs(lon).toFixed(1) + "° " + ew;
  }

  function areaCoordinate(value) {
    const rounded = Math.round(value * 10) / 10;
    return Object.is(rounded, -0) ? 0 : rounded;
  }

  function areaFor(lat, lon) {
    const areaLat = areaCoordinate(lat);
    const areaLon = areaCoordinate(lon);
    return { key: areaLat.toFixed(1) + "," + areaLon.toFixed(1), lat: areaLat, lon: areaLon };
  }

  function svgElement(name, attributes) {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes || {})) element.setAttribute(key, String(value));
    return element;
  }

  function geographyPath(polygons) {
    const parts = [];
    for (const polygon of polygons || []) {
      for (const ring of polygon || []) {
        if (!Array.isArray(ring) || !ring.length) continue;
        for (let i = 0; i < ring.length; i++) {
          const coordinate = ring[i];
          if (!Array.isArray(coordinate) || coordinate.length < 2) continue;
          const lon = finite(coordinate[0]);
          const lat = finite(coordinate[1]);
          if (!validPosition(lat, lon)) continue;
          parts.push((i ? "L" : "M") + mercX(lon).toFixed(7) + "," + mercY(lat).toFixed(7));
        }
        parts.push("Z");
      }
    }
    return parts.join("");
  }

  function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }

  function formatDuration(start, end) {
    if (!Number.isFinite(end) || end < start) return "Unknown";
    const minutes = Math.round((end - start) / 60000);
    const hours = Math.floor(minutes / 60);
    return hours ? hours + " h " + String(minutes % 60).padStart(2, "0") + " min" : minutes + " min";
  }

  function formatGap(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "Same instant";
    if (milliseconds < 60000) return Math.max(1, Math.round(milliseconds / 1000)) + " sec";
    if (milliseconds < 3600000) return Math.round(milliseconds / 60000) + " min";
    if (milliseconds < 2 * DAY_MS) return (milliseconds / 3600000).toFixed(1) + " h";
    return (milliseconds / DAY_MS).toFixed(1) + " days";
  }

  function makeFormatter(timezone, options) {
    try { return new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: timezone }, options)); }
    catch (_error) { return new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: "UTC" }, options)); }
  }

  function normalizeGps(input) {
    const result = [];
    for (const row of Array.isArray(input) ? input : []) {
      const t = finite(row && row.t);
      const lat = finite(row && row.lat);
      const lon = finite(row && row.lon);
      if (t === null || !Number.isFinite(new Date(t).getTime()) || !validPosition(lat, lon)) continue;
      const area = areaFor(lat, lon);
      result.push({ kind: "gps", t, lat, lon, vehicleIndex: finite(row.vehicleIndex) || 1,
        count: Math.max(1, Math.round(finite(row.count) || 1)), area: area.key });
    }
    result.sort((a, b) => a.t - b.t || a.lat - b.lat || a.lon - b.lon);
    return result;
  }

  function normalizeCharges(input) {
    const result = [];
    for (const row of Array.isArray(input) ? input : []) {
      const start = finite(row && row.start);
      const type = String(row && row.type || "").toUpperCase();
      if (start === null || !Number.isFinite(new Date(start).getTime()) || (type !== "AC" && type !== "DC")) continue;
      const end = finite(row.end);
      const lat = finite(row.lat);
      const lon = finite(row.lon);
      const mapped = validPosition(lat, lon);
      result.push({
        kind: "charge", t: start, start, vehicleIndex: finite(row.vehicleIndex) || 1,
        end: end !== null && end >= start && Number.isFinite(new Date(end).getTime()) ? end : null,
        type, endStatus: String(row.endStatus || ""), lat: mapped ? lat : null, lon: mapped ? lon : null,
        area: mapped ? areaFor(lat, lon).key : null,
        gpsOffsetSeconds: finite(row.gpsOffsetSeconds),
        startSoc: finite(row.startSoc), endSoc: finite(row.endSoc),
        energyKwh: finite(row.energyKwh), rateKw: finite(row.rateKw),
        counterResets: finite(row.counterResets) || 0,
        estimatedTotalKwh: finite(row.estimatedTotalKwh),
        estimateBasis: String(row.estimateBasis || ""),
        estimateReferenceCount: finite(row.estimateReferenceCount),
        estimateReferenceSlopeKwhPerSoc: finite(row.estimateReferenceSlopeKwhPerSoc),
        estimateReason: String(row.estimateReason || ""),
        earlyCounter: Boolean(row.earlyCounter)
      });
    }
    result.sort((a, b) => a.start - b.start || a.type.localeCompare(b.type));
    return result;
  }

  function buildAreas(gps, charges) {
    const areas = new Map();
    function ensure(key, lat, lon) {
      if (!areas.has(key)) {
        const point = areaFor(lat, lon);
        areas.set(key, { key, lat: point.lat, lon: point.lon, fixes: 0, rawRecords: 0, ac: 0, dc: 0 });
      }
      return areas.get(key);
    }
    for (const item of gps) {
      const site = ensure(item.area, item.lat, item.lon);
      site.fixes++;
      site.rawRecords += item.count;
    }
    for (const item of charges) {
      if (item.area === null) continue;
      const site = ensure(item.area, item.lat, item.lon);
      site[item.type.toLowerCase()]++;
    }
    return areas;
  }

  function mount(root, options) {
    if (!root || typeof root.replaceChildren !== "function") throw new TypeError("FordMap.mount needs a DOM element");
    if (root.__fordMapInstance && typeof root.__fordMapInstance.destroy === "function") root.__fordMapInstance.destroy();
    const config = options || {};
    const gps = normalizeGps(config.gps);
    const charges = normalizeCharges(config.charges);
    const multipleVehicles = new Set([...gps, ...charges].map(item => item.vehicleIndex)).size > 1;
    const areas = buildAreas(gps, charges);
    const geography = config.geography || {};
    const timezone = config.timezone || "Europe/Zurich";
    const dateTime = makeFormatter(timezone, {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    });
    const dateOnly = makeFormatter(timezone, { day: "2-digit", month: "short", year: "numeric" });
    const dayKey = makeFormatter(timezone, { year: "numeric", month: "2-digit", day: "2-digit" });
    const monthKey = makeFormatter(timezone, { year: "numeric", month: "2-digit" });
    const monthName = makeFormatter(timezone, { month: "short" });
    const numberFormat = new Intl.NumberFormat("en-GB");

    root.classList.add("ford-map");
    root.innerHTML = `
      <div class="fm-heading">
        <div>
          <div class="fm-eyebrow">Uploaded Ford JSON · local map</div>
          <h3>Where the car appeared and charged</h3>
          <p class="fm-subtitle">Approximate recorded locations through time</p>
        </div>
        <div class="fm-summary" aria-live="polite"></div>
      </div>
      <div class="fm-toolbar">
        <div class="fm-toolbar-copy"><strong>Explore the timeline</strong><span>Select GPS positions or charging stops</span></div>
        <div class="fm-filter" role="group" aria-label="Map and charging type filter">
          <button type="button" data-mode="gps" aria-pressed="true">All GPS <em data-count="gps"></em></button>
          <button type="button" data-mode="both" aria-pressed="false">AC + DC <em data-count="both"></em></button>
          <button type="button" data-mode="ac" aria-pressed="false">AC only <em data-count="ac"></em></button>
          <button type="button" data-mode="dc" aria-pressed="false">DC only <em data-count="dc"></em></button>
        </div>
      </div>
      <div class="fm-main">
        <div class="fm-map-wrap">
          <div class="fm-stage" aria-label="Interactive map of approximate Ford GPS coordinates">
            <svg class="fm-svg" viewBox="0 0 1 1" preserveAspectRatio="none" role="img" aria-label="Offline map of recorded locations">
              <g class="fm-grid"></g><g class="fm-countries"></g>
            </svg>
            <div class="fm-label-layer" aria-hidden="true"></div>
            <div class="fm-marker-layer"></div>
            <div class="fm-active-pin" hidden></div>
            <div class="fm-map-note"><strong>Approximate locations</strong><span>Drag to pan · scroll to zoom</span></div>
            <div class="fm-legend"><span><i class="fm-key fm-key-ac"></i>AC</span><span><i class="fm-key fm-key-dc"></i>DC</span><span><i class="fm-key fm-key-mixed"></i>Both</span></div>
          </div>
          <div class="fm-map-footer">
            <span>Offline map outlines: Natural Earth · Public domain</span>
            <div class="fm-map-actions">
              <button type="button" data-action="zoom-out" aria-label="Zoom out">−</button>
              <button type="button" data-action="zoom-in" aria-label="Zoom in">+</button>
              <button type="button" data-action="fit">Fit all</button>
            </div>
          </div>
        </div>
        <aside class="fm-detail" aria-live="polite">
          <div class="fm-detail-eyebrow">Selected observation</div>
          <div class="fm-detail-title">No position selected</div>
          <div class="fm-detail-coordinate">—</div>
          <div class="fm-detail-grid"></div>
          <p class="fm-detail-note"></p>
        </aside>
      </div>
      <div class="fm-timeline">
        <div class="fm-timeline-head"><div><strong>Location timeline</strong><span class="fm-timeline-hint">Each step follows an exported GPS fix.</span></div><span class="fm-timeline-date">—</span></div>
        <div class="fm-density" aria-hidden="true"><div class="fm-density-bars"></div><div class="fm-density-cursor"></div></div>
        <input class="fm-slider" type="range" min="0" max="0" value="0" step="1" aria-label="Timeline position">
        <div class="fm-month-labels" aria-hidden="true"></div>
        <div class="fm-play-row">
          <span class="fm-progress">No observations</span>
          <div class="fm-play-controls">
            <button type="button" data-action="previous" aria-label="Previous observation">‹ Previous</button>
            <button type="button" data-action="play" aria-label="Play timeline">▶ Play</button>
            <button type="button" data-action="next" aria-label="Next observation">Next ›</button>
            <button type="button" data-action="speed" aria-label="Change playback speed">1×</button>
          </div>
        </div>
      </div>
      <p class="fm-caveat">Positions and charging stops come only from the selected JSON files. GPS coordinates may be rounded; markers show broad areas, not exact addresses or continuous routes. Charging energy is a visible counter subtotal.</p>`;

    const query = selector => root.querySelector(selector);
    const stage = query(".fm-stage");
    const svg = query(".fm-svg");
    const gridLayer = query(".fm-grid");
    const countryLayer = query(".fm-countries");
    const labelLayer = query(".fm-label-layer");
    const markerLayer = query(".fm-marker-layer");
    const activePin = query(".fm-active-pin");
    const slider = query(".fm-slider");
    const densityBars = query(".fm-density-bars");
    const densityCursor = query(".fm-density-cursor");
    const monthLabels = query(".fm-month-labels");
    const filterButtons = Array.from(root.querySelectorAll(".fm-filter button"));
    const countries = [];
    const cities = [];
    const markers = new Map();
    let mode = "gps";
    let timeline = gps;
    let selectedIndex = timeline.length ? timeline.length - 1 : -1;
    let selectedTime = selectedIndex >= 0 ? timeline[selectedIndex].t : null;
    let view = null;
    let fitView = null;
    let playing = false;
    let frameId = 0;
    let frameLast = 0;
    let playElapsed = 0;
    let speed = 1;
    let dragging = null;
    let resizeObserver = null;
    let destroyed = false;

    for (let lat = -80; lat <= 80; lat += 5) {
      const y = mercY(lat);
      gridLayer.appendChild(svgElement("path", { d: "M0," + y + "L1," + y }));
    }
    for (let lon = -180; lon <= 180; lon += 5) {
      const x = mercX(lon);
      gridLayer.appendChild(svgElement("path", { d: "M" + x + ",0L" + x + ",1" }));
    }
    for (const country of Array.isArray(geography.countries) ? geography.countries : []) {
      const pathData = geographyPath(country.polygons);
      if (!pathData) continue;
      const path = svgElement("path", { d: pathData });
      const title = svgElement("title");
      title.textContent = String(country.name || "Country");
      path.appendChild(title);
      countryLayer.appendChild(path);
      if (Array.isArray(country.label) && country.label.length >= 2) {
        const lon = finite(country.label[0]);
        const lat = finite(country.label[1]);
        if (validPosition(lat, lon)) {
          const label = document.createElement("span");
          label.className = "fm-country-label";
          label.textContent = String(country.name || "");
          labelLayer.appendChild(label);
          countries.push({ element: label, lat, lon });
        }
      }
    }
    for (const city of Array.isArray(geography.cities) ? geography.cities : []) {
      const lon = finite(city.lon);
      const lat = finite(city.lat);
      if (!validPosition(lat, lon)) continue;
      const label = document.createElement("span");
      label.className = "fm-city-label";
      label.textContent = String(city.name || "");
      labelLayer.appendChild(label);
      cities.push({ element: label, lat, lon, population: finite(city.population) || 0 });
    }
    cities.sort((a, b) => b.population - a.population);

    query('[data-count="gps"]').textContent = numberFormat.format(gps.length);
    query('[data-count="both"]').textContent = numberFormat.format(charges.length);
    query('[data-count="ac"]').textContent = numberFormat.format(charges.filter(item => item.type === "AC").length);
    query('[data-count="dc"]').textContent = numberFormat.format(charges.filter(item => item.type === "DC").length);

    function stageSize() { return { w: Math.max(stage.clientWidth, 320), h: Math.max(stage.clientHeight, 350) }; }

    function screenPosition(lon, lat) {
      const size = stageSize();
      return { x: (mercX(lon) - view.x) / view.w * size.w, y: (mercY(lat) - view.y) / view.h * size.h };
    }

    function visibleAreas() {
      const keys = new Set(timeline.map(item => item.area).filter(Boolean));
      return Array.from(keys, key => areas.get(key)).filter(Boolean);
    }

    function fitMap() {
      const selected = visibleAreas();
      const points = selected.length ? selected : Array.from(areas.values());
      const size = stageSize();
      let minX, maxX, minY, maxY;
      if (points.length) {
        minX = Infinity; maxX = -Infinity; minY = Infinity; maxY = -Infinity;
        for (const site of points) {
          const x = mercX(site.lon);
          const y = mercY(site.lat);
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      } else {
        minX = mercX(-5); maxX = mercX(18);
        minY = mercY(58); maxY = mercY(43);
      }
      const aspect = size.w / size.h;
      const dataW = Math.max(2.2 / 360, (maxX - minX) * 1.35);
      const dataH = Math.max(Math.abs(mercY(51) - mercY(49)), (maxY - minY) * 1.45);
      const width = Math.max(dataW, dataH * aspect);
      const height = width / aspect;
      fitView = { x: (minX + maxX - width) / 2, y: (minY + maxY - height) / 2, w: width, h: height };
      view = Object.assign({}, fitView);
      updateMap();
    }

    function updateMap() {
      if (!view || destroyed) return;
      svg.setAttribute("viewBox", [view.x, view.y, view.w, view.h].join(" "));
      const size = stageSize();
      for (const [key, button] of markers) {
        const site = areas.get(key);
        const position = screenPosition(site.lon, site.lat);
        button.style.left = position.x + "px";
        button.style.top = position.y + "px";
        button.hidden = position.x < -35 || position.x > size.w + 35 || position.y < -35 || position.y > size.h + 35;
      }
      for (const record of countries) {
        const position = screenPosition(record.lon, record.lat);
        record.element.hidden = position.x < 20 || position.x > size.w - 20 || position.y < 20 || position.y > size.h - 20;
        if (!record.element.hidden) { record.element.style.left = position.x + "px"; record.element.style.top = position.y + "px"; }
      }
      const zoomed = view.w < fitView.w * 0.72;
      for (const record of cities) {
        const position = screenPosition(record.lon, record.lat);
        record.element.hidden = record.population < (zoomed ? 100000 : 500000)
          || position.x < 20 || position.x > size.w - 20 || position.y < 20 || position.y > size.h - 20;
        if (!record.element.hidden) { record.element.style.left = position.x + "px"; record.element.style.top = position.y + "px"; }
      }
      const item = timeline[selectedIndex];
      if (item && item.area) {
        const area = areas.get(item.area);
        const position = screenPosition(area.lon, area.lat);
        activePin.hidden = position.x < 0 || position.x > size.w || position.y < 0 || position.y > size.h;
        activePin.style.left = position.x + "px";
        activePin.style.top = position.y + "px";
        activePin.classList.toggle("fm-pin-dc", item.kind === "charge" && item.type === "DC");
      } else activePin.hidden = true;
    }

    function nearestIndex(timestamp) {
      if (!timeline.length) return -1;
      let low = 0, high = timeline.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (timeline[middle].t < timestamp) low = middle + 1;
        else high = middle;
      }
      if (low <= 0) return 0;
      if (low >= timeline.length) return timeline.length - 1;
      return Math.abs(timeline[low].t - timestamp) < Math.abs(timeline[low - 1].t - timestamp) ? low : low - 1;
    }

    function timelineProgress() {
      if (!timeline.length) return 0;
      if (mode === "gps") {
        const span = Math.max(1, timeline[timeline.length - 1].t - timeline[0].t);
        return (selectedTime - timeline[0].t) / span;
      }
      return selectedIndex / Math.max(1, timeline.length - 1);
    }

    function updateVisitedMarkers() {
      const seen = new Set();
      for (let i = 0; i <= selectedIndex; i++) if (timeline[i].area) seen.add(timeline[i].area);
      for (const [key, button] of markers) button.classList.toggle("fm-visited", seen.has(key));
    }

    function renderDetail() {
      const item = timeline[selectedIndex];
      const grid = query(".fm-detail-grid");
      grid.replaceChildren();
      function metric(label, value) {
        const block = document.createElement("div");
        block.className = "fm-detail-metric";
        const caption = document.createElement("span");
        caption.textContent = label;
        const strong = document.createElement("strong");
        strong.textContent = value;
        block.append(caption, strong);
        grid.appendChild(block);
      }
      if (!item) {
        query(".fm-detail-eyebrow").textContent = "No matching observations";
        query(".fm-detail-title").textContent = mode === "gps" ? "No GPS positions in these files" : "No charging stops for this filter";
        query(".fm-detail-coordinate").textContent = "—";
        query(".fm-detail-note").textContent = mode === "gps" ? "Select a JSON file containing location fields to populate the map." : "Choose another charging filter or load additional Ford JSON files.";
        return;
      }
      const site = item.area ? areas.get(item.area) : null;
      query(".fm-detail-coordinate").textContent = site ? coordinateLabel(site.lat, site.lon) : "Location unavailable in the selected JSON";
      if (item.kind === "gps") {
        query(".fm-detail-eyebrow").textContent = "GPS observation";
        query(".fm-detail-title").textContent = dateTime.format(new Date(item.t));
        if (multipleVehicles) metric("Vehicle", "#" + item.vehicleIndex);
        metric("Observation", numberFormat.format(selectedIndex + 1) + " / " + numberFormat.format(timeline.length));
        metric("Fixes near this area", site ? numberFormat.format(site.fixes) : "—");
        metric("Source rows at this instant", numberFormat.format(item.count));
        metric("Since prior fix", selectedIndex ? formatGap(item.t - timeline[selectedIndex - 1].t) : "First fix");
        query(".fm-detail-note").textContent = "This is a GPS snapshot, not a trip or speed measurement.";
      } else {
        query(".fm-detail-eyebrow").textContent = item.type + " charging stop";
        query(".fm-detail-title").textContent = dateTime.format(new Date(item.start));
        if (multipleVehicles) metric("Vehicle", "#" + item.vehicleIndex);
        const lastSeen = item.endStatus === "NO_END_EVENT" || item.endStatus === "LONG_GAP";
        metric(lastSeen ? "Last seen" : "Charge ended", item.end === null ? "No end event" : dateTime.format(new Date(item.end)));
        metric("Elapsed time", formatDuration(item.start, item.end));
        metric("Battery", (item.startSoc === null ? "?" : item.startSoc + "%") + " → " + (item.endSoc === null ? "?" : item.endSoc + "%"));
        metric("Visible energy", item.energyKwh === null ? "Unavailable" : (item.earlyCounter && !item.counterResets ? "≥ " : "") + item.energyKwh.toFixed(1) + " kWh");
        if (item.estimatedTotalKwh !== null) metric("Estimated total", "≈ " + item.estimatedTotalKwh.toFixed(1) + " kWh");
        metric("Observed rate", item.rateKw === null ? "Unavailable" : item.rateKw.toFixed(2) + " kW");
        metric("Session", (selectedIndex + 1) + " / " + timeline.length);
        const notes = [];
        if (lastSeen) notes.push("No terminal charge event was present; the displayed end is the last observed charge status.");
        if (item.counterResets) notes.push("The Ford energy counter reset during this session; its reconstructed recorded subtotal is uncertain.");
        if (item.earlyCounter) notes.push("The energy counter ends before the charging event, so the session total may be higher.");
        if (item.estimatedTotalKwh !== null && item.estimateBasis === "soc_reference") {
          const references = item.estimateReferenceCount === null ? "similar sessions" : item.estimateReferenceCount + " similar session" + (item.estimateReferenceCount === 1 ? "" : "s");
          const wholeSession = item.counterResets > 0 || item.energyKwh === null;
          notes.push("The " + (wholeSession ? "whole-session" : "missing-tail") + " SOC estimate uses " + references + " for this vehicle and charger type in the selected Ford JSON. It is approximate, not a final Ford reading or a guaranteed minimum.");
        } else if (item.estimatedTotalKwh !== null) {
          notes.push("The total is projected from this session's measured AC counter rate and checked against its SOC change. It is approximate, not a final Ford reading or a guaranteed minimum.");
        } else if (item.earlyCounter && item.estimateReason) {
          notes.push("No estimate: " + item.estimateReason + ".");
        }
        if (item.gpsOffsetSeconds !== null) notes.push("Mapped from a GPS fix " + item.gpsOffsetSeconds.toFixed(0) + " seconds from the charge start.");
        else if (!site) notes.push("No nearby usable GPS fix was present.");
        notes.push("Rate is an average over the measured part, not peak power.");
        query(".fm-detail-note").textContent = notes.join(" ");
      }
    }

    function renderTimeline() {
      const hasItems = timeline.length > 0;
      const charging = mode !== "gps";
      query(".fm-timeline-head strong").textContent = charging ? "Charging stop timeline" : "GPS date timeline";
      query(".fm-timeline-hint").textContent = charging
        ? "Each step is one " + (mode === "ac" ? "AC" : mode === "dc" ? "DC" : "AC or DC") + " charging session."
        : "Slide across the dates in the uploaded export.";
      slider.disabled = !hasItems;
      slider.max = String(charging ? Math.max(0, timeline.length - 1) : 1000);
      slider.value = String(hasItems ? (charging ? selectedIndex : Math.round(timelineProgress() * 1000)) : 0);
      const progress = clamp(timelineProgress(), 0, 1) * 100;
      slider.style.setProperty("--fm-progress", progress.toFixed(2) + "%");
      densityCursor.style.left = progress.toFixed(2) + "%";
      query(".fm-timeline-date").textContent = hasItems ? dateOnly.format(new Date(selectedTime)) : "—";
      query(".fm-progress").textContent = !hasItems ? "No observations" : charging
        ? (selectedIndex + 1) + " / " + timeline.length + " charging stops"
        : numberFormat.format(selectedIndex + 1) + " / " + numberFormat.format(timeline.length) + " GPS fixes";
      for (const action of ["previous", "next", "play", "speed"]) query('[data-action="' + action + '"]').disabled = !hasItems;
      query('[data-action="previous"]').setAttribute("aria-label", charging ? "Previous charging stop" : "Previous GPS observation");
      query('[data-action="next"]').setAttribute("aria-label", charging ? "Next charging stop" : "Next GPS observation");
    }

    function buildDensity() {
      densityBars.replaceChildren();
      monthLabels.replaceChildren();
      if (!timeline.length) return;
      const buckets = new Map();
      const months = new Map();
      for (let index = 0; index < timeline.length; index++) {
        const item = timeline[index];
        const date = new Date(item.t);
        const key = dayKey.format(date);
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { first: item.t, last: item.t, firstIndex: index, lastIndex: index, count: 0, ac: 0, dc: 0 };
          buckets.set(key, bucket);
        }
        bucket.last = item.t;
        bucket.lastIndex = index;
        bucket.count++;
        if (item.kind === "charge") bucket[item.type.toLowerCase()]++;
        const month = monthKey.format(date);
        if (!months.has(month)) months.set(month, { first: index, firstTime: item.t, name: monthName.format(date) });
      }
      let maximum = 1;
      for (const bucket of buckets.values()) maximum = Math.max(maximum, bucket.count);
      const minTime = timeline[0].t;
      const span = Math.max(1, timeline[timeline.length - 1].t - minTime);
      const sequenceSpan = Math.max(1, timeline.length - 1);
      const dayCount = Math.max(1, Math.ceil(span / DAY_MS));
      for (const bucket of buckets.values()) {
        const bar = document.createElement("span");
        bar.className = "fm-density-bar";
        if (bucket.ac && bucket.dc) bar.classList.add("fm-density-mixed");
        else if (bucket.dc) bar.classList.add("fm-density-dc");
        const position = mode === "gps"
          ? (((bucket.first + bucket.last) / 2 - minTime) / span) * 100
          : ((bucket.firstIndex + bucket.lastIndex) / 2 / sequenceSpan) * 100;
        const width = mode === "gps" ? Math.max(0.28, 96 / dayCount) : Math.max(0.8, bucket.count / timeline.length * 96);
        bar.style.left = clamp(position, 0, 100) + "%";
        bar.style.width = width + "%";
        bar.style.height = (4 + Math.sqrt(bucket.count / maximum) * 39) + "px";
        densityBars.appendChild(bar);
      }
      let lastLabelPosition = -100;
      for (const month of months.values()) {
        const position = mode === "gps" ? (month.firstTime - minTime) / span * 100 : month.first / sequenceSpan * 100;
        if (position - lastLabelPosition < 9) continue;
        const label = document.createElement("span");
        label.textContent = month.name;
        label.style.left = clamp(position, 2, 95) + "%";
        monthLabels.appendChild(label);
        lastLabelPosition = position;
      }
    }

    function renderMarkers() {
      markerLayer.replaceChildren();
      markers.clear();
      const areaCounts = new Map();
      for (const item of timeline) {
        if (!item.area) continue;
        const current = areaCounts.get(item.area) || { gps: 0, ac: 0, dc: 0 };
        current[item.kind === "gps" ? "gps" : item.type.toLowerCase()]++;
        areaCounts.set(item.area, current);
      }
      for (const [key, counts] of areaCounts) {
        const site = areas.get(key);
        const total = mode === "gps" ? counts.gps : counts.ac + counts.dc;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "fm-site-marker";
        if (mode !== "gps") {
          button.classList.add("fm-charge-marker");
          button.classList.add(counts.ac && counts.dc ? "fm-mixed-marker" : counts.dc ? "fm-dc-marker" : "fm-ac-marker");
        }
        const diameter = mode === "gps" ? 16 + Math.min(30, Math.log1p(total) * 4.7) : 22 + Math.min(25, Math.log1p(total) * 6);
        button.style.setProperty("--fm-marker-size", Math.round(diameter) + "px");
        button.textContent = total >= 10 ? numberFormat.format(total) : "";
        button.title = mode === "gps"
          ? total + " GPS observations near " + coordinateLabel(site.lat, site.lon)
          : counts.ac + " AC and " + counts.dc + " DC charging stops near " + coordinateLabel(site.lat, site.lon);
        button.setAttribute("aria-label", button.title + ". Jump to this area.");
        button.addEventListener("click", event => {
          event.stopPropagation();
          pause();
          let nearest = -1;
          let difference = Infinity;
          for (let i = 0; i < timeline.length; i++) {
            if (timeline[i].area !== key) continue;
            const distance = Math.abs(timeline[i].t - (selectedTime || timeline[i].t));
            if (distance < difference) { difference = distance; nearest = i; }
          }
          if (nearest >= 0) select(nearest, timeline[nearest].t);
        });
        markerLayer.appendChild(button);
        markers.set(key, button);
      }
      updateVisitedMarkers();
      updateMap();
    }

    function renderSummary() {
      const mapped = timeline.filter(item => item.area).length;
      const areaCount = visibleAreas().length;
      const energy = mode === "gps" ? null : timeline.reduce((sum, item) => sum + (item.energyKwh || 0), 0);
      const summary = query(".fm-summary");
      summary.replaceChildren();
      function chip(number, label) {
        const item = document.createElement("div");
        item.className = "fm-summary-chip";
        const strong = document.createElement("strong"); strong.textContent = number;
        const span = document.createElement("span"); span.textContent = label;
        item.append(strong, span);
        summary.appendChild(item);
      }
      if (mode === "gps") {
        chip(numberFormat.format(timeline.length), "timed GPS fixes");
        chip(numberFormat.format(areaCount), "approximate areas");
      } else {
        chip(numberFormat.format(timeline.length), "charging stops");
        chip(numberFormat.format(areaCount), "mapped areas");
        chip((!timeline.some(item => item.counterResets) && timeline.some(item => item.earlyCounter || item.energyKwh === null) ? "≥ " : "") + energy.toFixed(1), "visible kWh");
      }
      query(".fm-subtitle").textContent = timeline.length
        ? dateOnly.format(new Date(timeline[0].t)) + " – " + dateOnly.format(new Date(timeline[timeline.length - 1].t)) + " · " + timezone
        : "No matching records in the selected JSON files";
      query(".fm-map-note strong").textContent = mode === "gps" ? "Approximate GPS areas" : "Approximate charging areas";
      query(".fm-map-note span").textContent = mode === "gps"
        ? "Markers count timed GPS fixes · Drag to pan"
        : "Markers count charging stops · Drag to pan";
      query(".fm-legend").hidden = mode === "gps";
      if (mode !== "gps" && mapped < timeline.length) {
        query(".fm-caveat").textContent = "Positions and charging stops come only from the selected JSON files. " + (timeline.length - mapped) + " charging stop(s) lack a usable nearby GPS position and remain on the timeline. GPS markers are approximate; energy is a visible counter subtotal." + (timeline.some(item => item.counterResets) ? " A counter reset makes the summed subtotal uncertain." : "") + (multipleVehicles ? " The timeline combines several vehicles; each selected observation identifies its vehicle number." : "");
      } else {
        query(".fm-caveat").textContent = "Positions and charging stops come only from the selected JSON files. GPS coordinates may be rounded; markers show broad areas, not exact addresses or continuous routes. Charging energy is a visible counter subtotal." + (timeline.some(item => item.counterResets) ? " A counter reset makes the summed subtotal uncertain." : "") + (multipleVehicles ? " The timeline combines several vehicles; each selected observation identifies its vehicle number." : "");
      }
    }

    function select(index, time) {
      if (!timeline.length) {
        selectedIndex = -1;
        selectedTime = null;
      } else {
        selectedIndex = clamp(index, 0, timeline.length - 1);
        selectedTime = mode === "gps" && Number.isFinite(time) ? clamp(time, timeline[0].t, timeline[timeline.length - 1].t) : timeline[selectedIndex].t;
      }
      renderDetail();
      renderTimeline();
      updateVisitedMarkers();
      updateMap();
    }

    function pause() {
      playing = false;
      cancelAnimationFrame(frameId);
      frameId = 0;
      frameLast = 0;
      playElapsed = 0;
      query('[data-action="play"]').textContent = "▶ Play";
    }

    function frame(now) {
      if (!playing || !timeline.length) return;
      if (frameLast) {
        const elapsed = Math.min(100, now - frameLast);
        if (mode === "gps") {
          const span = Math.max(1, timeline[timeline.length - 1].t - timeline[0].t);
          const nextTime = Math.min(timeline[timeline.length - 1].t, selectedTime + elapsed / 30000 * span * speed);
          select(nearestIndex(nextTime), nextTime);
        } else {
          playElapsed += elapsed * speed;
          if (playElapsed >= 650) {
            const steps = Math.floor(playElapsed / 650);
            playElapsed %= 650;
            select(Math.min(timeline.length - 1, selectedIndex + steps));
          }
        }
      }
      frameLast = now;
      if (selectedTime >= timeline[timeline.length - 1].t) pause();
      else frameId = requestAnimationFrame(frame);
    }

    function play() {
      if (!timeline.length) return;
      if (playing) { pause(); return; }
      if (selectedIndex >= timeline.length - 1) select(0);
      playing = true;
      query('[data-action="play"]').textContent = "Ⅱ Pause";
      frameId = requestAnimationFrame(frame);
    }

    function setMode(nextMode) {
      if (!["gps", "both", "ac", "dc"].includes(nextMode)) return;
      const oldTime = selectedTime;
      pause();
      mode = nextMode;
      timeline = mode === "gps" ? gps : mode === "both" ? charges : charges.filter(item => item.type.toLowerCase() === mode);
      for (const button of filterButtons) button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
      if (timeline.length) {
        selectedIndex = oldTime === null ? timeline.length - 1 : nearestIndex(oldTime);
        selectedTime = timeline[selectedIndex].t;
      } else {
        selectedIndex = -1;
        selectedTime = null;
      }
      renderMarkers();
      renderSummary();
      buildDensity();
      fitMap();
      select(selectedIndex);
    }

    function zoom(factor, fractionX, fractionY) {
      if (!view || !fitView) return;
      const nextWidth = clamp(view.w * factor, fitView.w / 30, fitView.w * 3);
      const scale = nextWidth / view.w;
      view.x += view.w * fractionX * (1 - scale);
      view.y += view.h * fractionY * (1 - scale);
      view.w = nextWidth;
      view.h *= scale;
      updateMap();
    }

    function onWheel(event) {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      zoom(event.deltaY < 0 ? 0.82 : 1.22,
        clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
        clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1));
    }

    function onPointerDown(event) {
      if (event.button !== 0 || event.target.closest(".fm-site-marker, .fm-map-note, .fm-legend")) return;
      dragging = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y };
      stage.classList.add("fm-dragging");
      stage.setPointerCapture(event.pointerId);
    }

    function onPointerMove(event) {
      if (!dragging || !view) return;
      const size = stageSize();
      view.x = dragging.viewX - (event.clientX - dragging.x) / size.w * view.w;
      view.y = dragging.viewY - (event.clientY - dragging.y) / size.h * view.h;
      updateMap();
    }

    function onPointerEnd() {
      dragging = null;
      stage.classList.remove("fm-dragging");
    }

    function onResize() {
      if (!view) { fitMap(); return; }
      const size = stageSize();
      const centerX = view.x + view.w / 2;
      const centerY = view.y + view.h / 2;
      view.h = view.w * size.h / size.w;
      view.x = centerX - view.w / 2;
      view.y = centerY - view.h / 2;
      updateMap();
    }

    function onKeydown(event) {
      if (event.target === slider || event.target.tagName === "BUTTON") return;
      if (event.key === "ArrowLeft" && timeline.length) {
        pause(); select(Math.max(0, selectedIndex - 1)); event.preventDefault();
      } else if (event.key === "ArrowRight" && timeline.length) {
        pause(); select(Math.min(timeline.length - 1, selectedIndex + 1)); event.preventDefault();
      }
    }

    for (const button of filterButtons) button.addEventListener("click", () => setMode(button.dataset.mode));
    query('[data-action="previous"]').addEventListener("click", () => { pause(); select(Math.max(0, selectedIndex - 1)); });
    query('[data-action="next"]').addEventListener("click", () => { pause(); select(Math.min(timeline.length - 1, selectedIndex + 1)); });
    query('[data-action="play"]').addEventListener("click", play);
    query('[data-action="speed"]').addEventListener("click", event => {
      speed = speed === 1 ? 4 : speed === 4 ? 12 : 1;
      event.currentTarget.textContent = speed + "×";
    });
    query('[data-action="zoom-in"]').addEventListener("click", () => zoom(0.72, 0.5, 0.5));
    query('[data-action="zoom-out"]').addEventListener("click", () => zoom(1.38, 0.5, 0.5));
    query('[data-action="fit"]').addEventListener("click", fitMap);
    slider.addEventListener("input", () => {
      if (!timeline.length) return;
      pause();
      if (mode === "gps") {
        const first = timeline[0].t;
        const last = timeline[timeline.length - 1].t;
        const time = first + Number(slider.value) / 1000 * (last - first);
        select(nearestIndex(time), time);
      } else select(Number(slider.value));
    });
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerup", onPointerEnd);
    stage.addEventListener("pointercancel", onPointerEnd);
    stage.addEventListener("lostpointercapture", onPointerEnd);
    root.addEventListener("keydown", onKeydown);
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(stage);
    } else window.addEventListener("resize", onResize);

    setMode(gps.length ? "gps" : charges.length ? "both" : "gps");
    const instance = {
      setMode,
      fit: fitMap,
      destroy() {
        if (destroyed) return;
        pause();
        destroyed = true;
        if (resizeObserver) resizeObserver.disconnect();
        else window.removeEventListener("resize", onResize);
        root.removeEventListener("keydown", onKeydown);
        root.replaceChildren();
        root.classList.remove("ford-map");
        if (root.__fordMapInstance === instance) delete root.__fordMapInstance;
      }
    };
    root.__fordMapInstance = instance;
    return instance;
  }

  window.FordMap = { mount };
})();
