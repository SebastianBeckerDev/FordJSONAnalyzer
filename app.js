/* Browser-only report controller for Ford attrList exports. */
(() => {
  "use strict";

  const TZ = "Europe/Zurich";
  const $ = (id) => document.getElementById(id);
  const definitions = JSON.parse($("fieldDefinitions").textContent);
  const geography = JSON.parse($("offlineGeography").textContent);
  const fieldDefinitions = new Map(definitions.fields.map((field) => [field.name, field]));
  const embeddedDefinitions = new Map(definitions.embedded.map((field) => [field.parent_field + "." + field.path_within_attrValue, field]));
  const dayFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const timeFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const monthNameFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "short" });
  const countFormatter = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
  const decimalFormatter = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const state = { files: [], data: null, worker: null, workerUrl: null, map: null, inlineStarted: false, chargeLimit: 80, schema: null, runId: 0 };

  function parts(formatter, timestamp) {
    const result = Object.create(null);
    for (const part of formatter.formatToParts(new Date(timestamp))) if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }
  function dayKey(timestamp) {
    const p = parts(dayFormatter, timestamp);
    return `${p.year}-${p.month}-${p.day}`;
  }
  function monthKey(timestamp) { return dayKey(timestamp).slice(0, 7); }
  function dateLabel(timestamp) {
    if (!Number.isFinite(timestamp)) return "—";
    const p = parts(dayFormatter, timestamp);
    return `${p.day}.${p.month}.${p.year}`;
  }
  function dateTimeLabel(timestamp) {
    if (!Number.isFinite(timestamp)) return "—";
    const p = parts(timeFormatter, timestamp);
    return `${dateLabel(timestamp)} ${p.hour}:${p.minute}`;
  }
  function dateTimeIsoLocal(timestamp) {
    if (!Number.isFinite(timestamp)) return "";
    const day = dayKey(timestamp);
    const time = parts(timeFormatter, timestamp);
    return `${day} ${time.hour}:${time.minute}`;
  }
  function monthLabel(key) {
    const [year, month] = key.split("-").map(Number);
    return monthNameFormatter.format(new Date(Date.UTC(year, month - 1, 15, 12)));
  }
  function shortMonth(key) { return `${key.slice(5)}/${key.slice(2, 4)}`; }
  function formatNumber(value, digits = 0) {
    if (!Number.isFinite(value)) return "—";
    return digits === 0 ? countFormatter.format(value) : decimalFormatter.format(value);
  }
  function formatDuration(minutes) {
    if (!Number.isFinite(minutes)) return "—";
    const rounded = Math.round(minutes);
    return rounded >= 60 ? `${Math.floor(rounded / 60)}h ${String(rounded % 60).padStart(2, "0")}m` : `${rounded}m`;
  }
  function humanBytes(bytes) {
    if (!Number.isFinite(bytes)) return "";
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${Math.round(bytes / 1e3)} KB`;
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  }
  function median(values) {
    if (!values.length) return null;
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }
  function percentile(values, fraction) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const index = (sorted.length - 1) * fraction;
    const low = Math.floor(index);
    return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
  }
  function emptyChart(target, message) { $(target).innerHTML = `<div class="fd-chart-empty">${escapeHtml(message)}</div>`; }

  function closeWorker() {
    if (state.worker) state.worker.terminate();
    if (state.workerUrl) URL.revokeObjectURL(state.workerUrl);
    state.worker = null;
    state.workerUrl = null;
  }
  function showError(message) {
    $("errorPanel").textContent = message;
    $("errorPanel").hidden = false;
    $("progressPanel").hidden = true;
    $("analyzeFiles").disabled = !state.files.length;
    closeWorker();
  }
  function showProgress(phase, percent, message) {
    $("progressPanel").hidden = false;
    $("progressTitle").textContent = phase === "reading" ? "Reading selected JSON files" : "Building the report";
    $("progressPercent").textContent = `${Math.max(0, Math.min(100, Math.round(percent || 0)))}%`;
    $("progressFill").style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
    $("progressDetail").textContent = message || "Working locally…";
  }
  function setFiles(fileList) {
    const files = Array.from(fileList || []).filter((file) => file && typeof file.stream === "function");
    state.runId++;
    closeWorker();
    state.files = files;
    state.data = null;
    state.schema = null;
    state.chargeLimit = 80;
    if (state.map) { state.map.destroy(); state.map = null; }
    $("results").hidden = true;
    $("progressPanel").hidden = true;
    $("errorPanel").hidden = true;
    $("analyzeFiles").disabled = files.length === 0;
    if (!files.length) {
      $("selectedFiles").textContent = "No files selected";
      return;
    }
    const size = files.reduce((sum, file) => sum + (file.size || 0), 0);
    $("selectedFiles").textContent = `${files.length} file${files.length === 1 ? "" : "s"} · ${humanBytes(size)}\n${files.map((file) => file.name || "unnamed.json").join("\n")}`;
  }
  function analyze() {
    if (!state.files.length) return;
    const runId = ++state.runId;
    closeWorker();
    state.inlineStarted = false;
    $("errorPanel").hidden = true;
    $("results").hidden = true;
    $("analyzeFiles").disabled = true;
    showProgress("reading", 0, "Preparing local files…");
    const source = $("analysisEngine").textContent;
    const onMessage = (message) => {
      if (runId !== state.runId) return;
      if (message.type === "progress") showProgress(message.phase, message.percent, message.message);
      else if (message.type === "error") showError(message.message || "Could not analyze these files.");
      else if (message.type === "result") {
        closeWorker();
        try {
          state.data = message.result;
          $("results").hidden = false;
          render();
          $("progressPanel").hidden = true;
          $("analyzeFiles").disabled = false;
          $("results").scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (error) { $("results").hidden = true; showError(`The JSON was read, but the report could not be drawn: ${error.message}`); }
      }
    };
    const inlineFallback = () => {
      if (state.inlineStarted || runId !== state.runId) return;
      state.inlineStarted = true;
      closeWorker();
      showProgress("reading", 0, "This browser is reading the files on the page; it may respond slowly during parsing.");
      setTimeout(() => {
        try {
          const localScope = { postMessage: onMessage };
          new Function("self", source)(localScope);
          localScope.onmessage({ data: { type: "analyze", files: state.files } });
        } catch (error) { showError(error.message); }
      }, 20);
    };
    try {
      const blob = new Blob([source], { type: "text/javascript" });
      state.workerUrl = URL.createObjectURL(blob);
      state.worker = new Worker(state.workerUrl);
      state.worker.onmessage = (event) => onMessage(event.data);
      state.worker.onerror = (event) => { if (event.preventDefault) event.preventDefault(); inlineFallback(); };
      state.worker.postMessage({ type: "analyze", files: state.files });
    } catch (_error) { inlineFallback(); }
  }

  function sortedRows(object) {
    if (Array.isArray(object)) return object;
    return Object.entries(object || {}).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }
  function sum(numbers) { return numbers.reduce((total, number) => total + (Number.isFinite(number) ? number : 0), 0); }
  function chargeEnergy(charge) { return Number.isFinite(charge.energyKwh) ? charge.energyKwh : 0; }
  function incompleteEnergy(charge) { return Boolean(charge.earlyCounter) || !Number.isFinite(charge.energyKwh) || !(charge.energySamples > 0); }
  function counterReset(charge) { return (charge.counterResets || 0) > 0; }
  function visibleEnergyPrefix(charges) { return charges.some(counterReset) ? "" : charges.some(incompleteEnergy) ? "≥" : ""; }
  function chargeType(charge) { return charge.type === "AC" || charge.type === "DC" ? charge.type : "Other"; }
  function odometerSpans(rows, period) {
    const grouped = new Map();
    for (const row of rows) {
      if (!Number.isFinite(row.t) || !Number.isFinite(row.km)) continue;
      const key = `${row.vehicleIndex || 1}|${period === "day" ? dayKey(row.t) : monthKey(row.t)}`;
      let item = grouped.get(key);
      if (!item) { item = { key: key.split("|")[1], vehicleIndex: row.vehicleIndex || 1, first: row, last: row }; grouped.set(key, item); }
      else {
        if (row.t < item.first.t) item.first = row;
        if (row.t > item.last.t) item.last = row;
      }
    }
    const totals = new Map();
    for (const item of grouped.values()) {
      if (item.last.t <= item.first.t) continue;
      const delta = item.last.km - item.first.km;
      if (!Number.isFinite(delta) || delta < 0) continue;
      totals.set(item.key, (totals.get(item.key) || 0) + delta);
    }
    return Array.from(totals, ([key, km]) => ({ key, km })).sort((a, b) => a.key.localeCompare(b.key));
  }
  function overallOdometer(rows) {
    const byVehicle = new Map();
    for (const row of rows) {
      if (!Number.isFinite(row.t) || !Number.isFinite(row.km)) continue;
      const vehicle = row.vehicleIndex || 1;
      let item = byVehicle.get(vehicle);
      if (!item) { item = { first: row, last: row }; byVehicle.set(vehicle, item); }
      else {
        if (row.t < item.first.t) item.first = row;
        if (row.t > item.last.t) item.last = row;
      }
    }
    let km = 0;
    let validVehicles = 0;
    for (const item of byVehicle.values()) {
      if (item.last.t > item.first.t && item.last.km >= item.first.km) { km += item.last.km - item.first.km; validVehicles++; }
    }
    return { km: validVehicles ? km : null, validVehicles, byVehicle };
  }
  function monthlyData(data) {
    const distance = new Map(odometerSpans(data.odometer || [], "month").map((item) => [item.key, item.km]));
    const energy = new Map();
    for (const charge of data.charges || []) {
      if (!Number.isFinite(charge.end)) continue;
      const key = monthKey(charge.end);
      let item = energy.get(key);
      if (!item) { item = { AC: 0, DC: 0, Other: 0, acCount: 0, dcCount: 0, otherCount: 0, earlyCount: 0, resetCount: 0 }; energy.set(key, item); }
      const type = chargeType(charge);
      item[type] += chargeEnergy(charge);
      item[type === "AC" ? "acCount" : type === "DC" ? "dcCount" : "otherCount"]++;
      if (incompleteEnergy(charge)) item.earlyCount++;
      if (counterReset(charge)) item.resetCount++;
    }
    const keys = new Set([...distance.keys(), ...energy.keys()]);
    return Array.from(keys).sort().map((key) => ({ key, km: distance.get(key) ?? null, ...(energy.get(key) || { AC: 0, DC: 0, Other: 0, acCount: 0, dcCount: 0, otherCount: 0, earlyCount: 0, resetCount: 0 }) }));
  }

  function renderKpis(data, monthly, odometer) {
    const charges = data.charges || [];
    const gps = data.gps || [];
    const meta = data.meta || {};
    const energy = sum(charges.map(chargeEnergy));
    const acCount = charges.filter((item) => chargeType(item) === "AC").length;
    const dcCount = charges.filter((item) => chargeType(item) === "DC").length;
    const otherCount = charges.length - acCount - dcCount;
    const from = Number.isFinite(meta.minTimestamp) ? dateLabel(meta.minTimestamp) : "—";
    const to = Number.isFinite(meta.maxTimestamp) ? dateLabel(meta.maxTimestamp) : "—";
    $("coverageText").textContent = `${meta.fileCount ?? state.files.length} selected file${(meta.fileCount ?? state.files.length) === 1 ? "" : "s"} · ${from} to ${to} · Europe/Zurich display time`;
    const cards = [
      ["Source files", formatNumber(meta.fileCount ?? state.files.length), humanBytes(sum(state.files.map((file) => file.size || 0)))],
      ["Logical records", formatNumber(meta.processedRecords ?? meta.recordCount), `${formatNumber(meta.rawAttributes)} raw attributes`],
      ["Odometer increase", odometer.km == null ? "—" : `${formatNumber(odometer.km)} km`, "First to last reading per vehicle"],
      ["Charging sessions", formatNumber(charges.length), `${acCount} AC · ${dcCount} DC${otherCount ? ` · ${otherCount} other` : ""}`],
      ["Visible counter energy", `${visibleEnergyPrefix(charges)}${formatNumber(energy, 1)} kWh`, charges.some(counterReset) ? "Counter subtotal; reset segments make the sum uncertain" : "Counter subtotal; missing or early tails may make it a lower bound"],
      ["Timed GPS fixes", formatNumber(gps.length), `${formatNumber(meta.rawGpsRows)} source rows`]
    ];
    $("kpiGrid").innerHTML = cards.map(([label, value, note], index) => `<div class="fd-kpi ${index === 4 ? "accent" : index === 2 ? "amber" : ""}"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong><span>${escapeHtml(note)}</span></div>`).join("");
    const early = charges.filter((item) => item.earlyCounter).length;
    const missingEnergy = charges.filter((item) => !Number.isFinite(item.energyKwh) || !(item.energySamples > 0)).length;
    const fragments = (meta.unmatchedHeads || 0) + (meta.unmatchedTails || 0);
    const issues = [];
    if (fragments) issues.push(`${fragments} unmatched file-edge fragments`);
    if (early) issues.push(`${early} charging counters end before their sessions`);
    const resetCount = charges.filter(counterReset).length;
    if (resetCount) issues.push(`${resetCount} charging counter reset${resetCount === 1 ? "" : "s"}; reconstructed subtotals are uncertain`);
    if (missingEnergy) issues.push(`${missingEnergy} charging sessions have no usable energy counter`);
    if (meta.unlocatedCharges) issues.push(`${meta.unlocatedCharges} charges lack a nearby GPS fix`);
    if (meta.multipleVehicles) issues.push(`${meta.vehicleCount} vehicles are present; odometer movement is summed per vehicle`);
    if (Array.isArray(meta.warnings)) issues.push(...meta.warnings);
    const boundary = meta.joinedBoundaryRecords ? `${meta.joinedBoundaryRecords} split source record${meta.joinedBoundaryRecords === 1 ? "" : "s"} reconnected across file edges` : "No file-edge joins were needed";
    const reconstruction = Number.isFinite(meta.chargeEventRecords) && Number.isFinite(meta.chargeSnapshots)
      ? ` Charging reconstruction: ${formatNumber(meta.chargeEventRecords)} source event rows → ${formatNumber(meta.chargeSnapshots)} distinct snapshots → ${formatNumber(charges.length)} sessions.` : "";
    const idAudit = ` Repeated source IDs: ${formatNumber(meta.duplicateIds || 0)}.`;
    $("qualityPanel").classList.toggle("warn", issues.length > 0);
    $("qualityPanel").innerHTML = `<strong>Import quality.</strong> ${escapeHtml(boundary)}.${escapeHtml(idAudit)}${escapeHtml(reconstruction)} ${issues.length ? escapeHtml([...new Set(issues)].join(" · ")) : "No incomplete file-edge fragments were found."}`;
    const chargeMonth = monthly.filter((item) => item.acCount + item.dcCount + item.otherCount).sort((a, b) => (b.acCount + b.dcCount + b.otherCount) - (a.acCount + a.dcCount + a.otherCount))[0];
    const daily = odometerSpans(data.odometer || [], "day");
    const longest = daily.slice().sort((a, b) => b.km - a.km)[0];
    const insights = [
      ["Charge activity", chargeMonth ? `${chargeMonth.acCount + chargeMonth.dcCount + chargeMonth.otherCount} in ${monthLabel(chargeMonth.key)}` : "No charging sessions", chargeMonth ? `${formatNumber(chargeMonth.AC + chargeMonth.DC + chargeMonth.Other, 1)} visible kWh in that month.` : "No charge events could be reconstructed."],
      ["Largest observed day", longest ? `${formatNumber(longest.km)} km` : "No daily span", longest ? `${dateLabel(Date.parse(longest.key + "T12:00:00Z"))} · first-to-last odometer reading that day.` : "At least two timed odometer observations are needed."],
      ["Energy coverage", early ? `${early} incomplete counter${early === 1 ? "" : "s"}` : "Counter tails checked", early ? "Their visible kWh values are lower bounds because the later energy is absent from the files." : "The counter quality flag is derived from session SOC and timing in JSON."]
    ];
    $("insightsGrid").innerHTML = insights.map(([label, value, explanation], index) => `<article class="fd-insight"><span class="fd-insight-index">0${index + 1} / ${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><p>${escapeHtml(explanation)}</p></article>`).join("");
  }

  function drawBars(target, data, series, options = {}) {
    if (!data.length) { emptyChart(target, "No observations in these files"); return; }
    const width = Math.max(600, data.length * 53 + 90);
    const height = 255, left = 47, right = 16, top = 17, bottom = 44;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const largest = Math.max(1, ...data.map((row) => sum(series.map((item) => row[item.key] || 0))));
    const yMax = options.max || Math.ceil(largest / 4) * 4 || 1;
    const step = plotWidth / data.length;
    const barWidth = Math.min(33, step * .62);
    const svg = [`<svg viewBox="0 0 ${width} ${height}" style="min-width:${Math.max(0, width - 50)}px" role="img" aria-label="${escapeHtml(options.label || "Bar chart")}">`];
    for (let index = 0; index <= 4; index++) {
      const y = top + plotHeight - index / 4 * plotHeight;
      svg.push(`<line class="grid" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/><text class="tick" x="${left - 7}" y="${y + 3}" text-anchor="end">${escapeHtml(formatNumber(yMax * index / 4, options.decimals || 0))}</text>`);
    }
    for (let index = 0; index < data.length; index++) {
      const row = data[index];
      const x = left + index * step + (step - barWidth) / 2;
      let y = top + plotHeight;
      for (const item of series) {
        const value = Math.max(0, Number(row[item.key]) || 0);
        const barHeight = value / yMax * plotHeight;
        y -= barHeight;
        if (barHeight > 0) svg.push(`<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="3" fill="${item.color}"><title>${escapeHtml(row.label)} · ${escapeHtml(item.label)}: ${escapeHtml(formatNumber(value, options.decimals || 0))}</title></rect>`);
      }
      svg.push(`<text class="label" x="${left + (index + .5) * step}" y="${height - 18}" text-anchor="middle">${escapeHtml(row.label)}</text>`);
    }
    svg.push(`</svg>`);
    const legend = series.length > 1 ? `<div class="fd-chart-legend">${series.map((item) => `<span><i style="background:${item.color}"></i>${escapeHtml(item.label)}</span>`).join("")}</div>` : "";
    $(target).innerHTML = svg.join("") + legend;
  }

  function drawScatter(target, points, options) {
    const clean = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (!clean.length) { emptyChart(target, options.empty || "No suitable observations in these files"); return; }
    const width = 650, height = 255, left = 52, right = 18, top = 17, bottom = 42;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    let xMin = options.xMin ?? Math.min(...clean.map((point) => point.x));
    let xMax = options.xMax ?? Math.max(...clean.map((point) => point.x));
    let yMin = options.yMin ?? Math.min(0, ...clean.map((point) => point.y));
    let yMax = options.yMax ?? Math.max(...clean.map((point) => point.y)) * 1.08;
    if (xMax === xMin) { xMin -= 1; xMax += 1; }
    if (yMax === yMin) yMax = yMin + 1;
    const xOf = (value) => left + (value - xMin) / (xMax - xMin) * plotWidth;
    const yOf = (value) => top + plotHeight - (value - yMin) / (yMax - yMin) * plotHeight;
    const svg = [`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.label)}">`];
    for (let index = 0; index <= 4; index++) {
      const fraction = index / 4;
      const y = top + plotHeight - fraction * plotHeight;
      const x = left + fraction * plotWidth;
      svg.push(`<line class="grid" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/>`);
      svg.push(`<text class="tick" x="${left - 7}" y="${y + 3}" text-anchor="end">${escapeHtml(options.yTick(yMin + fraction * (yMax - yMin)))}</text>`);
      svg.push(`<text class="tick" x="${x}" y="${height - 16}" text-anchor="middle">${escapeHtml(options.xTick(xMin + fraction * (xMax - xMin)))}</text>`);
    }
    if (Number.isFinite(options.referenceY) && options.referenceY >= yMin && options.referenceY <= yMax) {
      const y = yOf(options.referenceY);
      svg.push(`<line x1="${left}" x2="${width - right}" y1="${y}" y2="${y}" stroke="#ffcb78" stroke-width="1.5" stroke-dasharray="5 4"/>`);
    }
    if (options.connect) {
      const ordered = clean.slice().sort((a, b) => a.x - b.x);
      svg.push(`<polyline fill="none" stroke="${options.color || "#67e2c9"}" stroke-width="2" points="${ordered.map((point) => `${xOf(point.x)},${yOf(point.y)}`).join(" ")}"/>`);
    }
    for (const point of clean) {
      svg.push(`<circle cx="${xOf(point.x)}" cy="${yOf(point.y)}" r="${options.radius || 4}" fill="${point.color || options.color || "#67e2c9"}" fill-opacity=".87" stroke="#092130" stroke-width="1"><title>${escapeHtml(point.title || "Observation")}</title></circle>`);
    }
    svg.push(`</svg>`);
    $(target).innerHTML = svg.join("");
  }

  function drawMix(target, charges) {
    const types = [
      { type: "AC", color: "#67e2c9" },
      { type: "DC", color: "#ffcb78" },
      { type: "Other", color: "#8db8ff" }
    ].map((item) => ({ ...item, count: charges.filter((charge) => chargeType(charge) === item.type).length, kwh: sum(charges.filter((charge) => chargeType(charge) === item.type).map(chargeEnergy)) })).filter((item) => item.count);
    if (!types.length) { emptyChart(target, "No charging sessions in these files"); return; }
    const maxCount = Math.max(...types.map((item) => item.count), 1);
    const maxEnergy = Math.max(...types.map((item) => item.kwh), 1);
    const rows = [];
    for (const item of types) {
      rows.push(`<div class="fd-mix-row"><strong class="fd-tag ${item.type.toLowerCase()}">${escapeHtml(item.type)}</strong><span>Sessions</span><div class="fd-mix-track"><i style="width:${item.count / maxCount * 100}%;background:${item.color}"></i></div><em>${item.count}</em></div>`);
      rows.push(`<div class="fd-mix-row"><strong></strong><span>Visible kWh</span><div class="fd-mix-track"><i style="width:${item.kwh / maxEnergy * 100}%;background:${item.color}"></i></div><em>${escapeHtml(formatNumber(item.kwh, 1))}</em></div>`);
    }
    $(target).innerHTML = `<div class="fd-mix">${rows.join("")}</div>`;
  }

  function renderOverviewCharts(data, monthly) {
    drawBars("mileageChart", monthly.filter((item) => item.km != null).map((item) => ({ label: shortMonth(item.key), km: item.km })), [{ key: "km", label: "km", color: "#67e2c9" }], { label: "Odometer movement by month" });
    drawBars("monthlyEnergyChart", monthly.filter((item) => item.AC + item.DC + item.Other > 0).map((item) => ({ label: shortMonth(item.key), AC: item.AC, DC: item.DC, Other: item.Other })), [
      { key: "AC", label: "AC", color: "#67e2c9" }, { key: "DC", label: "DC", color: "#ffcb78" }, { key: "Other", label: "Other", color: "#8db8ff" }
    ], { label: "Visible charging energy by month", decimals: 0 });
    const days = odometerSpans(data.odometer || [], "day");
    const bins = [
      { label: "0–10", min: 0, max: 10, count: 0 }, { label: "10–25", min: 10, max: 25, count: 0 },
      { label: "25–50", min: 25, max: 50, count: 0 }, { label: "50–100", min: 50, max: 100, count: 0 },
      { label: "100–200", min: 100, max: 200, count: 0 }, { label: "200+", min: 200, max: Infinity, count: 0 }
    ];
    for (const day of days) {
      const bin = bins.find((item) => day.km >= item.min && day.km < item.max);
      if (bin) bin.count++;
    }
    drawBars("dailyDistanceChart", days.length ? bins : [], [{ key: "count", label: "observed days", color: "#8db8ff" }], { label: "Distribution of observed daily distance" });
    drawMix("chargeMixChart", data.charges || []);
    $("monthlyTable").querySelector("tbody").innerHTML = monthly.length ? monthly.map((item) => `<tr><td>${escapeHtml(monthLabel(item.key))}</td><td>${item.km == null ? "—" : `${escapeHtml(formatNumber(item.km))} km`}</td><td>${item.acCount}</td><td>${item.dcCount}</td><td>${item.otherCount}</td><td>${item.resetCount ? "" : item.earlyCount ? "≥" : ""}${escapeHtml(formatNumber(item.AC + item.DC + item.Other, 1))} kWh${item.resetCount ? `<span class="fd-cell-note">${item.resetCount} counter reset${item.resetCount === 1 ? "" : "s"}</span>` : ""}</td></tr>`).join("") : `<tr><td colspan="6">No monthly observations were found.</td></tr>`;
  }

  function renderCharging(data) {
    const charges = data.charges || [];
    const ac = charges.filter((charge) => chargeType(charge) === "AC");
    const dc = charges.filter((charge) => chargeType(charge) === "DC");
    const other = charges.filter((charge) => chargeType(charge) === "Other");
    const early = charges.filter((charge) => charge.earlyCounter);
    const estimated = charges.filter((charge) => Number.isFinite(charge.estimatedTotalKwh));
    const acWithRates = ac.filter((charge) => Number.isFinite(charge.rateKw));
    const acRateBand = acWithRates.filter((charge) => charge.rateKw >= 6 && charge.rateKw <= 12);
    const items = [
      [ac.length, "AC sessions"],
      [dc.length, "DC sessions"],
      [`${visibleEnergyPrefix(charges)}${formatNumber(sum(charges.map(chargeEnergy)), 1)} kWh`, "Visible counter total"],
      [early.length, "Counters that end early"],
      [estimated.length, "Approximate totals available"],
      [acRateBand.length, "AC averages in 6–12 kW band"]
    ];
    if (other.length) items.push([other.length, "Unknown charger type"]);
    $("chargingKpis").innerHTML = items.map(([value, label]) => `<div class="fd-mini-kpi"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("");
    $("rateBandNote").textContent = `${acRateBand.length} of ${acWithRates.length} AC sessions with a measurable rate fall in the 6–12 kW band. Power alone does not establish whether a charge happened at home or a public site.`;
    drawScatter("acRateChart", ac.map((charge) => ({ x: charge.start, y: charge.rateKw, title: `${dateTimeLabel(charge.start)} · ${formatNumber(charge.rateKw, 1)} kW · ${formatNumber(chargeEnergy(charge), 1)} kWh` })), {
      label: "Observed AC session average power over time", empty: "No AC sessions with enough counter readings to calculate an average", color: "#67e2c9", yMin: 0,
      xTick: dateLabel, yTick: (value) => `${Math.round(value)} kW`
    });
    drawScatter("dcSocChart", dc.map((charge) => ({ x: charge.startSoc, y: charge.rateKw, title: `${dateTimeLabel(charge.start)} · ${formatNumber(charge.startSoc)}% SOC · ${formatNumber(charge.rateKw, 1)} kW · ${formatNumber(chargeEnergy(charge), 1)} kWh` })), {
      label: "Observed DC session average power by starting SOC", empty: "No DC sessions with both starting SOC and an observed average rate", color: "#ffcb78", yMin: 0, xMin: 0, xMax: 100,
      xTick: (value) => `${Math.round(value)}%`, yTick: (value) => `${Math.round(value)} kW`
    });
    const months = [...new Set(charges.filter((charge) => Number.isFinite(charge.end)).map((charge) => monthKey(charge.end)))].sort();
    $("chargeMonthFilter").innerHTML = `<option value="all">All months</option>${months.map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(monthLabel(key))}</option>`).join("")}`;
    $("chargeMonthFilter").value = "all";
    $("chargeTypeFilter").value = "all";
    $("chargeQualityFilter").value = "all";
    state.chargeLimit = 80;
    renderChargeTable();
  }

  function visibleChargeRows() {
    const charges = (state.data && state.data.charges) || [];
    const type = $("chargeTypeFilter").value;
    const month = $("chargeMonthFilter").value;
    const quality = $("chargeQualityFilter").value;
    return charges.filter((charge) => {
      if (type !== "all" && chargeType(charge) !== type) return false;
      if (month !== "all" && (!Number.isFinite(charge.end) || monthKey(charge.end) !== month)) return false;
      if (quality === "early" && !charge.earlyCounter) return false;
      if (quality === "complete" && (charge.earlyCounter || !(charge.energySamples > 0))) return false;
      return true;
    });
  }
  function renderChargeTable() {
    if (!state.data) return;
    const matching = visibleChargeRows();
    const shown = matching.slice(0, state.chargeLimit);
    const multiple = Boolean(state.data.meta && state.data.meta.multipleVehicles);
    const header = $("chargeTable").querySelector("thead tr");
    const existingVehicleHead = header.querySelector(".fd-vehicle-head");
    if (multiple && !existingVehicleHead) {
      const th = document.createElement("th"); th.className = "fd-vehicle-head"; th.textContent = "Vehicle"; header.insertBefore(th, header.firstChild);
    } else if (!multiple && existingVehicleHead) existingVehicleHead.remove();
    $("chargeTable").querySelector("tbody").innerHTML = shown.length ? shown.map((charge) => {
      const type = chargeType(charge);
      const energyPresent = Number.isFinite(charge.energyKwh) && charge.energySamples > 0;
      const reset = counterReset(charge);
      const energy = energyPresent ? `${charge.earlyCounter && !reset ? "≥" : ""}${formatNumber(charge.energyKwh, 1)}` : "—";
      const estimateAvailable = Number.isFinite(charge.estimatedTotalKwh);
      const peerEstimate = charge.estimateBasis === "soc_reference";
      const wholeSessionEstimate = peerEstimate && (reset || !energyPresent);
      const peerCount = Number.isFinite(charge.estimateReferenceCount) ? charge.estimateReferenceCount : null;
      const peerSlope = Number.isFinite(charge.estimateReferenceSlopeKwhPerSoc) ? charge.estimateReferenceSlopeKwhPerSoc : null;
      const estimateTitle = estimateAvailable
        ? peerEstimate
          ? `${wholeSessionEstimate ? "Whole-session SOC estimate" : "Recorded subtotal plus an SOC-based missing-tail estimate"} from ${peerCount === null ? "reference sessions" : `${peerCount} reference session${peerCount === 1 ? "" : "s"}`} for the same vehicle and ${type} charging in the selected Ford JSON${peerSlope === null ? "" : `; median ${peerSlope.toFixed(2)} kWh per SOC point`}.${reset ? " This session's counter reset makes its recorded subtotal less certain." : ""} Approximate, not a final Ford reading or guaranteed minimum.`
          : `This session's measured AC rate projects ${formatNumber(charge.estimatedTotalKwh, 1)} kWh; SOC cross-check ${formatNumber(charge.socProjectionKwh, 1)} kWh. Approximate, not a final Ford reading or guaranteed minimum.`
        : charge.estimateReason || (charge.earlyCounter ? "Insufficient evidence to estimate the missing energy" : "No early counter tail needs an estimate");
      const estimateCell = estimateAvailable
        ? `≈${escapeHtml(formatNumber(Math.round(charge.estimatedTotalKwh)))} kWh<span class="fd-cell-note">${wholeSessionEstimate ? "SOC whole session" : peerEstimate ? "SOC from peers" : "Same-session rate"}</span>`
        : `<span class="fd-cell-note">${charge.earlyCounter || !energyPresent ? "Insufficient evidence" : "No estimate needed"}</span>`;
      const counter = `${!energyPresent ? `<span class="fd-tag warn">No reading</span>` : ""}${reset ? `<span class="fd-tag warn" title="The Ford energy counter reset during this session; its reconstructed subtotal is uncertain.">Counter reset</span>` : ""}${charge.earlyCounter ? `<span class="fd-tag warn">Ends early</span>` : !reset && energyPresent ? "No early flag" : ""}`;
      const lastSeen = charge.endStatus === "NO_END_EVENT" || charge.endStatus === "LONG_GAP";
      const status = charge.endStatus ? ` · ${charge.endStatus}` : "";
      return `<tr title="${escapeHtml(`Last status${status}; ${charge.station || "station type unavailable"}`)}">${multiple ? `<td>Vehicle ${escapeHtml(charge.vehicleIndex || 1)}</td>` : ""}<td>${escapeHtml(dateTimeLabel(charge.start))}</td><td>${escapeHtml(dateTimeLabel(charge.end))}${lastSeen ? `<span class="fd-cell-note">last seen</span>` : ""}</td><td>${Number.isFinite(charge.startSoc) ? escapeHtml(formatNumber(charge.startSoc)) + "%" : "—"}</td><td>${Number.isFinite(charge.endSoc) ? escapeHtml(formatNumber(charge.endSoc)) + "%" : "—"}</td><td><span class="fd-tag ${escapeHtml(type.toLowerCase())}">${escapeHtml(type)}</span></td><td class="numeric"${reset ? ` title="Counter reset: reconstructed recorded subtotal is uncertain."` : ""}>${escapeHtml(energy)}</td><td class="numeric fd-estimate" title="${escapeHtml(estimateTitle)}">${estimateCell}</td><td class="numeric">${Number.isFinite(charge.rateKw) ? escapeHtml(formatNumber(charge.rateKw, 1)) : "—"}</td><td>${escapeHtml(formatDuration(charge.durationMinutes))}</td><td>${counter}</td></tr>`;
    }).join("") : `<tr><td colspan="${multiple ? 11 : 10}">No sessions match these filters.</td></tr>`;
    const subtotal = sum(matching.map(chargeEnergy));
    const estimateCount = matching.filter((charge) => Number.isFinite(charge.estimatedTotalKwh)).length;
    $("chargeTableSummary").textContent = `${formatNumber(matching.length)} matching session${matching.length === 1 ? "" : "s"} · ${visibleEnergyPrefix(matching)}${formatNumber(subtotal, 1)} recorded kWh${matching.some(counterReset) ? " (includes counter reset)" : ""} · ${estimateCount} approximate totals`;
    $("chargeTableCount").textContent = `Showing ${formatNumber(shown.length)} of ${formatNumber(matching.length)} sessions`;
    $("chargeLoadMore").hidden = shown.length >= matching.length;
  }

  function renderTravel(data, odometer) {
    const daily = odometerSpans(data.odometer || [], "day");
    const distances = daily.map((row) => row.km);
    const longest = daily.slice().sort((a, b) => b.km - a.km)[0];
    const gps = data.gps || [];
    const areas = new Set(gps.filter((fix) => Number.isFinite(fix.lat) && Number.isFinite(fix.lon)).map((fix) => `${fix.lat.toFixed(1)},${fix.lon.toFixed(1)}`));
    const ignition = data.ignitionSummary || {};
    const mappedCharges = (data.charges || []).filter((charge) => Number.isFinite(charge.lat) && Number.isFinite(charge.lon));
    const mappedAreas = new Set(mappedCharges.map((charge) => `${charge.lat.toFixed(1)},${charge.lon.toFixed(1)}`));
    $("travelIntro").textContent = odometer.km == null ? "No usable timed odometer span was found in this selection." : `The first and last timed odometer readings indicate ${formatNumber(odometer.km)} km across the selected vehicle data. Monthly and daily figures use readings inside each calendar period.`;
    const stories = [
      ["Observed distance", odometer.km == null ? "Unavailable" : `${formatNumber(odometer.km)} km`, `Across ${odometer.validVehicles} vehicle${odometer.validVehicles === 1 ? "" : "s"}; first to last timed reading per vehicle.`],
      ["Observed days", formatNumber(daily.length), daily.length ? `Median first-to-last movement: ${formatNumber(median(distances))} km; 90th percentile: ${formatNumber(percentile(distances, .9))} km.` : "Daily movement needs timed odometer readings."],
      ["Largest observed day", longest ? `${formatNumber(longest.km)} km` : "Unavailable", longest ? `${dateLabel(Date.parse(longest.key + "T12:00:00Z"))} from first to last reading.` : "No daily odometer span."],
      ["GPS observations", formatNumber(gps.length), `${formatNumber(areas.size)} approximate 0.1° areas. These are samples, not a continuous route.`],
      ["Ignition ON intervals", formatNumber(ignition.onIntervals), Number.isFinite(ignition.totalOnHours) ? `${formatNumber(ignition.totalOnHours, 1)} observed hours. An interval is not a verified trip.` : "No paired ON→OFF duration could be calculated."],
      ["Mapped charging stops", formatNumber(mappedCharges.length), `${formatNumber(mappedAreas.size)} approximate areas with a nearby timed GPS fix.`]
    ];
    $("travelStories").innerHTML = stories.map(([label, value, explanation]) => `<article class="fd-story"><span class="eyebrow">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><p>${escapeHtml(explanation)}</p></article>`).join("");
  }

  function monthlyRange80(rows) {
    const daily = new Map();
    for (const row of rows) {
      if (!Number.isFinite(row.t) || !Number.isFinite(row.km)) continue;
      const key = `${row.vehicleIndex || 1}|${dayKey(row.t)}`;
      if (!daily.has(key)) daily.set(key, []);
      daily.get(key).push(row.km);
    }
    const monthly = new Map();
    for (const [key, values] of daily) {
      const month = key.split("|")[1].slice(0, 7);
      if (!monthly.has(month)) monthly.set(month, []);
      monthly.get(month).push(median(values));
    }
    return Array.from(monthly, ([key, values]) => ({ key, km: median(values), days: values.length })).sort((a, b) => a.key.localeCompare(b.key));
  }
  function renderBattery(data) {
    const proxy = (data.batteryProxy || []).map((item) => ({
      x: item.t, y: item.kwhPer100SocPoints,
      title: `${dateTimeLabel(item.t)} · ${formatNumber(item.kwhPer100SocPoints, 1)} reported kWh per 100 SOC points`,
      color: item.type === "DC" ? "#ffcb78" : "#67e2c9"
    })).filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y));
    const values = proxy.map((point) => point.y);
    const middle = median(values);
    const q1 = percentile(values, .25);
    const q3 = percentile(values, .75);
    const range = monthlyRange80(data.range80 || []);
    $("batteryVerdict").textContent = proxy.length ?
      `${proxy.length} well-covered charging sessions yield a median reported counter-energy ratio of ${formatNumber(middle, 1)} kWh per 100 displayed SOC points (middle half: ${formatNumber(q1, 1)}–${formatNumber(q3, 1)}). This is a consistency signal, not the battery's usable capacity or health percentage. No original baseline or direct SoH value appears in the selected JSON.` :
      "The selected files do not contain enough well-covered charging sessions for an energy-per-SOC comparison. They also contain no direct battery health percentage or calibrated capacity measurement.";
    const yMin = proxy.length ? Math.max(0, Math.floor(Math.min(...values) / 10) * 10 - 10) : 0;
    const yMax = proxy.length ? Math.ceil(Math.max(...values) / 10) * 10 + 10 : 100;
    drawScatter("batteryProxyChart", proxy, { label: "Reported charging counter energy per 100 SOC points", empty: "No sessions meet the counter-coverage criteria", xTick: dateLabel, yTick: (value) => `${Math.round(value)}`, yMin, yMax, referenceY: middle, radius: 4 });
    drawScatter("range80Chart", range.map((item) => ({ x: Date.parse(item.key + "-15T12:00:00Z"), y: item.km, title: `${monthLabel(item.key)} · ${formatNumber(item.km)} km · ${item.days} observed days` })), {
      label: "Median displayed range at 80 percent SOC by month", empty: "No range estimates recorded at exactly 80% SOC", xTick: (value) => monthLabel(dayKey(value).slice(0, 7)), yTick: (value) => `${Math.round(value)} km`, color: "#8db8ff", connect: true,
      yMin: range.length ? Math.max(0, Math.floor(Math.min(...range.map((item) => item.km)) / 25) * 25 - 25) : 0
    });
  }

  function renderEvents(data) {
    const ignition = data.ignitionSummary || {};
    const commands = data.commandSummary || {};
    const doors = data.doorSummary || {};
    const warnings = data.warningSummary || {};
    const doorRows = Array.isArray(doors.doors) ? doors.doors : [];
    const frontLeft = doorRows.find((item) => /FRONT.*LEFT|LEFT.*FRONT/i.test(item.door || ""));
    const faultTimes = Array.isArray(warnings.chargingFaultTimes) ? warnings.chargingFaultTimes : [];
    const tpmsTimes = Array.isArray(warnings.tpmsConflictingTimes) ? warnings.tpmsConflictingTimes : [];
    const stories = [
      ["Remote command groups", formatNumber(commands.totalGroups), `${formatNumber(commands.rawTransitions)} transition rows; distinct correlation IDs count requests.`],
      ["Ignition ON intervals", formatNumber(ignition.onIntervals), Number.isFinite(ignition.totalOnHours) ? `${formatNumber(ignition.totalOnHours, 1)} observed hours from paired states, not a trip count.` : "Observed state changes, not verified trips."],
      [frontLeft ? "Front-left door openings" : "Door state changes", frontLeft ? formatNumber(frontLeft.openings) : formatNumber(sum(doorRows.map((item) => item.openings))), "Counted from observed CLOSED→AJAR transitions; some activity may be absent."],
      ["Tailgate openings", formatNumber(doors.hoodOpenings), "Observed closed-to-open state transitions."],
      ["Charging fault signals", formatNumber(faultTimes.length), faultTimes.length ? `Distinct timestamps; latest ${dateLabel(Math.max(...faultTimes))}. Check event details before inferring a lasting fault.` : "No matching charge-system fault signal was found."],
      ["TPMS conflicts", formatNumber(tpmsTimes.length), tpmsTimes.length ? "The export reports conflicting warning states at the same timestamp." : "No same-time conflicting TPMS states were found."]
    ];
    $("eventStories").innerHTML = stories.map(([label, value, explanation]) => `<article class="fd-story"><span class="eyebrow">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><p>${escapeHtml(explanation)}</p></article>`).join("");
    const recordTypes = sortedRows(data.recordTypes);
    $("recordTypesTable").querySelector("tbody").innerHTML = recordTypes.length ? recordTypes.map((item) => `<tr><td><code>${escapeHtml(item.name)}</code></td><td>${escapeHtml(formatNumber(item.count))}</td></tr>`).join("") : `<tr><td colspan="2">No logical records were found.</td></tr>`;
    const commandTypes = Array.isArray(commands.types) ? commands.types : [];
    $("commandTable").querySelector("tbody").innerHTML = commandTypes.length ? commandTypes.map((item) => `<tr><td><code>${escapeHtml(item.type)}</code></td><td>${escapeHtml(formatNumber(item.count))}</td><td>${escapeHtml(formatNumber(item.success))}</td><td>${escapeHtml(formatNumber(item.failure))}</td><td>${escapeHtml(formatNumber(item.timeout))}</td></tr>`).join("") : `<tr><td colspan="5">No command groups were found.</td></tr>`;
    const eventNames = sortedRows(data.eventNames);
    $("eventNamesTable").querySelector("tbody").innerHTML = eventNames.length ? eventNames.map((item) => `<tr><td><code>${escapeHtml(item.name)}</code></td><td>${escapeHtml(formatNumber(item.count))}</td></tr>`).join("") : `<tr><td colspan="2">No named events were found.</td></tr>`;
  }

  function fieldRows(data) {
    return (data.fields || []).map((field) => {
      const definition = fieldDefinitions.get(field.name);
      return { ...field, group: definition ? definition.group : "Unclassified fields", meaning: definition ? definition.meaning : "Observed source field; its meaning is not established by this analysis.", logicalType: definition ? definition.logical_type : "unknown", unit: definition ? definition.unit : null, interpretationBasis: definition ? definition.interpretation_basis : "unknown" };
    });
  }
  function renderFieldTable() {
    if (!state.data) return;
    const query = $("fieldSearch").value.trim().toLowerCase();
    const group = $("fieldGroup").value;
    const rows = fieldRows(state.data).filter((field) => (group === "all" || field.group === group) && (!query || `${field.name} ${field.meaning} ${field.group}`.toLowerCase().includes(query)));
    const total = state.data.meta && state.data.meta.recordCount;
    $("dictionaryTable").querySelector("tbody").innerHTML = rows.length ? rows.map((field) => {
      const share = Number.isFinite(total) && total > 0 ? `${formatNumber(field.count / total * 100, 1)}%` : "—";
      const categories = Object.keys(field.categoryCodes || {}).join(", ") || "—";
      const typeAndUnit = field.unit ? `${field.logicalType} · ${field.unit}` : field.logicalType;
      return `<tr><td><code>${escapeHtml(field.name)}</code></td><td>${escapeHtml(field.meaning)}</td><td>${escapeHtml(typeAndUnit)}</td><td class="numeric">${escapeHtml(formatNumber(field.count))}</td><td class="numeric">${escapeHtml(share)}</td><td>${escapeHtml(categories)}</td><td>${escapeHtml(field.interpretationBasis)}</td></tr>`;
    }).join("") : `<tr><td colspan="7">No fields match this search.</td></tr>`;
    $("fieldCountText").textContent = `${rows.length} of ${(state.data.fields || []).length} observed fields`;
  }
  function observedSchema(data) {
    const meta = data.meta || {};
    const observed = meta.schema || {};
    const attributeKeys = observed.attributeKeys || {};
    const attrCount = meta.rawAttributes || 0;
    const typeRows = observed.attributeKeyTypes || {};
    const properties = {};
    for (const [key, count] of Object.entries(attributeKeys)) {
      const types = Object.entries(typeRows).filter(([name]) => name.startsWith(`${key}:`)).map(([name]) => name.slice(key.length + 1));
      properties[key] = { type: types.length === 1 ? types[0] : types, description: `${count} observed occurrences in the selected Ford files.` };
    }
    if (!properties.attrName) properties.attrName = { type: "string" };
    if (!properties.attrValue) properties.attrValue = { type: "string" };
    return {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      title: "Observed Ford GDPR attrList export",
      description: "Inferred from selected JSON files. This is not an official Ford schema or a guarantee that future exports use the same fields.",
      type: "object",
      required: ["attrList"],
      properties: { attrList: { type: "array", items: { type: "object", required: Object.entries(attributeKeys).filter(([, count]) => count === attrCount && attrCount > 0).map(([key]) => key), properties, additionalProperties: true } } },
      additionalProperties: true,
      "x-observed": {
        fileCount: meta.fileCount || 0,
        attributes: attrCount,
        logicalRecords: meta.recordCount || 0,
        fieldOccurrences: Object.fromEntries((data.fields || []).map((field) => [field.name, field.count])),
        nestedFieldMentions: Object.fromEntries((data.embeddedFields || []).map((field) => [field.path, field.mentions])),
        categoryCodes: observed.categoryCodes || {},
        sequenceNumbers: observed.seqNums || {},
        tableNames: observed.tableNames || {},
        attrValueTypes: observed.attrValueTypes || {}
      }
    };
  }
  function renderDictionary(data) {
    const fields = fieldRows(data);
    const groups = [...new Set(fields.map((field) => field.group))].sort();
    $("fieldGroup").innerHTML = `<option value="all">All groups</option>${groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join("")}`;
    $("fieldGroup").value = "all";
    $("fieldSearch").value = "";
    $("dictionaryIntro").textContent = `${formatNumber(fields.length)} distinct raw field names across ${formatNumber(data.meta && data.meta.rawAttributes)} attribute entries. Occurrence counts are read directly from the selected files; meanings are cautious interpretations of field names and observed formats.`;
    renderFieldTable();
    const nested = data.embeddedFields || [];
    $("embeddedTable").querySelector("tbody").innerHTML = nested.length ? nested.map((field) => {
      const definition = embeddedDefinitions.get(field.path);
      return `<tr><td><code>${escapeHtml(field.path)}</code></td><td>${escapeHtml(definition ? definition.meaning : "Nested value observed in a structured text attribute; meaning not established.")}</td><td>${escapeHtml(definition ? definition.logical_type : "unknown")}</td><td class="numeric">${escapeHtml(formatNumber(field.parentCount))}</td><td class="numeric">${escapeHtml(formatNumber(field.mentions))}</td></tr>`;
    }).join("") : `<tr><td colspan="5">No nested keys were parsed from structured text fields.</td></tr>`;
    state.schema = observedSchema(data);
    $("schemaPreview").textContent = JSON.stringify(state.schema, null, 2);
  }

  function render(data = state.data) {
    if (!data) return;
    const monthly = monthlyData(data);
    const odometer = overallOdometer(data.odometer || []);
    renderKpis(data, monthly, odometer);
    renderOverviewCharts(data, monthly);
    renderCharging(data);
    renderTravel(data, odometer);
    if (state.map) { state.map.destroy(); state.map = null; }
    try {
      state.map = window.FordMap.mount($("mapRoot"), { gps: data.gps || [], charges: data.charges || [], geography, timezone: TZ });
    } catch (error) {
      $("mapRoot").innerHTML = `<div class="fd-note-card">The map could not be drawn: ${escapeHtml(error.message)}</div>`;
    }
    renderBattery(data);
    renderEvents(data);
    renderDictionary(data);
  }

  function csvCell(value) {
    if (value == null || (typeof value === "number" && !Number.isFinite(value))) return "";
    if (typeof value === "number") return String(value);
    let string = String(value);
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(string)) string = "'" + string;
    return `"${string.replace(/"/g, '""')}"`;
  }
  function csvContent(headers, rows) {
    return "\uFEFF" + [headers.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\r\n") + "\r\n";
  }
  function downloadBlob(filename, content, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function utcIso(timestamp) { return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : ""; }
  function downloadCsv(kind) {
    const data = state.data;
    if (!data) return;
    let headers, rows, filename;
    if (kind === "charging") {
      filename = "ford_charging_sessions.csv";
      headers = ["vehicle_index", "start_local_zurich", "start_utc", "end_local_zurich", "end_utc", "start_soc_pct", "end_soc_pct", "charge_type", "station_type", "visible_energy_kwh", "estimated_total_kwh", "estimated_missing_tail_kwh", "soc_crosscheck_total_kwh", "estimate_basis", "estimate_reference_count", "estimate_reference_kwh_per_soc_point", "estimate_method", "estimate_reason", "detected_early_counter", "observed_average_kw", "observed_rate_quality", "duration_minutes", "end_status", "counter_samples", "source_observations", "counter_resets", "first_energy_time_utc", "first_energy_kwh", "first_energy_soc_pct", "last_energy_time_utc", "last_energy_soc_pct", "soc_tail_points", "counter_tail_minutes", "latitude", "longitude", "gps_offset_seconds"];
      rows = (data.charges || []).map((charge) => [charge.vehicleIndex || 1, dateTimeIsoLocal(charge.start), utcIso(charge.start), dateTimeIsoLocal(charge.end), utcIso(charge.end), charge.startSoc, charge.endSoc, charge.type, charge.station, charge.energyKwh, charge.estimatedTotalKwh, charge.estimatedTailKwh, charge.socProjectionKwh, charge.estimateBasis, charge.estimateReferenceCount, charge.estimateReferenceSlopeKwhPerSoc, charge.estimateMethod, charge.estimateReason, Boolean(charge.earlyCounter), charge.rateKw, charge.rateQuality, charge.durationMinutes, charge.endStatus, charge.energySamples, charge.observations, charge.counterResets, utcIso(charge.firstEnergyTime), charge.firstEnergyKwh, charge.firstEnergySoc, utcIso(charge.lastEnergyTime), charge.lastEnergySoc, charge.socTail, charge.minuteTail, charge.lat, charge.lon, charge.gpsOffsetSeconds]);
    } else if (kind === "gps") {
      filename = "ford_gps_observations.csv";
      headers = ["vehicle_index", "time_local_zurich", "time_utc", "latitude", "longitude", "duplicate_source_rows"];
      rows = (data.gps || []).map((fix) => [fix.vehicleIndex || 1, dateTimeIsoLocal(fix.t), utcIso(fix.t), fix.lat, fix.lon, fix.count]);
    } else if (kind === "odometer") {
      filename = "ford_odometer_observations.csv";
      headers = ["vehicle_index", "time_local_zurich", "time_utc", "odometer_km"];
      rows = (data.odometer || []).map((reading) => [reading.vehicleIndex || 1, dateTimeIsoLocal(reading.t), utcIso(reading.t), reading.km]);
    } else if (kind === "battery") {
      filename = "ford_battery_counter_soc_proxy.csv";
      headers = ["vehicle_index", "charge_start_local_zurich", "charge_start_utc", "charge_type", "reported_counter_kwh_per_100_soc_points"];
      rows = (data.batteryProxy || []).map((reading) => [reading.vehicleIndex || 1, dateTimeIsoLocal(reading.t), utcIso(reading.t), reading.type, reading.kwhPer100SocPoints]);
    } else if (kind === "range80") {
      filename = "ford_displayed_range_at_80_soc.csv";
      headers = ["vehicle_index", "time_local_zurich", "time_utc", "displayed_range_km"];
      rows = (data.range80 || []).map((reading) => [reading.vehicleIndex || 1, dateTimeIsoLocal(reading.t), utcIso(reading.t), reading.km]);
    } else if (kind === "events") {
      filename = "ford_event_summary.csv";
      headers = ["kind", "name", "time_local_zurich", "time_utc", "source_records_or_groups", "backend_success", "backend_failure", "timeout"];
      rows = [];
      for (const item of sortedRows(data.recordTypes)) rows.push(["record_type", item.name, "", "", item.count, "", "", ""]);
      for (const item of sortedRows(data.eventNames)) rows.push(["event_name", item.name, "", "", item.count, "", "", ""]);
      for (const item of (data.commandSummary && data.commandSummary.types) || []) rows.push(["command_group", item.type, "", "", item.count, item.success, item.failure, item.timeout]);
      for (const timestamp of (data.warningSummary && data.warningSummary.chargingFaultTimes) || []) rows.push(["charging_fault_signal", "XEV_BATTERY_CHARGE_SYSTEM_FAILURE_DETECTED", dateTimeIsoLocal(timestamp), utcIso(timestamp), 1, "", "", ""]);
      for (const timestamp of (data.warningSummary && data.warningSummary.tpmsConflictingTimes) || []) rows.push(["tpms_conflicting_states", "TIRE_PRESSURE_MONITOR_SYSTEM_WARNING", dateTimeIsoLocal(timestamp), utcIso(timestamp), 1, "", "", ""]);
    } else if (kind === "dictionary") {
      filename = "ford_field_dictionary.csv";
      headers = ["kind", "field_path", "parent_field", "group", "meaning", "logical_type", "unit", "occurrences_or_mentions", "parent_records", "occurrences_per_record_pct", "category_codes", "value_types", "interpretation_basis"];
      const recordCount = data.meta && data.meta.recordCount;
      rows = fieldRows(data).map((field) => ["attribute", field.name, "", field.group, field.meaning, field.logicalType, field.unit, field.count, "", Number.isFinite(recordCount) && recordCount > 0 ? field.count / recordCount * 100 : null, Object.keys(field.categoryCodes || {}).join(";"), Object.keys(field.valueTypes || {}).join(";"), field.interpretationBasis]);
      for (const nested of data.embeddedFields || []) {
        const definition = embeddedDefinitions.get(nested.path);
        rows.push(["nested", nested.path, nested.parent, "Structured text", definition ? definition.meaning : "Nested key observed; meaning not established.", definition ? definition.logical_type : "unknown", "", nested.mentions, nested.parentCount, "", "", Object.keys(nested.valueTypes || {}).join(";"), "observed"]);
      }
    } else return;
    downloadBlob(filename, csvContent(headers, rows), "text/csv;charset=utf-8");
  }
  function handleDownload(event) {
    const button = event.target.closest("[data-download]");
    if (!button) return;
    if (!state.data) return;
    const kind = button.dataset.download;
    if (kind === "schema") downloadBlob("ford_observed_schema.json", JSON.stringify(state.schema, null, 2) + "\n", "application/json;charset=utf-8");
    else downloadCsv(kind);
  }

  $("chooseFiles").addEventListener("click", () => $("jsonFiles").click());
  $("jsonFiles").addEventListener("change", (event) => { setFiles(event.target.files); event.target.value = ""; });
  $("analyzeFiles").addEventListener("click", analyze);
  for (const id of ["chargeTypeFilter", "chargeMonthFilter", "chargeQualityFilter"]) $(id).addEventListener("change", () => { state.chargeLimit = 80; renderChargeTable(); });
  $("chargeLoadMore").addEventListener("click", () => { state.chargeLimit += 80; renderChargeTable(); });
  $("fieldSearch").addEventListener("input", renderFieldTable);
  $("fieldGroup").addEventListener("change", renderFieldTable);
  document.addEventListener("click", handleDownload);
  const dropZone = $("dropZone");
  for (const eventName of ["dragenter", "dragover"]) dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add("dragging"); });
  for (const eventName of ["dragleave", "dragend"]) dropZone.addEventListener(eventName, (event) => { event.preventDefault(); if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove("dragging"); });
  dropZone.addEventListener("drop", (event) => { event.preventDefault(); dropZone.classList.remove("dragging"); setFiles(event.dataTransfer.files); });
})();
