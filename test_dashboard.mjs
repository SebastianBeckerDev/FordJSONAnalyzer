/* A small DOM simulation that checks the one-page controller renders worker data. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const directory = path.dirname(fileURLToPath(import.meta.url));
const template = await readFile(path.join(directory, "index.template.html"), "utf8");
const script = await readFile(path.join(directory, "app.js"), "utf8");
const fieldDefinitions = await readFile(path.join(directory, "field-defs.json"), "utf8");
const geography = await readFile(path.join(directory, "geography.json"), "utf8");
const ids = [...template.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);

class Element {
  constructor(id = "") {
    this.id = id;
    this.hidden = false;
    this.value = "all";
    this.textContent = "";
    this.innerHTML = "";
    this.style = {};
    this.listeners = new Map();
    this.children = [];
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  addEventListener(event, handler) { this.listeners.set(event, handler); }
  querySelector(selector) {
    if (selector === "tbody") return this.tbody ||= new Element();
    if (selector === "thead tr") return this.header ||= new Element();
    if (selector === ".fd-vehicle-head") return this.children.find((child) => child.className === "fd-vehicle-head") || null;
    return null;
  }
  insertBefore(child) { this.children.unshift(child); }
  appendChild(child) { this.children.push(child); }
  click() {}
  remove() {}
  scrollIntoView() {}
}

const elements = new Map(ids.map((id) => [id, new Element(id)]));
elements.get("fieldDefinitions").textContent = fieldDefinitions;
elements.get("offlineGeography").textContent = geography;
elements.get("analysisEngine").textContent = "// fake worker supplies fixture";
let mapMounts = 0;
const documentListeners = new Map();
const document = {
  getElementById(id) { assert(elements.has(id), `Missing template element ${id}`); return elements.get(id); },
  createElement() { return new Element(); },
  addEventListener(event, handler) { documentListeners.set(event, handler); },
  body: new Element()
};
const started = Date.parse("2024-04-23T09:05:00Z");
const ended = Date.parse("2024-04-23T11:05:00Z");
const fixture = {
  meta: { fileCount: 1, rawAttributes: 100, recordCount: 10, processedRecords: 10, rawGpsRows: 1,
    minTimestamp: started, maxTimestamp: ended, unmatchedHeads: 0, unmatchedTails: 0, warnings: [], schema: {
      attributeKeys: { attrName: 100, attrValue: 100 }, attributeKeyTypes: { "attrName:string": 100, "attrValue:string": 100 },
      categoryCodes: { M: 100 }, seqNums: { 1: 100 }, tableNames: { demo: 100 }, attrValueTypes: { string: 100 }
    } },
  fields: [{ name: "scvcmf_xev_batt_chg_dsply_stat_2.chg_pwr_typ", count: 2, categoryCodes: { M: 2 }, valueTypes: { string: 2 } }],
  embeddedFields: [], recordTypes: { Metric: 8, Event: 2 }, eventNames: { xev_battery_charge_event: 2 },
  charges: [{ vehicleIndex: 1, start: started, end: ended, type: "AC", station: "AC", endStatus: "COMPLETED",
    startSoc: 30, endSoc: 54, energyKwh: 10.5, estimatedTotalKwh: 16.5,
    estimatedTailKwh: 6, socProjectionKwh: 16.5,
    estimateBasis: "within_session", estimateReferenceCount: null, estimateReferenceSlopeKwhPerSoc: null,
    estimateMethod: "Measured AC rate × unobserved time; SOC-slope cross-check",
    estimateReason: "Approximate projection; not a final counter reading",
    rateKw: 8, durationMinutes: 120, energySamples: 3,
    counterResets: 0, firstEnergyKwh: 0.5, firstEnergySoc: 30, lastEnergySoc: 45,
    firstEnergyTime: started, lastEnergyTime: ended - 2700000,
    minuteTail: 45, socTail: 9, earlyCounter: true, lat: 35.1, lon: -100.2, gpsOffsetSeconds: 4 }],
  odometer: [{ vehicleIndex: 1, t: started, km: 1234 }, { vehicleIndex: 1, t: ended, km: 1268 }],
  gps: [{ vehicleIndex: 1, t: started, lat: 35.1, lon: -100.2, count: 1 }],
  range80: [{ vehicleIndex: 1, t: ended, km: 310 }],
  batteryProxy: [{ vehicleIndex: 1, t: started, type: "AC", kwhPer100SocPoints: 79 }],
  ignitionSummary: { onIntervals: 1, totalOnHours: 1.5 },
  commandSummary: { totalGroups: 1, rawTransitions: 3, types: [{ type: "LOCK", count: 1, success: 1, failure: 0, timeout: 0 }] },
  doorSummary: { doors: [{ door: "FRONT_LEFT", openings: 2, closings: 2 }], hoodOpenings: 0 },
  warningSummary: { chargingFaultTimes: [], tpmsConflictingTimes: [] }
};
fixture.charges.push({ ...fixture.charges[0], start: started + 86400000, end: ended + 86400000,
  type: "DC", station: "DC", startSoc: 25, endSoc: 45, energyKwh: 8,
  estimatedTotalKwh: 14, estimatedTailKwh: 6, socProjectionKwh: null,
  estimateBasis: "soc_reference", estimateReferenceCount: 8, estimateReferenceSlopeKwhPerSoc: 0.75,
  estimateMethod: "SOC reference from comparable DC sessions", estimateReason: "Approximate SOC reference estimate",
  rateKw: null, lastEnergySoc: 37, socTail: 8 });
fixture.charges.push({ ...fixture.charges[0], start: started + 2 * 86400000, end: ended + 2 * 86400000,
  estimatedTotalKwh: 18.5, estimatedTailKwh: null, socProjectionKwh: null,
  estimateBasis: "soc_reference", estimateReferenceCount: 8, estimateReferenceSlopeKwhPerSoc: 0.74,
  estimateReason: "Approximate whole-session SOC model", counterResets: 1 });
fixture.charges.push({ ...fixture.charges[0], start: started + 3 * 86400000, end: ended + 3 * 86400000,
  energyKwh: 18, earlyCounter: false, estimatedTotalKwh: null, estimatedTailKwh: null,
  socProjectionKwh: null, estimateBasis: null, estimateReason: "No substantial early counter tail detected" });
fixture.charges.push({ ...fixture.charges[0], start: started + 4 * 86400000, end: ended + 4 * 86400000,
  estimatedTotalKwh: null, estimatedTailKwh: null, socProjectionKwh: null,
  estimateBasis: null, estimateReason: "Too few comparable charging sessions" });
class Worker {
  constructor() { this.onmessage = null; }
  postMessage() { queueMicrotask(() => this.onmessage({ data: { type: "result", result: fixture } })); }
  terminate() {}
}
const blobs = [];
const url = { createObjectURL(blob) { blobs.push(blob); return "blob:local-test"; }, revokeObjectURL() {} };
vm.runInNewContext(script, {
  document, window: { FordMap: { mount() { mapMounts++; return { destroy() {} }; } } },
  Worker, Blob, URL: url, Intl, Date, Number, Math, String, Array, Object, Set, Map,
  setTimeout(handler, milliseconds) { const timer = setTimeout(handler, milliseconds); if (milliseconds > 1000) timer.unref(); return timer; }, console
}, { filename: "app.js" });

const file = { name: "sample.json", size: 100, stream() {} };
elements.get("jsonFiles").listeners.get("change")({ target: { files: [file] } });
elements.get("analyzeFiles").listeners.get("click")();
await new Promise((resolve) => setTimeout(resolve, 30));

assert.equal(elements.get("results").hidden, false);
assert.equal(mapMounts, 1);
assert.match(elements.get("chargeTable").tbody.innerHTML, /10\.5/);
assert.match(elements.get("chargeTable").tbody.innerHTML, /≈17 kWh/);
assert.match(elements.get("chargeTable").tbody.innerHTML, /Same-session rate/);
assert.match(elements.get("chargeTable").tbody.innerHTML, /SOC from peers/);
assert.match(elements.get("chargeTable").tbody.innerHTML, /SOC whole session/);
assert.match(elements.get("chargeTable").tbody.innerHTML, /8 reference sessions/);
assert.match(elements.get("chargeTable").tbody.innerHTML, /Insufficient evidence/);
assert.match(elements.get("chargeTable").tbody.innerHTML, /No estimate needed/);
assert.match(elements.get("chargeTable").tbody.innerHTML, /Ends early/);
const chargeRows = [...elements.get("chargeTable").tbody.innerHTML.matchAll(/<tr\b[^>]*>.*?<\/tr>/g)].map((match) => match[0]);
assert.match(chargeRows[2], /Counter reset/);
assert.doesNotMatch(chargeRows[2], /≥10\.5/);
assert.match(elements.get("kpiGrid").innerHTML, /<small>Visible counter energy<\/small><strong>(?!≥)/);
assert.match(elements.get("chargeTableSummary").textContent, /includes counter reset/);
assert.match(elements.get("dictionaryTable").tbody.innerHTML, /chg_pwr_typ/);
assert.match(elements.get("mileageChart").innerHTML, /<svg/);
assert.match(elements.get("batteryProxyChart").innerHTML, /<svg/);
assert.match(elements.get("recordTypesTable").tbody.innerHTML, /Metric/);
documentListeners.get("click")({ target: { closest() { return { dataset: { download: "charging" } }; } } });
const chargingCsv = await blobs.at(-1).text();
assert.match(chargingCsv, /visible_energy_kwh/);
assert.match(chargingCsv, /10\.5/);
const [chargingHeader, chargingRow, peerRow] = chargingCsv.replace(/^\uFEFF/, "").trim().split(/\r?\n/).map((row) => row.split(","));
assert.equal(chargingRow[chargingHeader.indexOf('"visible_energy_kwh"')], "10.5");
assert.equal(chargingRow[chargingHeader.indexOf('"estimated_total_kwh"')], "16.5");
assert.equal(chargingRow[chargingHeader.indexOf('"estimated_missing_tail_kwh"')], "6");
assert.equal(chargingRow[chargingHeader.indexOf('"soc_crosscheck_total_kwh"')], "16.5");
assert.equal(chargingRow[chargingHeader.indexOf('"estimate_basis"')], '"within_session"');
assert.equal(peerRow[chargingHeader.indexOf('"estimate_basis"')], '"soc_reference"');
assert.equal(peerRow[chargingHeader.indexOf('"estimate_reference_count"')], "8");
assert.equal(peerRow[chargingHeader.indexOf('"estimate_reference_kwh_per_soc_point"')], "0.75");
assert.match(chargingCsv, /detected_early_counter/);
for (const kind of ["gps", "odometer", "battery", "range80", "events", "dictionary", "schema"]) {
  documentListeners.get("click")({ target: { closest() { return { dataset: { download: kind } }; } } });
  const content = await blobs.at(-1).text();
  assert(content.length > 30, `${kind} download is empty`);
  if (kind === "schema") assert.equal(JSON.parse(content).properties.attrList.type, "array");
}
console.log("Dashboard rendering smoke test passed.");
