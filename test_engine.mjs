import assert from "node:assert/strict";
import { createReadStream, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const enginePath = join(dirname(fileURLToPath(import.meta.url)), "engine.js");
const source = readFileSync(enginePath, "utf8");
const worker = { onmessage: null, postMessage: () => {} };
vm.runInNewContext(source, { self: worker, TextDecoder }, { filename: enginePath });

function run(files) {
  return new Promise((resolveResult, reject) => {
    worker.postMessage = (message) => {
      if (message.type === "result") resolveResult(message.result);
      if (message.type === "error") reject(new Error(message.message));
      if (message.type === "progress" && process.env.FORD_TEST_PROGRESS === "1") {
        process.stdout.write(`\r${message.percent}% ${message.message}     `);
      }
    };
    worker.onmessage({ data: { type: "analyze", files } });
  });
}

function attribute(attrName, attrValue, categoryCode = "00") {
  return { attrName, attrValue: String(attrValue), categoryCode, seqNum: 1, tableName: "test" };
}

function inMemoryFile(name, entries) {
  const encoded = new TextEncoder().encode(JSON.stringify({ attrList: entries }));
  return {
    name,
    size: encoded.byteLength,
    stream() {
      let offset = 0;
      return new ReadableStream({
        pull(controller) {
          if (offset >= encoded.length) { controller.close(); return; }
          controller.enqueue(encoded.slice(offset, Math.min(offset + 37, encoded.length)));
          offset += 37;
        }
      });
    }
  };
}

function chargeRecord(id, time, status, energy, soc) {
  return [
    attribute("_dfgdia_iso3_country_std_cnty", "DEU"),
    attribute("scvcmf_sha_k", id),
    attribute("scvcmf_vin_n_2", "SYNTHETIC"),
    attribute("scvcmf_pyld_typ_c_2", "Event"),
    attribute("scvcmf_wk_event_n_2", "xev_battery_charge_event"),
    attribute("scvcmf_wks_strt_time_s_2", time),
    attribute("scvcmf_xev_batt_chg_dsply_stat_2.xev_batt_chg_dsply_stat_val", status),
    attribute("scvcmf_xev_batt_chg_dsply_stat_2.chg_pwr_typ", "AC"),
    attribute("scvcmf_xev_chg_stn_pwr_typ_2", "AC_BASIC"),
    attribute("scvcmf_xev_batt_chg_engy_out_2.xev_batt_chg_engy_out_val", energy),
    attribute("scvcmf_xev_batt_st_chg_2.xev_batt_st_chg_val", soc)
  ];
}

async function synthetic() {
  const first = chargeRecord("id-1", "2024-04-20 09:00:00 UTC", "IN_PROGRESS", "0", "40");
  const second = chargeRecord("id-2", "2024-04-20 10:00:00 UTC", "COMPLETED", "10", "52");
  const extra = chargeRecord("id-3", "2024-04-21 12:00:00 UTC", "NOT_PLUGGED_IN", "0", "52");
  const consent = [
    attribute("_dfgdia_iso3_country_std_cnty", "DEU"),
    attribute("scvcmf_sha_k", "consent-1"),
    attribute("scvcmf_vin_n_2", "SYNTHETIC"),
    attribute("scvcmf_pyld_typ_c_2", "Metric"),
    attribute("scvcmf_wks_strt_time_s_2", "2024-04-22 10:00:00 UTC"),
    attribute("scvcmf_enty_lst_x_2", '{value=[{"entityType":"FEATURE","entityId":4,"optIn":"ON"}]}')
  ];
  const consent2 = consent.map((item) => item.attrName === "scvcmf_sha_k" ? { ...item, attrValue: "consent-2" } : item);
  const fileA = inMemoryFile("a.json", first.concat(second.slice(0, 6)));
  const fileB = inMemoryFile("b.json", second.slice(6).concat(extra, consent, consent2));
  const result = await run([fileB, fileA]);
  assert.equal(result.meta.rawAttributes, first.length + second.length + extra.length + consent.length + consent2.length);
  assert.equal(result.meta.recordCount, 5);
  assert.equal(result.meta.processedRecords, 5);
  assert.equal(result.meta.joinedBoundaryRecords, 1);
  assert.equal(result.meta.unmatchedHeads, 0);
  assert.equal(result.meta.unmatchedTails, 0);
  assert.equal(result.charges.length, 1);
  assert.equal(result.charges[0].energyKwh, 10);
  assert.equal(result.charges[0].startSoc, 40);
  assert.equal(result.charges[0].endSoc, 52);
  assert.equal(result.embeddedFields.find((item) => item.path === "scvcmf_enty_lst_x_2.value[].entityType")?.mentions, 2);

  await new Promise((done) => setImmediate(done));
  const completeShort = first.slice(0, 6);
  const partialLong = second.slice(0, 6);
  const subset = await run([inMemoryFile("subset.json", completeShort.concat(partialLong))]);
  assert.equal(subset.meta.recordCount, 1);
  assert.equal(subset.meta.unmatchedTails, 1);

  await new Promise((done) => setImmediate(done));
  const repeatedId = first.map((item) => item.attrName === "scvcmf_wks_strt_time_s_2"
    ? { ...item, attrValue: "2024-04-20 10:00:00 UTC" } : item);
  const duplicate = await run([inMemoryFile("duplicate.json", first.concat(repeatedId))]);
  assert.equal(duplicate.meta.recordCount, 2);
  assert.equal(duplicate.meta.processedRecords, 1);
  assert.equal(duplicate.meta.duplicateIds, 1);
  assert.equal(duplicate.meta.rawAttributes, first.length + repeatedId.length);

  await new Promise((done) => setImmediate(done));
  const earlyRecords = [
    chargeRecord("e-1", "2024-04-23 09:00:00 UTC", "IN_PROGRESS", "0.5", "30"),
    chargeRecord("e-2", "2024-04-23 09:45:00 UTC", "IN_PROGRESS", "6.5", "39"),
    chargeRecord("e-3", "2024-04-23 10:15:00 UTC", "IN_PROGRESS", "10.5", "45"),
    chargeRecord("e-4", "2024-04-23 11:00:00 UTC", "COMPLETED", "", "54"),
    chargeRecord("e-5", "2024-04-24 12:00:00 UTC", "NOT_PLUGGED_IN", "", "54")
  ];
  const earlyResult = await run([inMemoryFile("early.json", earlyRecords.flat())]);
  assert.equal(earlyResult.charges.length, 1);
  assert.equal(earlyResult.charges[0].energyKwh, 10.5);
  assert.equal(earlyResult.charges[0].earlyCounter, true);
  assert.equal(earlyResult.charges[0].estimatedTotalKwh, 16.5);
  assert.equal(earlyResult.charges[0].socProjectionKwh, 16.5);
  assert.equal(earlyResult.charges[0].estimatedTailKwh, 6);

  await new Promise((done) => setImmediate(done));
  const referenceSessions = Array.from({ length: 8 }, (_, index) => {
    const day = String(index + 1).padStart(2, "0");
    const id = `reference-${index}`;
    return [
      chargeRecord(`${id}-start`, `2024-06-${day} 10:00:00 UTC`, "IN_PROGRESS", "0.5", "40"),
      chargeRecord(`${id}-middle`, `2024-06-${day} 10:45:00 UTC`, "IN_PROGRESS", "8.5", "50"),
      chargeRecord(`${id}-end`, `2024-06-${day} 11:30:00 UTC`, "COMPLETED", "16.5", "60")
    ];
  });
  const sparseCharge = [
    chargeRecord("sparse-start", "2024-06-10 10:00:00 UTC", "IN_PROGRESS", "0.5", "60"),
    chargeRecord("sparse-middle", "2024-06-10 10:30:00 UTC", "IN_PROGRESS", "3.5", "64"),
    chargeRecord("sparse-end", "2024-06-10 11:00:00 UTC", "COMPLETED", "", "68")
  ];
  const resetCharge = [
    chargeRecord("reset-start", "2024-06-11 10:00:00 UTC", "IN_PROGRESS", "0.5", "70"),
    chargeRecord("reset-middle", "2024-06-11 10:30:00 UTC", "IN_PROGRESS", "4.5", "75"),
    chargeRecord("reset-counter", "2024-06-11 10:40:00 UTC", "IN_PROGRESS", "0.5", "76"),
    chargeRecord("reset-end", "2024-06-11 11:00:00 UTC", "COMPLETED", "", "80")
  ];
  const noCounterCharge = [
    chargeRecord("missing-start", "2024-06-12 10:00:00 UTC", "IN_PROGRESS", "", "20"),
    chargeRecord("missing-end", "2024-06-12 11:00:00 UTC", "COMPLETED", "", "30")
  ];
  const peerRecords = referenceSessions.flat(2).concat(sparseCharge.flat(), resetCharge.flat(), noCounterCharge.flat());
  const peerResult = await run([inMemoryFile("peer.json", peerRecords)]);
  const sparse = peerResult.charges.find((charge) => charge.start === Date.parse("2024-06-10T10:00:00Z"));
  const reset = peerResult.charges.find((charge) => charge.start === Date.parse("2024-06-11T10:00:00Z"));
  const missing = peerResult.charges.find((charge) => charge.start === Date.parse("2024-06-12T10:00:00Z"));
  assert.equal(sparse?.energyKwh, 3.5);
  assert.equal(sparse?.estimatedTotalKwh, 6.7);
  assert.equal(sparse?.estimateBasis, "soc_reference");
  assert.equal(sparse?.estimateReferenceCount, 8);
  assert.equal(reset?.counterResets, 1);
  assert.equal(reset?.estimatedTotalKwh, 8.3);
  assert.equal(reset?.estimatedTailKwh, null);
  assert.equal(missing?.energyKwh, null);
  assert.equal(missing?.estimatedTotalKwh, 8.3);
  assert.equal(missing?.estimateBasis, "soc_reference");
  await new Promise((done) => setImmediate(done));
  const tooFewReferences = await run([inMemoryFile("few-peers.json", referenceSessions.slice(0, 4).flat(2).concat(sparseCharge.flat()))]);
  assert.equal(tooFewReferences.charges.at(-1).estimatedTotalKwh, null);
  console.log("Synthetic streaming, boundary, charging, and embedded-field checks passed.");
}

function diskFile(path) {
  return {
    name: basename(path),
    size: statSync(path).size,
    stream() { return Readable.toWeb(createReadStream(path, { highWaterMark: 256 * 1024 })); }
  };
}

async function real() {
  const paths = process.argv.slice(3).length ? process.argv.slice(3).map((name) => resolve(name))
    : readdirSync(".").filter((name) => /^[0-9a-f]{8}-[0-9a-f-]{27}\.json$/.test(name)).map((name) => resolve(name));
  if (!paths.length) throw new Error("Pass Ford JSON file paths after --real or run from their directory.");
  const result = await run(paths.map(diskFile));
  console.log("\n", JSON.stringify({
    rawAttributes: result.meta.rawAttributes,
    recordCount: result.meta.recordCount,
    processedRecords: result.meta.processedRecords,
    joinedBoundaryRecords: result.meta.joinedBoundaryRecords,
    unmatchedHeads: result.meta.unmatchedHeads,
    unmatchedTails: result.meta.unmatchedTails,
    chargeEventRecords: result.meta.chargeEventRecords,
    chargeSnapshots: result.meta.chargeSnapshots,
    chargeSessions: result.charges.length,
    chargeTypes: result.charges.reduce((counts, row) => (counts[row.type] = (counts[row.type] || 0) + 1, counts), {}),
    chargeEnergyKwh: result.charges.reduce((sum, row) => sum + (row.energyKwh || 0), 0),
    gps: result.gps.length,
    odometer: result.odometer.length,
    range80: result.range80.length,
    batteryProxy: result.batteryProxy.length,
    commandSummary: result.commandSummary,
    ignitionSummary: result.ignitionSummary,
    doorSummary: result.doorSummary,
    warningSummary: result.warningSummary,
    fieldCount: result.fields.length,
    embeddedFieldCount: result.embeddedFields.length
  }, null, 2));
}

if (process.argv[2] === "--real") await real();
else await synthetic();
