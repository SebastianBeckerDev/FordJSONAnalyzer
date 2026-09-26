/**
 * Optional integration check against original Ford JSON export chunks.
 * Run: node test_real_export.mjs /path/to/export-directory
 * Keep personal export files outside this repository.
 */
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const dashboardDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = process.argv[2];
if (!sourceDirectory) {
  console.log("Real-export check skipped. Pass a directory containing original Ford JSON files to run it.");
  process.exit(0);
}
const exportDirectory = path.resolve(sourceDirectory);
const source = await readFile(path.join(dashboardDirectory, "engine.js"), "utf8");
const jsonNames = (await readdir(exportDirectory)).filter((name) => name.toLowerCase().endsWith(".json")).sort();
const chunkNames = jsonNames.filter((name) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/i.test(name));
const names = chunkNames.length ? chunkNames : jsonNames;
assert(names.length > 0, `No JSON files found in ${exportDirectory}`);

async function browserFiles(selectedNames) {
  return Promise.all(selectedNames.map(async (name) => {
    const fullPath = path.join(exportDirectory, name);
    const size = (await stat(fullPath)).size;
    return {
      name,
      size,
      stream() { return Readable.toWeb(createReadStream(fullPath, { highWaterMark: 256 * 1024 })); }
    };
  }));
}

async function analyze(selectedNames) {
  const files = await browserFiles(selectedNames);
  let resolveResult;
  let rejectResult;
  const completed = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const worker = {
    onmessage: null,
    postMessage(message) {
      if (message.type === "result") resolveResult(message.result);
      if (message.type === "error") rejectResult(new Error(message.message));
    }
  };
  vm.runInNewContext(source, { self: worker, TextDecoder }, { filename: "engine.js" });
  assert.equal(typeof worker.onmessage, "function");
  worker.onmessage({ data: { type: "analyze", files } });
  return completed;
}

function checkResult(result, fileCount) {
  assert.equal(result.meta.fileCount, fileCount);
  assert(result.meta.rawAttributes > 0);
  assert(result.meta.recordCount > 0);
  assert(result.meta.processedRecords > 0);
  assert(result.meta.processedRecords <= result.meta.recordCount);
  assert(Array.isArray(result.charges));
  assert(Array.isArray(result.gps));
  assert(Array.isArray(result.odometer));
  assert(Array.isArray(result.fields));
  for (const charge of result.charges) {
    assert(Number.isFinite(charge.start) && Number.isFinite(charge.end) && charge.end >= charge.start);
    if (charge.energyKwh !== null) assert(charge.energyKwh >= 0);
    if (charge.estimatedTotalKwh !== null) {
      assert(charge.estimatedTotalKwh >= 0);
      assert(["within_session", "soc_reference"].includes(charge.estimateBasis));
      if (charge.estimateBasis === "soc_reference") assert(charge.estimateReferenceCount >= 8);
    }
  }
}

function chargeSignature(result) {
  return Array.from(result.charges, (charge) => [
    charge.vehicleIndex, charge.start, charge.end, charge.type,
    charge.startSoc, charge.endSoc, charge.energyKwh,
    charge.estimatedTotalKwh, charge.estimateBasis
  ]);
}

const full = await analyze(names);
checkResult(full, names.length);
if (names.length > 1) {
  const shuffled = await analyze([...names].reverse());
  checkResult(shuffled, names.length);
  assert.deepEqual(chargeSignature(shuffled), chargeSignature(full), "File order changed charging results");
}
if (names.length > 3) {
  const subset = await analyze(names.slice(0, 3));
  checkResult(subset, 3);
  assert(subset.meta.processedRecords <= full.meta.processedRecords);
}
console.log(`Real-export integration check passed for ${names.length} JSON file${names.length === 1 ? "" : "s"}.`);
