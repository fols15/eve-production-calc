// Downloads EVE SDE CSV exports from Fuzzwork and compiles them into compact
// JSON files the server loads at startup: data/types.json, data/blueprints.json.
// Run with: npm run build-data
import { parse } from "csv-parse/sync";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const RAW_DIR = path.join(DATA_DIR, "raw");
fs.mkdirSync(RAW_DIR, { recursive: true });

const BASE = "https://www.fuzzwork.co.uk/dump/latest/csv/";
const FILES = [
  "invTypes.csv",
  "invMetaTypes.csv",
  "invGroups.csv",
  "industryActivity.csv",
  "industryActivityMaterials.csv",
  "industryActivityProducts.csv",
  "invMarketGroups.csv",
  "mapSolarSystems.csv",
  "mapSolarSystemJumps.csv",
  "staStations.csv",
  "staOperationServices.csv",
];

async function download(name) {
  const dest = path.join(RAW_DIR, name);
  if (fs.existsSync(dest)) {
    console.log(`skip (cached): ${name}`);
    return;
  }
  console.log(`downloading: ${name}`);
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`failed to fetch ${name}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`  saved ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
}

function readCsv(name) {
  const text = fs.readFileSync(path.join(RAW_DIR, name), "utf8");
  return parse(text, { columns: true, skip_empty_lines: true, bom: true });
}

async function main() {
  for (const f of FILES) await download(f);

  // typeID -> metaGroupID (1 Tech I, 2 Tech II, 3 Storyline, 4 Faction,
  // 5 Officer, 6 Deadspace, 14 Tech III, 15 Abyssal, 17 Premium, 19 Limited
  // Time, 52/53/54 Structure Faction/Tech II/Tech I — verified live against
  // Fuzzwork's invMetaGroups.csv). A type with no row here has no meta
  // variant at all (never had one to begin with, e.g. a skillbook or a
  // plain commodity) — NOT the same as "Tech I with a row", but harmless to
  // treat as Tech I for our purposes since it's just as ordinarily buildable.
  console.log("parsing invMetaTypes.csv ...");
  const metaTypeRows = readCsv("invMetaTypes.csv");
  const metaGroupByType = new Map();
  for (const row of metaTypeRows) {
    metaGroupByType.set(Number(row.typeID), Number(row.metaGroupID));
  }
  console.log(`  ${metaGroupByType.size} types with a known meta group`);

  // groupID -> categoryID (e.g. "Ship" = 6, verified live against Fuzzwork's
  // invCategories.csv) — lets the scanner filter to just ships without
  // guessing from item names.
  console.log("parsing invGroups.csv ...");
  const groupRows = readCsv("invGroups.csv");
  const categoryByGroup = new Map();
  for (const row of groupRows) {
    categoryByGroup.set(Number(row.groupID), Number(row.categoryID));
  }
  console.log(`  ${categoryByGroup.size} groups`);

  console.log("parsing invTypes.csv ...");
  const invTypes = readCsv("invTypes.csv");
  const types = {};
  for (const row of invTypes) {
    const typeID = Number(row.typeID);
    if (row.published !== "1" && row.published !== "True" && row.published !== "true") continue;
    const groupID = Number(row.groupID);
    types[typeID] = {
      name: row.typeName,
      groupID,
      categoryID: categoryByGroup.get(groupID) ?? null,
      marketGroupID: row.marketGroupID ? Number(row.marketGroupID) : null,
      metaGroupID: metaGroupByType.get(typeID) ?? 1,
    };
  }
  console.log(`  ${Object.keys(types).length} published types`);

  console.log("parsing industryActivity.csv ...");
  const activity = readCsv("industryActivity.csv");
  // activityID: 1 = Manufacturing, 11 = Reactions
  const blueprintTime = {}; // `${blueprintTypeID}:${activityID}` -> time
  for (const row of activity) {
    const activityID = Number(row.activityID);
    if (activityID !== 1 && activityID !== 11) continue;
    blueprintTime[`${row.typeID}:${activityID}`] = Number(row.time);
  }

  console.log("parsing industryActivityProducts.csv ...");
  const products = readCsv("industryActivityProducts.csv");
  // productTypeID -> { blueprintTypeID, activityID }
  const productToBlueprint = {};
  for (const row of products) {
    const activityID = Number(row.activityID);
    if (activityID !== 1 && activityID !== 11) continue;
    productToBlueprint[Number(row.productTypeID)] = {
      blueprintTypeID: Number(row.typeID),
      activityID,
      quantity: Number(row.quantity),
    };
  }

  console.log("parsing industryActivityMaterials.csv ...");
  const materials = readCsv("industryActivityMaterials.csv");
  const blueprintMaterials = {}; // `${blueprintTypeID}:${activityID}` -> [{typeID, quantity}]
  for (const row of materials) {
    const activityID = Number(row.activityID);
    if (activityID !== 1 && activityID !== 11) continue;
    const key = `${row.typeID}:${activityID}`;
    (blueprintMaterials[key] ??= []).push({
      typeID: Number(row.materialTypeID),
      quantity: Number(row.quantity),
    });
  }

  // Build final per-product recipe map: productTypeID -> recipe
  const blueprints = {};
  for (const [productTypeID, info] of Object.entries(productToBlueprint)) {
    const key = `${info.blueprintTypeID}:${info.activityID}`;
    const mats = blueprintMaterials[key];
    if (!mats) continue;
    blueprints[productTypeID] = {
      blueprintTypeID: info.blueprintTypeID,
      activityID: info.activityID,
      outputQuantity: info.quantity,
      time: blueprintTime[key] ?? null,
      materials: mats,
    };
  }
  console.log(`  ${Object.keys(blueprints).length} buildable products`);

  fs.writeFileSync(path.join(DATA_DIR, "types.json"), JSON.stringify(types));
  fs.writeFileSync(path.join(DATA_DIR, "blueprints.json"), JSON.stringify(blueprints));

  console.log("parsing invMarketGroups.csv ...");
  const marketGroupRows = readCsv("invMarketGroups.csv");
  const marketGroups = {};
  for (const row of marketGroupRows) {
    const id = Number(row.marketGroupID);
    const parentRaw = row.parentGroupID;
    const parentID = parentRaw === "" || parentRaw === undefined || parentRaw === "None" ? null : Number(parentRaw);
    marketGroups[id] = { name: row.marketGroupName, parentID };
  }
  fs.writeFileSync(path.join(DATA_DIR, "marketGroups.json"), JSON.stringify(marketGroups));
  console.log(`  ${Object.keys(marketGroups).length} market groups`);

  console.log("parsing mapSolarSystems.csv ...");
  const systemRows = readCsv("mapSolarSystems.csv");
  const systems = {};
  for (const row of systemRows) {
    systems[Number(row.solarSystemID)] = {
      name: row.solarSystemName,
      security: Number(row.security),
      regionID: Number(row.regionID),
    };
  }
  fs.writeFileSync(path.join(DATA_DIR, "systems.json"), JSON.stringify(systems));
  console.log(`  ${Object.keys(systems).length} solar systems`);

  console.log("parsing mapSolarSystemJumps.csv ...");
  const jumpRows = readCsv("mapSolarSystemJumps.csv");
  const jumpSets = new Map(); // systemID -> Set(neighborID)
  for (const row of jumpRows) {
    const from = Number(row.fromSolarSystemID);
    const to = Number(row.toSolarSystemID);
    if (!jumpSets.has(from)) jumpSets.set(from, new Set());
    if (!jumpSets.has(to)) jumpSets.set(to, new Set());
    jumpSets.get(from).add(to);
    jumpSets.get(to).add(from); // the dump lists each gate from one side; make the graph undirected to be safe
  }
  const systemJumps = {};
  for (const [id, neighbors] of jumpSets) systemJumps[id] = [...neighbors];
  fs.writeFileSync(path.join(DATA_DIR, "systemJumps.json"), JSON.stringify(systemJumps));
  console.log(`  ${Object.keys(systemJumps).length} systems with stargate connections`);

  // Not every NPC station can run manufacturing jobs — most are pure
  // trade/storage/refinery outposts. staOperationServices.csv maps each
  // station's operationID to the services it offers; serviceID 14 is
  // "Factory", CCP's name for the Manufacturing service. Cross-referencing
  // this against staStations' operationID column is the only way to tell
  // which NPC stations actually support building something (verified
  // against Jita IV - Moon 4 - Caldari Navy Assembly Plant, operationID 14,
  // which does carry serviceID 14).
  console.log("parsing staOperationServices.csv ...");
  const operationServiceRows = readCsv("staOperationServices.csv");
  const FACTORY_SERVICE_ID = 14;
  const factoryOperationIDs = new Set(
    operationServiceRows.filter((row) => Number(row.serviceID) === FACTORY_SERVICE_ID).map((row) => Number(row.operationID))
  );
  console.log(`  ${factoryOperationIDs.size} station operation types offer Manufacturing`);

  console.log("parsing staStations.csv ...");
  const stationRows = readCsv("staStations.csv");
  const stationsBySystem = {};
  let manufacturingStationCount = 0;
  for (const row of stationRows) {
    const systemID = Number(row.solarSystemID);
    const hasFactory = factoryOperationIDs.has(Number(row.operationID));
    if (hasFactory) manufacturingStationCount++;
    (stationsBySystem[systemID] ??= []).push({
      stationID: Number(row.stationID),
      name: row.stationName,
      hasFactory,
    });
  }
  fs.writeFileSync(path.join(DATA_DIR, "stations.json"), JSON.stringify(stationsBySystem));
  console.log(
    `  ${stationRows.length} NPC stations across ${Object.keys(stationsBySystem).length} systems ` +
      `(${manufacturingStationCount} offer Manufacturing)`
  );

  console.log(
    "done. wrote data/types.json, data/blueprints.json, data/marketGroups.json, data/systems.json, " +
      "data/systemJumps.json, data/stations.json"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
