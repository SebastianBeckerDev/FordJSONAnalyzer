/* Ford GDPR export analyzer. Runs entirely inside a browser Worker. */
(() => {
  "use strict";

  const MARKER = "_dfgdia_iso3_country_std_cnty";
  const K = Object.freeze({
    id: "scvcmf_sha_k",
    vin: "scvcmf_vin_n_2",
    type: "scvcmf_pyld_typ_c_2",
    event: "scvcmf_wk_event_n_2",
    eventKind: "scvcmf_event_typ_c_2",
    eventTime: "scvcmf_wk_event_strt_time_s_2",
    vehicleTime: "scvcmf_wks_strt_time_s_2",
    processTime: "df_mapping_start_time",
    condition: "scvcmf_cond_x_2",
    chargeStatus: "scvcmf_xev_batt_chg_dsply_stat_2.xev_batt_chg_dsply_stat_val",
    powerType: "scvcmf_xev_batt_chg_dsply_stat_2.chg_pwr_typ",
    stationType: "scvcmf_xev_chg_stn_pwr_typ_2",
    energy: "scvcmf_xev_batt_chg_engy_out_2.xev_batt_chg_engy_out_val",
    soc: "scvcmf_xev_batt_st_chg_2.xev_batt_st_chg_val",
    range: "scvcmf_xev_batt_rng_2.xev_batt_rng_val",
    timeToFull: "scvcmf_xev_batt_time_to_full_chg_2",
    odometer: "scvcmf_odom_2.odom_val",
    gpsTime: "scvcmf_pos_val_2.gps_mdul_s",
    lat: "scvcmf_pos_val_2.three_d_point_val.latitude",
    lon: "scvcmf_pos_val_2.three_d_point_val.longitude",
    ignition: "scvcmf_ign_stat_2",
    door: "scvcmf_door_stat_2.veh_door",
    doorState: "scvcmf_door_stat_2.door_stat_val",
    hood: "scvcmf_hood_stat_2",
    commandType: "scvcmf_metdta_tags_2.command_type",
    commandId: "scvcmf_crltn_d_2",
    commandState: "scvcmf_to_st_2",
    commandMessage: "scvcmf_msg_x_2",
    indicator: "scvcmf_ind_lite_2.ind_val.well_kn_ind",
    indicatorState: "scvcmf_ind_lite_2.ind_val.ind_st"
  });
  const TERMINAL = new Set(["COMPLETED", "NOT_PLUGGED_IN", "NOT_READY", "STOPPED", "FAULT"]);
  const EMBEDDED_PARENTS = new Set([
    "scvcmf_enty_lst_x_2",
    "scvcmf_plcy_tbl_extn_dta_x_2",
    "scvcmf_usr_friendly_msg_dta_x_2"
  ]);

  let busy = false;
  self.onmessage = (event) => {
    const message = event && event.data;
    if (!message || message.type !== "analyze") return;
    if (busy) {
      self.postMessage({ type: "error", message: "An analysis is already running." });
      return;
    }
    busy = true;
    analyze(message.files).then(
      (result) => self.postMessage({ type: "result", result }),
      (error) => self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) })
    ).finally(() => { busy = false; });
  };

  function postProgress(phase, fileIndex, fileCount, percent, message) {
    self.postMessage({ type: "progress", phase, fileIndex, fileCount, percent, message });
  }

  function increment(map, key, amount = 1) {
    map.set(key, (map.get(key) || 0) + amount);
  }

  function mapObject(map) {
    return Object.fromEntries(map);
  }

  function rawType(value) {
    return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  }

  function numberOrNull(value) {
    if (value === "" || value == null) return null;
    const valueNumber = Number(value);
    return Number.isFinite(valueNumber) ? valueNumber : null;
  }

  function parseUtc(value) {
    if (!value || typeof value !== "string") return null;
    const normalized = value.trim().replace(/^([0-9]{4}-[0-9]{2}-[0-9]{2}) /, "$1T").replace(/ UTC$/, "Z");
    if (!/(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(normalized)) return null;
    const milliseconds = Date.parse(normalized);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  function median(numbers) {
    if (!numbers.length) return null;
    const sorted = numbers.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function signature(attributes) {
    return attributes.map((attribute) => attribute.attrName).join("\u001f");
  }

  function createState(files) {
    return {
      files,
      fileParts: [],
      templates: new Set(),
      fields: new Map(),
      embeddedFields: new Map(),
      schema: {
        attributeKeys: new Map(),
        attributeKeyTypes: new Map(),
        categoryCodes: new Map(),
        seqNums: new Map(),
        tableNames: new Map(),
        attrValueTypes: new Map()
      },
      seenIds: new Set(),
      vinIndexes: new Map(),
      recordTypes: new Map(),
      eventNames: new Map(),
      chargeEvents: [],
      odometerRaw: [],
      gpsRaw: [],
      range80Raw: [],
      ignitionRaw: [],
      doorRaw: [],
      hoodRaw: [],
      commandRaw: [],
      tpmsRaw: [],
      chargingFaultRaw: [],
      meta: {
        fileCount: files.length,
        fileNames: files.map((file) => file.name || "unnamed.json"),
        rawAttributes: 0,
        recordCount: 0,
        processedRecords: 0,
        unmatchedHeads: 0,
        unmatchedTails: 0,
        duplicateIds: 0,
        missingIds: 0,
        chargeEventRecords: 0,
        chargeSnapshots: 0,
        invalidTimestamps: 0,
        embeddedParseErrors: 0,
        minTimestamp: null,
        maxTimestamp: null,
        warnings: []
      }
    };
  }

  function recordEmbedded(state, parent, rawValue) {
    let parsed;
    try {
      if (parent === "scvcmf_enty_lst_x_2") {
        const match = /^\{\s*value\s*=\s*([\s\S]*)\s*\}$/.exec(rawValue);
        if (!match) throw new Error("unexpected consent-list wrapper");
        parsed = { value: JSON.parse(match[1]) };
      } else {
        parsed = JSON.parse(rawValue);
      }
    } catch (_error) {
      state.meta.embeddedParseErrors++;
      return;
    }
    const seenPaths = new Set();
    function visit(value, path) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object") visit(item, `${path}[]`);
          else add(`${path}[]`, item);
        }
      } else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          const childPath = path ? `${path}.${key}` : key;
          add(childPath, child);
          if (child && typeof child === "object") visit(child, childPath);
        }
      }
    }
    function add(path, value) {
      const fullPath = `${parent}.${path}`;
      let field = state.embeddedFields.get(fullPath);
      if (!field) {
        field = { parent, path: fullPath, parentCount: 0, mentions: 0, valueTypes: new Map() };
        state.embeddedFields.set(fullPath, field);
      }
      field.mentions++;
      if (!seenPaths.has(fullPath)) {
        field.parentCount++;
        seenPaths.add(fullPath);
      }
      increment(field.valueTypes, rawType(value));
    }
    visit(parsed, "");
  }

  function observeAttribute(state, attribute) {
    if (!attribute || typeof attribute !== "object" || Array.isArray(attribute) || typeof attribute.attrName !== "string") {
      throw new Error("This JSON file is not a Ford attrList export: an attribute entry is invalid.");
    }
    state.meta.rawAttributes++;
    for (const [key, value] of Object.entries(attribute)) {
      increment(state.schema.attributeKeys, key);
      increment(state.schema.attributeKeyTypes, `${key}:${rawType(value)}`);
    }
    increment(state.schema.categoryCodes, String(attribute.categoryCode));
    increment(state.schema.seqNums, String(attribute.seqNum));
    increment(state.schema.tableNames, String(attribute.tableName));
    increment(state.schema.attrValueTypes, rawType(attribute.attrValue));
    let field = state.fields.get(attribute.attrName);
    if (!field) {
      field = { name: attribute.attrName, count: 0, categoryCodes: new Map(), valueTypes: new Map() };
      state.fields.set(attribute.attrName, field);
    }
    field.count++;
    increment(field.categoryCodes, String(attribute.categoryCode));
    increment(field.valueTypes, rawType(attribute.attrValue));
    if (EMBEDDED_PARENTS.has(attribute.attrName) && typeof attribute.attrValue === "string") {
      recordEmbedded(state, attribute.attrName, attribute.attrValue);
    }
  }

  function vehicleIndex(state, vin) {
    const key = vin || "(missing VIN)";
    if (!state.vinIndexes.has(key)) state.vinIndexes.set(key, state.vinIndexes.size + 1);
    return state.vinIndexes.get(key);
  }

  function processRecord(state, attributes) {
    state.meta.recordCount++;
    const row = Object.create(null);
    for (const attribute of attributes) row[attribute.attrName] = attribute.attrValue;
    const id = row[K.id];
    if (id) {
      if (state.seenIds.has(id)) {
        state.meta.duplicateIds++;
        return;
      }
      state.seenIds.add(id);
    } else {
      state.meta.missingIds++;
    }
    state.meta.processedRecords++;
    const v = vehicleIndex(state, row[K.vin]);
    const type = row[K.type] || "(missing)";
    increment(state.recordTypes, type);
    if (row[K.event]) increment(state.eventNames, row[K.event]);

    const vehicleTime = parseUtc(row[K.vehicleTime]);
    const eventTime = parseUtc(row[K.eventTime]);
    const t = vehicleTime ?? eventTime;
    if (t != null) {
      if (state.meta.minTimestamp == null || t < state.meta.minTimestamp) state.meta.minTimestamp = t;
      if (state.meta.maxTimestamp == null || t > state.meta.maxTimestamp) state.meta.maxTimestamp = t;
    }

    if (row[K.event] === "xev_battery_charge_event") {
      state.meta.chargeEventRecords++;
      if (t != null) {
        state.chargeEvents.push({
          vehicleIndex: v,
          t,
          processTime: parseUtc(row[K.processTime]) ?? t,
          timeRaw: row[K.vehicleTime] || row[K.eventTime] || "",
          status: row[K.chargeStatus] || "",
          type: row[K.powerType] || "",
          station: row[K.stationType] || "",
          energyRaw: row[K.energy] || "",
          socRaw: row[K.soc] || "",
          rangeRaw: row[K.range] || "",
          timeToFullRaw: row[K.timeToFull] || ""
        });
      } else state.meta.invalidTimestamps++;
    }

    if (vehicleTime != null && row[K.odometer] != null) {
      const km = numberOrNull(row[K.odometer]);
      if (km != null) state.odometerRaw.push({ vehicleIndex: v, t: vehicleTime, km });
    }
    if (vehicleTime != null && row[K.soc] != null && row[K.range] != null && numberOrNull(row[K.soc]) === 80) {
      const km = numberOrNull(row[K.range]);
      if (km != null) state.range80Raw.push({ vehicleIndex: v, t: vehicleTime, km });
    }
    if (row[K.gpsTime] != null) {
      const gpsTime = parseUtc(row[K.gpsTime]);
      const lat = numberOrNull(row[K.lat]);
      const lon = numberOrNull(row[K.lon]);
      if (gpsTime != null && lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        state.gpsRaw.push({ vehicleIndex: v, t: gpsTime, lat, lon });
      }
    }
    if (vehicleTime != null && row[K.ignition]) state.ignitionRaw.push({ vehicleIndex: v, t: vehicleTime, state: row[K.ignition] });
    if (vehicleTime != null && row[K.door] && row[K.doorState]) {
      state.doorRaw.push({ vehicleIndex: v, t: vehicleTime, door: row[K.door], state: row[K.doorState] });
    }
    if (vehicleTime != null && row[K.hood]) state.hoodRaw.push({ vehicleIndex: v, t: vehicleTime, state: row[K.hood] });

    if (type === "CommandRequest") state.commandRaw.push({ vehicleIndex: v, request: true });
    if (row[K.commandType] && row[K.commandId]) {
      state.commandRaw.push({
        vehicleIndex: v,
        request: false,
        correlation: row[K.commandId],
        commandType: row[K.commandType],
        toState: row[K.commandState] || "",
        message: row[K.commandMessage] || ""
      });
    }
    if (t != null && row[K.condition] === "XEV_BATTERY_CHARGE_SYSTEM_FAILURE_DETECTED") {
      state.chargingFaultRaw.push({ vehicleIndex: v, t });
    }
    if (t != null && row[K.indicator] === "TIRE_PRESSURE_MONITOR_SYSTEM_WARNING" && row[K.indicatorState]) {
      state.tpmsRaw.push({ vehicleIndex: v, t, state: row[K.indicatorState] });
    }
  }

  /* A file is a single large JSON object containing attrList. The scanner only
     buffers one attribute object at a time, including strings with escaped JSON. */
  async function streamAttributes(file, onAttribute, onBytes) {
    if (!file || typeof file.stream !== "function") throw new Error("A selected file cannot be streamed by this browser.");
    const reader = file.stream().getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let phase = "preamble";
    let preamble = "";
    let rootClosed = false;
    let pieces = [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    let attributes = 0;
    let bytesRead = 0;

    function consume(text) {
      let i = 0;
      while (i < text.length) {
        if (phase === "preamble") {
          const bracket = text.indexOf("[", i);
          if (bracket < 0) {
            preamble += text.slice(i);
            if (preamble.length > 4096) throw new Error("Could not find attrList near the start of the JSON file.");
            break;
          }
          preamble += text.slice(i, bracket + 1);
          if (!/^\uFEFF?\s*\{\s*"attrList"\s*:\s*\[$/.test(preamble)) {
            throw new Error("This file does not begin with a Ford attrList JSON array.");
          }
          phase = "between";
          i = bracket + 1;
          continue;
        }
        if (phase === "between") {
          const c = text[i];
          if (c === " " || c === "\n" || c === "\r" || c === "\t" || c === ",") { i++; continue; }
          if (c === "]") { phase = "after"; i++; continue; }
          if (c !== "{") throw new Error(`Expected an attribute object in attrList near byte ${bytesRead}.`);
          pieces = [];
          depth = 1;
          inString = false;
          escaped = false;
          phase = "item";
        }
        if (phase === "item") {
          const start = i;
          for (; i < text.length; i++) {
            const c = text[i];
            if (inString) {
              if (escaped) escaped = false;
              else if (c === "\\") escaped = true;
              else if (c === '"') inString = false;
            } else if (c === '"') {
              inString = true;
            } else if (c === "{") {
              if (i !== start || depth !== 1) depth++;
            } else if (c === "}") {
              depth--;
              if (depth === 0) {
                pieces.push(text.slice(start, i + 1));
                let attribute;
                try { attribute = JSON.parse(pieces.join("")); }
                catch (error) { throw new Error(`Invalid attribute JSON near byte ${bytesRead}: ${error.message}`); }
                onAttribute(attribute);
                attributes++;
                pieces = [];
                phase = "between";
                i++;
                break;
              }
            }
          }
          if (phase === "item") pieces.push(text.slice(start));
          continue;
        }
        if (phase === "after") {
          const c = text[i++];
          if (c === " " || c === "\n" || c === "\r" || c === "\t") continue;
          if (c === "}" && !rootClosed) { rootClosed = true; continue; }
          throw new Error("Unexpected content after the attrList array.");
        }
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        consume(decoder.decode(value, { stream: true }));
        onBytes(bytesRead);
      }
      const finalText = decoder.decode();
      if (finalText) consume(finalText);
      if (phase !== "after" || !rootClosed) throw new Error("The attrList JSON file ended before its closing brackets.");
      return attributes;
    } finally {
      reader.releaseLock();
    }
  }

  async function parseFile(state, file, fileIndex) {
    const info = { name: file.name || `file-${fileIndex + 1}.json`, head: [], tail: null, markers: 0 };
    let current = null;
    let reported = -1;
    const onAttribute = (attribute) => {
      observeAttribute(state, attribute);
      if (attribute.attrName === MARKER) {
        info.markers++;
        if (current !== null) {
          state.templates.add(signature(current));
          processRecord(state, current);
        }
        current = [attribute];
      } else if (current === null) {
        info.head.push(attribute);
        if (info.head.length > 10000) throw new Error(`${info.name} has no record marker near its start.`);
      } else {
        current.push(attribute);
      }
    };
    const onBytes = (bytesRead) => {
      const portion = file.size ? Math.min(1, bytesRead / file.size) : 1;
      const overall = Math.floor(((fileIndex + portion) / state.files.length) * 84);
      if (overall > reported) {
        reported = overall;
        postProgress("reading", fileIndex + 1, state.files.length, overall, `Reading ${info.name}`);
      }
    };
    postProgress("reading", fileIndex + 1, state.files.length, Math.floor(fileIndex / state.files.length * 84), `Reading ${info.name}`);
    await streamAttributes(file, onAttribute, onBytes);
    if (!info.markers) throw new Error(`${info.name} contains no Ford record markers.`);
    info.tail = current;
    state.fileParts.push(info);
  }

  function stitchBoundaries(state) {
    const parts = state.fileParts;
    const unmatchedHeads = new Set(parts.filter((part) => part.head.length));
    const unmatchedTails = new Set(parts.filter((part) => part.tail && part.tail.length));
    const joined = [];
    // Exact field-order signatures are learned from complete records in the same upload.
    // A split record is joined only when both sides identify a unique match.
    let changed = true;
    while (changed) {
      changed = false;
      for (const headPart of Array.from(unmatchedHeads)) {
        const candidates = Array.from(unmatchedTails).filter((tailPart) =>
          tailPart !== headPart && state.templates.has(signature(tailPart.tail.concat(headPart.head)))
        );
        if (candidates.length !== 1) continue;
        const tailPart = candidates[0];
        const headsForTail = Array.from(unmatchedHeads).filter((otherHead) =>
          otherHead !== tailPart && state.templates.has(signature(tailPart.tail.concat(otherHead.head)))
        );
        if (headsForTail.length !== 1) continue;
        joined.push(tailPart.tail.concat(headPart.head));
        unmatchedHeads.delete(headPart);
        unmatchedTails.delete(tailPart);
        changed = true;
      }
    }
    for (const record of joined) processRecord(state, record);
    for (const tailPart of Array.from(unmatchedTails)) {
      const names = tailPart.tail.map((attribute) => attribute.attrName);
      const timePosition = Math.max(names.indexOf(K.vehicleTime), names.indexOf(K.eventTime));
      const tailSignature = signature(tailPart.tail);
      const knownLongerTemplate = Array.from(state.templates).some((template) => template.startsWith(`${tailSignature}\u001f`));
      // A bare metadata tail can look exactly like a shorter complete record.
      // Require evidence of a payload after the record timestamp as well.
      if (timePosition >= 0 && names.length > timePosition + 1 &&
          state.templates.has(tailSignature) && !knownLongerTemplate) {
        processRecord(state, tailPart.tail);
        unmatchedTails.delete(tailPart);
      }
    }
    state.meta.unmatchedHeads = unmatchedHeads.size;
    state.meta.unmatchedTails = unmatchedTails.size;
    state.meta.joinedBoundaryRecords = joined.length;
    if (unmatchedHeads.size || unmatchedTails.size) {
      state.meta.warnings.push(`${unmatchedHeads.size} leading and ${unmatchedTails.size} trailing record fragments could not be joined safely; totals may be incomplete.`);
    }
  }

  function uniqueBy(rows, keyFunction) {
    const result = new Map();
    for (const row of rows) {
      const key = keyFunction(row);
      if (!result.has(key)) result.set(key, row);
    }
    return Array.from(result.values());
  }

  function sortTimed(rows) {
    rows.sort((a, b) => a.t - b.t || a.vehicleIndex - b.vehicleIndex);
    return rows;
  }

  function chargeSnapshots(state) {
    const events = uniqueBy(state.chargeEvents, (row) => JSON.stringify([
      row.vehicleIndex, row.timeRaw, row.status, row.type, row.station,
      row.energyRaw, row.socRaw, row.rangeRaw, row.timeToFullRaw
    ]));
    events.sort((a, b) => a.vehicleIndex - b.vehicleIndex || a.t - b.t || a.processTime - b.processTime);
    state.meta.chargeSnapshots = events.length;
    return events;
  }

  function mostCommon(map) {
    let name = "UNKNOWN";
    let largest = 0;
    for (const [key, count] of map) {
      if (count > largest) { name = key; largest = count; }
    }
    return name;
  }

  function newCharge(event) {
    const soc = numberOrNull(event.socRaw);
    return {
      vehicleIndex: event.vehicleIndex,
      start: event.t,
      lastProgress: event.t,
      firstEnergyTime: null,
      lastEnergyTime: null,
      firstEnergy: null,
      firstEnergySoc: null,
      lastEnergySoc: null,
      segmentPeak: 0,
      completedSegmentsKwh: 0,
      counterResets: 0,
      lastEnergy: null,
      startSoc: soc,
      endSoc: soc,
      powerTypes: new Map(),
      stationTypes: new Map(),
      energySamples: 0,
      observations: 0
    };
  }

  function addChargeProgress(session, event) {
    session.lastProgress = event.t;
    session.observations++;
    const soc = numberOrNull(event.socRaw);
    if (soc != null) session.endSoc = soc;
    if (event.type && event.type !== "UNKNOWN") increment(session.powerTypes, event.type);
    if (event.station && event.station !== "UNKNOWN") increment(session.stationTypes, event.station);
    const energy = numberOrNull(event.energyRaw);
    if (energy == null) return;
    session.energySamples++;
    if (session.firstEnergy === null) {
      session.firstEnergy = energy;
      session.firstEnergyTime = event.t;
      session.firstEnergySoc = soc;
    }
    if (session.lastEnergy !== null && energy < session.lastEnergy - 0.75) {
      session.completedSegmentsKwh += session.segmentPeak;
      session.segmentPeak = energy;
      session.counterResets++;
    } else {
      session.segmentPeak = Math.max(session.segmentPeak, energy);
    }
    session.lastEnergy = energy;
    session.lastEnergyTime = event.t;
    session.lastEnergySoc = soc;
  }

  // A small, explicitly unmeasured projection for AC sessions whose energy
  // counter ends well before a terminal SOC. Both extrapolations must agree.
  function estimateMissingAcTail(session, endStatus, energyKwh, socTail, minuteTail, earlyCounter) {
    const unavailable = (reason) => ({ estimatedTotalKwh: null, estimatedTailKwh: null,
      socProjectionKwh: null, estimateBasis: null, estimateMethod: null, estimateReason: reason,
      estimateReferenceCount: null, estimateReferenceSlopeKwhPerSoc: null });
    if (!earlyCounter) return unavailable("No substantial early counter tail detected");
    if (mostCommon(session.powerTypes) !== "AC") return unavailable("Estimate is limited to AC charging");
    if (!["COMPLETED", "STOPPED", "NOT_PLUGGED_IN"].includes(endStatus)) return unavailable("No suitable terminal charging state");
    if (session.counterResets) return unavailable("Counter reset during the session");
    if (energyKwh == null || session.firstEnergy == null || session.firstEnergySoc == null ||
        session.lastEnergySoc == null || session.firstEnergyTime == null || session.lastEnergyTime == null ||
        socTail == null || minuteTail == null) return unavailable("Missing counter, time or SOC readings");
    if (socTail < 2) return unavailable("Less than two SOC points remain after the last counter reading");
    if (minuteTail <= 0 || minuteTail > 120) return unavailable("Unobserved time span is outside the estimate range");
    const measuredSoc = session.lastEnergySoc - session.firstEnergySoc;
    const measuredEnergy = energyKwh - session.firstEnergy;
    const measuredHours = (session.lastEnergyTime - session.firstEnergyTime) / 3600000;
    const shortTail = socTail < 4;
    if (measuredSoc < (shortTail ? 6 : 8) || measuredEnergy < (shortTail ? 4 : 5) ||
        measuredHours < (shortTail ? 1 : 0.5)) {
      return unavailable("Not enough measured SOC, energy and time before the counter stopped");
    }
    const measuredRateKw = measuredEnergy / measuredHours;
    if (socTail > measuredSoc || minuteTail / 60 > measuredHours || measuredRateKw < 1 || measuredRateKw > 22) {
      return unavailable("Missing tail is too long or the measured AC rate is implausible");
    }
    const timeProjection = energyKwh + measuredRateKw * (minuteTail / 60);
    const socProjection = energyKwh + measuredEnergy / measuredSoc * socTail;
    if (!Number.isFinite(timeProjection) || !Number.isFinite(socProjection) ||
        Math.abs(timeProjection - socProjection) > (shortTail ? 0.75 : 1.5)) {
      return unavailable("Time and SOC projections do not agree closely enough");
    }
    return {
      estimatedTotalKwh: Math.round(timeProjection * 10) / 10,
      estimatedTailKwh: Math.round((timeProjection - energyKwh) * 10) / 10,
      socProjectionKwh: Math.round(socProjection * 10) / 10,
      estimateBasis: "within_session",
      estimateMethod: "Measured AC rate × unobserved time; SOC-slope cross-check",
      estimateReason: "Approximate projection; not a final counter reading",
      estimateReferenceCount: null,
      estimateReferenceSlopeKwhPerSoc: null
    };
  }

  function finishCharge(session, endTime, endStatus) {
    const end = endTime ?? session.lastProgress;
    const durationMinutes = (end - session.start) / 60000;
    const energyKwh = session.energySamples ? session.completedSegmentsKwh + session.segmentPeak : null;
    const measuredHours = session.lastEnergyTime != null && session.firstEnergyTime != null
      ? (session.lastEnergyTime - session.firstEnergyTime) / 3600000 : 0;
    const rateKw = energyKwh != null && session.firstEnergy != null && measuredHours > 0 && energyKwh > session.firstEnergy
      ? (energyKwh - session.firstEnergy) / measuredHours : null;
    const windowRateKw = energyKwh != null && durationMinutes > 0 && endStatus !== "NO_END_EVENT" && endStatus !== "LONG_GAP"
      ? energyKwh / (durationMinutes / 60) : null;
    const socTail = session.endSoc != null && session.lastEnergySoc != null
      ? session.endSoc - session.lastEnergySoc : null;
    const minuteTail = session.lastEnergyTime != null ? (end - session.lastEnergyTime) / 60000 : null;
    const earlyCounter = (socTail != null && socTail >= 4) || (minuteTail != null && minuteTail >= 15);
    const estimate = estimateMissingAcTail(session, endStatus, energyKwh, socTail, minuteTail, earlyCounter);
    return {
      vehicleIndex: session.vehicleIndex,
      start: session.start,
      end,
      type: mostCommon(session.powerTypes),
      station: mostCommon(session.stationTypes),
      endStatus,
      startSoc: session.startSoc,
      endSoc: session.endSoc,
      energyKwh,
      rateKw,
      windowRateKw,
      durationMinutes,
      firstEnergyTime: session.firstEnergyTime,
      lastEnergyTime: session.lastEnergyTime,
      firstEnergyKwh: session.firstEnergy,
      firstEnergySoc: session.firstEnergySoc,
      lastEnergySoc: session.lastEnergySoc,
      socTail,
      minuteTail,
      counterResets: session.counterResets,
      energySamples: session.energySamples,
      observations: session.observations,
      earlyCounter,
      ...estimate,
      rateQuality: rateKw == null || energyKwh == null || energyKwh < 2 ? "insufficient energy samples"
        : earlyCounter ? "measured portion only; counter ends early" : "measured portion",
      lat: null,
      lon: null,
      gpsOffsetSeconds: null
    };
  }

  function deriveCharges(events) {
    const charges = [];
    let active = null;
    for (const event of events) {
      if (active && active.vehicleIndex !== event.vehicleIndex) {
        charges.push(finishCharge(active, active.lastProgress, "NO_END_EVENT"));
        active = null;
      }
      if (event.status === "IN_PROGRESS") {
        if (active && event.t - active.lastProgress > 18 * 3600000) {
          charges.push(finishCharge(active, active.lastProgress, "LONG_GAP"));
          active = null;
        }
        if (!active) active = newCharge(event);
        addChargeProgress(active, event);
      } else if (TERMINAL.has(event.status) && active) {
        addChargeProgress(active, event);
        charges.push(finishCharge(active, event.t, event.status));
        active = null;
      }
    }
    if (active) charges.push(finishCharge(active, active.lastProgress, "NO_END_EVENT"));
    charges.sort((a, b) => a.start - b.start || a.vehicleIndex - b.vehicleIndex);
    return charges;
  }

  // A weaker fallback: infer missing energy from well-covered sessions of the
  // same vehicle and AC/DC type in this import. This is never a measured kWh
  // minimum, even when the following status has a higher SOC.
  function addSocReferenceEstimates(charges) {
    const references = new Map();
    for (const charge of charges) {
      if (!["AC", "DC"].includes(charge.type) || charge.earlyCounter || charge.counterResets ||
          !["COMPLETED", "STOPPED", "NOT_PLUGGED_IN"].includes(charge.endStatus) ||
          charge.energySamples < 3 || !Number.isFinite(charge.energyKwh) || charge.energyKwh < 10 ||
          !Number.isFinite(charge.firstEnergyKwh) || !Number.isFinite(charge.firstEnergySoc) ||
          !Number.isFinite(charge.lastEnergySoc) || !Number.isFinite(charge.startSoc) ||
          !Number.isFinite(charge.endSoc) || charge.startSoc < 0 || charge.endSoc > 100 ||
          !Number.isFinite(charge.socTail) ||
          !Number.isFinite(charge.minuteTail) || charge.socTail < 0 || charge.socTail > 2 ||
          charge.minuteTail < 0 || charge.minuteTail > 12) continue;
      const measuredSoc = charge.lastEnergySoc - charge.firstEnergySoc;
      const measuredEnergy = charge.energyKwh - charge.firstEnergyKwh;
      const fullSoc = charge.endSoc - charge.startSoc;
      if (measuredSoc < 10 || measuredEnergy < 5 || fullSoc < 10) continue;
      const tailSlope = measuredEnergy / measuredSoc;
      const fullSlope = charge.energyKwh / fullSoc;
      if (tailSlope < 0.2 || tailSlope > 2 || fullSlope < 0.2 || fullSlope > 2) continue;
      const key = `${charge.vehicleIndex}:${charge.type}`;
      if (!references.has(key)) references.set(key, []);
      references.get(key).push({ tailSlope, fullSlope });
    }
    const calibrated = new Map();
    for (const [key, rows] of references) {
      const center = median(rows.map((row) => row.tailSlope));
      const stable = rows.filter((row) => Math.abs(row.tailSlope / center - 1) <= 0.2);
      if (stable.length >= 8) calibrated.set(key, {
        tailSlope: median(stable.map((row) => row.tailSlope)),
        fullSlope: median(stable.map((row) => row.fullSlope)),
        count: stable.length
      });
    }
    for (const charge of charges) {
      if (Number.isFinite(charge.estimatedTotalKwh) || !["AC", "DC"].includes(charge.type) ||
          !["COMPLETED", "STOPPED", "NOT_PLUGGED_IN"].includes(charge.endStatus) ||
          !Number.isFinite(charge.startSoc) || !Number.isFinite(charge.endSoc) ||
          charge.startSoc < 0 || charge.endSoc > 100) continue;
      const hasCounter = Number.isFinite(charge.energyKwh) && charge.energySamples > 0;
      if (hasCounter && (!charge.earlyCounter || !Number.isFinite(charge.lastEnergySoc) ||
          !Number.isFinite(charge.socTail) || charge.socTail < 2 || charge.socTail > 10 ||
          !Number.isFinite(charge.minuteTail) || charge.minuteTail <= 0 || charge.minuteTail > 120 ||
          charge.lastEnergySoc < charge.startSoc)) continue;
      if (!hasCounter && (charge.endSoc - charge.startSoc < 4 ||
          charge.durationMinutes < 10 || charge.durationMinutes > 1440)) continue;
      const reference = calibrated.get(`${charge.vehicleIndex}:${charge.type}`);
      if (!reference) {
        charge.estimateReason = "Too few comparable charging sessions in the selected JSON files";
        continue;
      }
      const useFullSoc = !hasCounter || charge.counterResets > 0;
      if (useFullSoc) {
        const fullSoc = charge.endSoc - charge.startSoc;
        if (fullSoc < 4 || fullSoc > 50) continue;
        const estimated = reference.fullSlope * fullSoc;
        if (hasCounter && estimated < charge.energyKwh - 0.5) {
          charge.estimateReason = "SOC-based total is below this session's recorded counter subtotal";
          continue;
        }
        charge.estimatedTotalKwh = Math.round(estimated * 10) / 10;
        charge.estimatedTailKwh = null;
      } else {
        const measuredSoc = Number.isFinite(charge.firstEnergySoc)
          ? charge.lastEnergySoc - charge.firstEnergySoc : null;
        const measuredEnergy = Number.isFinite(charge.firstEnergyKwh)
          ? charge.energyKwh - charge.firstEnergyKwh : null;
        if (measuredSoc !== null && measuredSoc >= 2 && measuredEnergy !== null) {
          const ownSlope = measuredEnergy / measuredSoc;
          if (ownSlope < reference.tailSlope * 0.65 || ownSlope > reference.tailSlope * 1.35) {
            charge.estimateReason = "This session's counter and SOC readings disagree with the reference sessions";
            continue;
          }
        }
        const estimatedTail = reference.tailSlope * charge.socTail;
        charge.estimatedTotalKwh = Math.round((charge.energyKwh + estimatedTail) * 10) / 10;
        charge.estimatedTailKwh = Math.round(estimatedTail * 10) / 10;
      }
      charge.estimateBasis = "soc_reference";
      charge.estimateMethod = useFullSoc
        ? `Same-vehicle ${charge.type} full-session energy per SOC point from selected JSON files`
        : `Same-vehicle ${charge.type} measured energy per SOC point from selected JSON files`;
      charge.estimateReason = charge.counterResets
        ? "Approximate whole-session SOC model; this session's counter reset makes its recorded subtotal less certain"
        : "Approximate SOC-based projection; not a final counter reading or guaranteed minimum";
      charge.estimateReferenceCount = reference.count;
      charge.estimateReferenceSlopeKwhPerSoc = Math.round((useFullSoc ? reference.fullSlope : reference.tailSlope) * 1000) / 1000;
    }
  }

  function dedupeGps(state) {
    const grouped = new Map();
    for (const row of state.gpsRaw) {
      const key = JSON.stringify([row.vehicleIndex, row.t, row.lat, row.lon]);
      const existing = grouped.get(key);
      if (existing) existing.count++;
      else grouped.set(key, { ...row, count: 1 });
    }
    return sortTimed(Array.from(grouped.values()));
  }

  function locateCharges(charges, gps) {
    const byVehicle = new Map();
    for (const fix of gps) {
      if (!byVehicle.has(fix.vehicleIndex)) byVehicle.set(fix.vehicleIndex, []);
      byVehicle.get(fix.vehicleIndex).push(fix);
    }
    let unlocated = 0;
    for (const charge of charges) {
      const fixes = byVehicle.get(charge.vehicleIndex) || [];
      if (!fixes.length) { unlocated++; continue; }
      let lo = 0;
      let hi = fixes.length;
      while (lo < hi) {
        const middle = (lo + hi) >> 1;
        if (fixes[middle].t < charge.start) lo = middle + 1;
        else hi = middle;
      }
      const candidates = [];
      if (lo > 0) candidates.push(fixes[lo - 1]);
      if (lo < fixes.length) candidates.push(fixes[lo]);
      const nearest = candidates.reduce((best, fix) => !best || Math.abs(fix.t - charge.start) < Math.abs(best.t - charge.start) ? fix : best, null);
      const separation = Math.abs(nearest.t - charge.start) / 1000;
      if (separation > 300) { unlocated++; continue; }
      charge.lat = nearest.lat;
      charge.lon = nearest.lon;
      charge.gpsOffsetSeconds = separation;
    }
    return unlocated;
  }

  function summarizeIgnition(raw) {
    const values = uniqueBy(raw, (row) => JSON.stringify([row.vehicleIndex, row.t, row.state]));
    values.sort((a, b) => a.vehicleIndex - b.vehicleIndex || a.t - b.t || a.state.localeCompare(b.state));
    let offToOn = 0;
    let onToOff = 0;
    let onIntervals = 0;
    let openOnInterval = false;
    const durations = [];
    let previous = null;
    let started = null;
    let vehicle = null;
    for (const row of values) {
      if (row.vehicleIndex !== vehicle) {
        vehicle = row.vehicleIndex;
        previous = null;
        started = null;
      }
      if (row.state === previous) continue;
      if (previous === "OFF" && row.state === "ON") offToOn++;
      if (previous === "ON" && row.state === "OFF") {
        onToOff++;
        if (started != null && row.t >= started) {
          onIntervals++;
          durations.push((row.t - started) / 60000);
        }
      }
      if (row.state === "ON") started = row.t;
      else if (row.state === "OFF") started = null;
      previous = row.state;
    }
    if (previous === "ON") openOnInterval = true;
    return {
      rawRecords: raw.length,
      uniqueSnapshots: values.length,
      onIntervals,
      totalOnHours: durations.reduce((sum, minutes) => sum + minutes, 0) / 60,
      medianOnMinutes: median(durations),
      offToOn,
      onToOff,
      openOnInterval
    };
  }

  function summarizeDoors(doorRaw, hoodRaw) {
    const doors = uniqueBy(doorRaw, (row) => JSON.stringify([row.vehicleIndex, row.t, row.door, row.state]));
    doors.sort((a, b) => a.vehicleIndex - b.vehicleIndex || a.door.localeCompare(b.door) || a.t - b.t || a.state.localeCompare(b.state));
    const counts = new Map();
    const lastState = new Map();
    for (const row of doors) {
      if (!counts.has(row.door)) counts.set(row.door, { door: row.door, openings: 0, closings: 0 });
      const key = `${row.vehicleIndex}:${row.door}`;
      const old = lastState.get(key);
      if (old === "CLOSED" && row.state === "AJAR") counts.get(row.door).openings++;
      if (old === "AJAR" && row.state === "CLOSED") counts.get(row.door).closings++;
      lastState.set(key, row.state);
    }
    const hoods = uniqueBy(hoodRaw, (row) => JSON.stringify([row.vehicleIndex, row.t, row.state]));
    hoods.sort((a, b) => a.vehicleIndex - b.vehicleIndex || a.t - b.t || a.state.localeCompare(b.state));
    let hoodOpenings = 0;
    let oldHood = null;
    let oldVehicle = null;
    for (const row of hoods) {
      if (row.vehicleIndex !== oldVehicle) { oldHood = null; oldVehicle = row.vehicleIndex; }
      if (oldHood === "CLOSED" && row.state === "AJAR") hoodOpenings++;
      oldHood = row.state;
    }
    return {
      rawDoorRows: doorRaw.length,
      uniqueDoorSnapshots: doors.length,
      rawHoodRows: hoodRaw.length,
      hoodOpenings,
      doors: Array.from(counts.values()).sort((a, b) => b.openings - a.openings || a.door.localeCompare(b.door))
    };
  }

  function summarizeCommands(raw) {
    const requests = raw.filter((row) => row.request).length;
    const transitions = raw.filter((row) => !row.request);
    const grouped = new Map();
    for (const row of transitions) {
      const key = `${row.vehicleIndex}:${row.correlation}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }
    const types = new Map();
    for (const rows of grouped.values()) {
      const commandType = rows.find((row) => row.commandType)?.commandType || "UNKNOWN";
      if (!types.has(commandType)) {
        types.set(commandType, { type: commandType, count: 0, success: 0, failure: 0, timeout: 0, noExplicitTerminal: 0 });
      }
      const total = types.get(commandType);
      total.count++;
      const states = new Set(rows.map((row) => row.toState.toLowerCase()));
      if (states.has("failure")) total.failure++;
      else if (states.has("success")) total.success++;
      else if (rows.some((row) => /expiration deadline|timed out|timeout/i.test(row.message))) total.timeout++;
      else total.noExplicitTerminal++;
    }
    return {
      rawTransitions: transitions.length,
      commandRequests: requests,
      totalGroups: grouped.size,
      types: Array.from(types.values()).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
    };
  }

  function summarizeWarnings(chargingFaultRaw, tpmsRaw) {
    const chargingFaultTimes = Array.from(new Set(chargingFaultRaw.map((row) => row.t))).sort((a, b) => a - b);
    const tpms = uniqueBy(tpmsRaw, (row) => JSON.stringify([row.vehicleIndex, row.t, row.state]));
    tpms.sort((a, b) => a.t - b.t || a.vehicleIndex - b.vehicleIndex || a.state.localeCompare(b.state));
    const timeStates = new Map();
    for (const row of tpms) {
      if (!timeStates.has(row.t)) timeStates.set(row.t, new Set());
      timeStates.get(row.t).add(row.state);
    }
    return {
      chargingFaultRawRecords: chargingFaultRaw.length,
      chargingFaultTimes,
      tpmsRawRecords: tpmsRaw.length,
      tpms: tpms.map((row) => ({ t: row.t, state: row.state, vehicleIndex: row.vehicleIndex })),
      tpmsConflictingTimes: Array.from(timeStates).filter(([, states]) => states.size > 1).map(([t]) => t).sort((a, b) => a - b)
    };
  }

  function selectedBatteryProxy(charges) {
    const result = [];
    for (const charge of charges) {
      if (charge.energyKwh == null || charge.energyKwh < 10 ||
          charge.startSoc == null || charge.endSoc == null || charge.endSoc - charge.startSoc < 10 ||
          charge.lastEnergySoc == null || charge.lastEnergySoc <= charge.startSoc ||
          charge.socTail == null || charge.socTail > 2 ||
          charge.minuteTail == null || charge.minuteTail > 12 || charge.counterResets) continue;
      result.push({
        t: charge.start,
        vehicleIndex: charge.vehicleIndex,
        type: charge.type,
        kwhPer100SocPoints: charge.energyKwh / (charge.lastEnergySoc - charge.startSoc) * 100
      });
    }
    return result;
  }

  function finalize(state) {
    const gps = dedupeGps(state);
    const odometer = sortTimed(uniqueBy(state.odometerRaw, (row) => JSON.stringify([row.vehicleIndex, row.t, row.km])));
    const range80 = sortTimed(uniqueBy(state.range80Raw, (row) => JSON.stringify([row.vehicleIndex, row.t, row.km])));
    const charges = deriveCharges(chargeSnapshots(state));
    addSocReferenceEstimates(charges);
    const unlocatedCharges = locateCharges(charges, gps);
    const batteryProxy = selectedBatteryProxy(charges);
    const ignitionSummary = summarizeIgnition(state.ignitionRaw);
    const commandSummary = summarizeCommands(state.commandRaw);
    const doorSummary = summarizeDoors(state.doorRaw, state.hoodRaw);
    const warningSummary = summarizeWarnings(state.chargingFaultRaw, state.tpmsRaw);

    const fields = Array.from(state.fields.values()).map((field) => ({
      name: field.name,
      count: field.count,
      categoryCodes: mapObject(field.categoryCodes),
      valueTypes: mapObject(field.valueTypes)
    })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const embeddedFields = Array.from(state.embeddedFields.values()).map((field) => ({
      parent: field.parent,
      path: field.path,
      parentCount: field.parentCount,
      mentions: field.mentions,
      valueTypes: mapObject(field.valueTypes)
    })).sort((a, b) => a.path.localeCompare(b.path));
    const meta = state.meta;
    meta.vehicleCount = state.vinIndexes.size;
    meta.multipleVehicles = meta.vehicleCount > 1;
    meta.rawGpsRows = state.gpsRaw.length;
    meta.uniqueGpsFixes = gps.length;
    meta.rawOdometerRows = state.odometerRaw.length;
    meta.uniqueOdometerReadings = odometer.length;
    meta.rawRange80Rows = state.range80Raw.length;
    meta.uniqueRange80Readings = range80.length;
    meta.chargeSessions = charges.length;
    meta.unlocatedCharges = unlocatedCharges;
    meta.batteryProxySessions = batteryProxy.length;
    meta.fieldCount = fields.length;
    meta.embeddedFieldCount = embeddedFields.length;
    meta.schema = {
      rootKeys: { attrList: state.files.length },
      attributeKeys: mapObject(state.schema.attributeKeys),
      attributeKeyTypes: mapObject(state.schema.attributeKeyTypes),
      categoryCodes: mapObject(state.schema.categoryCodes),
      seqNums: mapObject(state.schema.seqNums),
      tableNames: mapObject(state.schema.tableNames),
      attrValueTypes: mapObject(state.schema.attrValueTypes)
    };
    if (meta.multipleVehicles) meta.warnings.push(`The selected files contain ${meta.vehicleCount} distinct vehicles. Time-series rows are marked by anonymous vehicle number; combined totals may mix vehicles.`);
    if (meta.duplicateIds) meta.warnings.push(`${meta.duplicateIds} repeated source-record IDs were skipped in the analysis; raw attribute counts still include them.`);
    if (meta.missingIds) meta.warnings.push(`${meta.missingIds} reconstructed records had no source-record ID.`);
    if (unlocatedCharges) meta.warnings.push(`${unlocatedCharges} charging sessions had no GPS fix within five minutes of their start.`);
    if (meta.invalidTimestamps) meta.warnings.push(`${meta.invalidTimestamps} charging event records had no usable occurrence time.`);
    if (meta.embeddedParseErrors) meta.warnings.push(`${meta.embeddedParseErrors} structured attribute values could not be expanded in the data dictionary.`);
    return {
      meta,
      fields,
      embeddedFields,
      recordTypes: mapObject(state.recordTypes),
      eventNames: mapObject(state.eventNames),
      charges,
      odometer,
      gps,
      range80,
      batteryProxy,
      ignitionSummary,
      commandSummary,
      doorSummary,
      warningSummary
    };
  }

  async function analyze(inputFiles) {
    const files = Array.from(inputFiles || []);
    if (!files.length) throw new Error("Select one or more Ford GDPR JSON files first.");
    const state = createState(files);
    for (let index = 0; index < files.length; index++) {
      try { await parseFile(state, files[index], index); }
      catch (error) { throw new Error(`${files[index].name || `File ${index + 1}`}: ${error.message}`); }
    }
    postProgress("joining", files.length, files.length, 88, "Joining records split between files");
    stitchBoundaries(state);
    postProgress("deriving", files.length, files.length, 93, "Rebuilding charging sessions and vehicle summaries");
    const result = finalize(state);
    postProgress("complete", files.length, files.length, 100, "Analysis complete");
    return result;
  }
})();
