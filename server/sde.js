import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

export const types = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "types.json"), "utf8"));
export const blueprints = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "blueprints.json"), "utf8"));
export const marketGroups = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "marketGroups.json"), "utf8"));
export const systems = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "systems.json"), "utf8"));
export const systemJumps = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "systemJumps.json"), "utf8"));
export const stationsBySystem = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "stations.json"), "utf8"));

// Lowercased name -> typeID list, built once for search.
const searchIndex = Object.entries(types).map(([id, t]) => ({
  typeID: Number(id),
  name: t.name,
  lower: t.name.toLowerCase(),
}));

export function searchTypes(query, limit = 25) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts = [];
  const contains = [];
  for (const entry of searchIndex) {
    if (entry.lower.startsWith(q)) starts.push(entry);
    else if (entry.lower.includes(q)) contains.push(entry);
    if (starts.length >= limit) break;
  }
  const results = starts.concat(contains).slice(0, limit);
  return results.map((r) => ({
    typeID: r.typeID,
    name: r.name,
    buildable: Boolean(blueprints[r.typeID]),
  }));
}

const systemSearchIndex = Object.entries(systems).map(([id, s]) => ({
  solarSystemID: Number(id),
  name: s.name,
  lower: s.name.toLowerCase(),
  security: s.security,
}));

export function searchSystems(query, limit = 20) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts = [];
  const contains = [];
  for (const entry of systemSearchIndex) {
    if (entry.lower.startsWith(q)) starts.push(entry);
    else if (entry.lower.includes(q)) contains.push(entry);
    if (starts.length >= limit) break;
  }
  return starts
    .concat(contains)
    .slice(0, limit)
    .map((r) => ({ solarSystemID: r.solarSystemID, name: r.name, security: r.security }));
}

const jumpBfsCache = new Map(); // `${originID}:${maxJumps}` -> Map(systemID -> distance)

// BFS over the stargate connection graph, capped at maxJumps. Memoized (only
// when there's nothing to avoid) since the map topology never changes at
// runtime and we always query from Jita. `avoid` is a Set of solarSystemIDs
// treated as impassable (the search never enters them, so they — and
// anything only reachable through them — simply drop out of the result);
// avoid-constrained searches are one-off (depend on user input) so they
// aren't cached.
export function jumpsFrom(originID, maxJumps, avoid = null) {
  if (!avoid || avoid.size === 0) {
    const key = `${originID}:${maxJumps}`;
    const cached = jumpBfsCache.get(key);
    if (cached) return cached;
    const distances = bfsDistances(originID, maxJumps, null);
    jumpBfsCache.set(key, distances);
    return distances;
  }
  return bfsDistances(originID, maxJumps, avoid);
}

function bfsDistances(originID, maxJumps, avoid) {
  const distances = new Map([[originID, 0]]);
  let frontier = [originID];
  for (let d = 1; d <= maxJumps && frontier.length; d++) {
    const next = [];
    for (const sysID of frontier) {
      for (const neighbor of systemJumps[sysID] ?? []) {
        if (avoid && avoid.has(neighbor)) continue;
        if (!distances.has(neighbor)) {
          distances.set(neighbor, d);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return distances;
}

// Reconstructs an actual stargate-by-stargate route origin -> targetID
// (inclusive of both ends), honoring the same avoid-set jumpsFrom used to
// compute distances/reachability. Returns null if targetID is unreachable
// within maxJumps without crossing an avoided system.
export function routeBetween(originID, targetID, maxJumps = 50, avoid = null) {
  if (originID === targetID) return [originID];
  const prev = new Map([[originID, null]]);
  let frontier = [originID];
  for (let d = 1; d <= maxJumps && frontier.length; d++) {
    const next = [];
    for (const sysID of frontier) {
      for (const neighbor of systemJumps[sysID] ?? []) {
        if (avoid && avoid.has(neighbor)) continue;
        if (prev.has(neighbor)) continue;
        prev.set(neighbor, sysID);
        if (neighbor === targetID) {
          const path = [targetID];
          for (let cur = targetID; prev.get(cur) !== null; cur = prev.get(cur)) path.push(prev.get(cur));
          return path.reverse();
        }
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return null;
}

export function getStations(systemID) {
  return stationsBySystem[systemID] ?? [];
}

// Only stations that actually offer the Manufacturing ("Factory") service —
// most NPC stations are pure trade/storage/refinery outposts and can't run
// an industry job at all, so "a station exists here" is not the same as
// "you can build here".
export function getManufacturingStations(systemID) {
  return (stationsBySystem[systemID] ?? []).filter((s) => s.hasFactory);
}

export function getType(typeID) {
  return types[typeID] ?? null;
}

// Exact (case-insensitive) name -> typeID, used to resolve structure type
// names like "Raitaru" to their real typeID for icons/display.
const typeIdByExactName = new Map(searchIndex.map((r) => [r.lower, r.typeID]));
export function getTypeIdByName(name) {
  return typeIdByExactName.get(name.trim().toLowerCase()) ?? null;
}

export function getSystem(systemID) {
  return systems[systemID] ?? null;
}

export function getRecipe(typeID) {
  return blueprints[typeID] ?? null;
}

// Reverse of blueprints: blueprintTypeID -> the typeID it produces. Needed
// for things like LP store offers, which reward the BLUEPRINT's own typeID
// (e.g. "Low-grade Hydra Alpha Blueprint") rather than the item it builds —
// blueprints have no market orders at all, so pricing one only makes sense
// by finding what it produces and costing/valuing THAT instead.
const productByBlueprintId = new Map(
  Object.entries(blueprints).map(([productTypeID, recipe]) => [recipe.blueprintTypeID, Number(productTypeID)])
);
export function getProductForBlueprint(blueprintTypeID) {
  return productByBlueprintId.get(blueprintTypeID) ?? null;
}

// --- category browser (mirrors the in-game market/industry item tree) ---

const ROOT_KEY = "root";
const groupChildren = new Map(); // parentKey -> [groupID]
const itemsByGroup = new Map(); // groupID -> [{typeID, name, buildable}]

for (const [idStr, g] of Object.entries(marketGroups)) {
  const id = Number(idStr);
  const key = g.parentID === null ? ROOT_KEY : g.parentID;
  if (!groupChildren.has(key)) groupChildren.set(key, []);
  groupChildren.get(key).push(id);
}
for (const list of groupChildren.values()) {
  list.sort((a, b) => (marketGroups[a]?.name ?? "").localeCompare(marketGroups[b]?.name ?? ""));
}

for (const [idStr, t] of Object.entries(types)) {
  if (t.marketGroupID === null || t.marketGroupID === undefined) continue;
  if (!itemsByGroup.has(t.marketGroupID)) itemsByGroup.set(t.marketGroupID, []);
  itemsByGroup.get(t.marketGroupID).push({
    typeID: Number(idStr),
    name: t.name,
    buildable: Boolean(blueprints[idStr]),
  });
}
for (const list of itemsByGroup.values()) {
  list.sort((a, b) => a.name.localeCompare(b.name));
}

function groupHasContent(groupID) {
  return (groupChildren.get(groupID)?.length ?? 0) > 0 || (itemsByGroup.get(groupID)?.length ?? 0) > 0;
}

// CCP's own market-group icon graphics (invMarketGroups.iconID) aren't
// served by any public image endpoint — images.evetech.net only does
// per-TYPE icons/renders, nothing by icon ID. So each group's sidebar icon
// is a real item's icon (the same CDN this app already uses everywhere for
// items) borrowed from whatever that group actually contains — first item
// alphabetically if the group holds items directly, otherwise the first one
// found in its subgroups. Real EVE icons either way, just not necessarily
// CCP's exact folder glyph for that group.
const representativeTypeCache = new Map();
function representativeTypeID(groupID) {
  if (representativeTypeCache.has(groupID)) return representativeTypeCache.get(groupID);
  representativeTypeCache.set(groupID, null); // guard against cyclical parent data, if any
  const direct = itemsByGroup.get(groupID);
  if (direct?.length) {
    const id = direct[0].typeID;
    representativeTypeCache.set(groupID, id);
    return id;
  }
  for (const childID of groupChildren.get(groupID) ?? []) {
    const id = representativeTypeID(childID);
    if (id !== null) {
      representativeTypeCache.set(groupID, id);
      return id;
    }
  }
  return null;
}

// Returns the children of a market group for lazy tree browsing: subgroups
// (with a hasChildren flag) and items directly filed under this group.
// groupID === null/undefined lists the top-level (root) categories.
export function browseGroup(groupID) {
  const key = groupID === null || groupID === undefined ? ROOT_KEY : Number(groupID);
  const childIDs = groupChildren.get(key) ?? [];
  const groups = childIDs
    .filter((id) => groupHasContent(id))
    .map((id) => ({
      groupID: id,
      name: marketGroups[id]?.name ?? `#${id}`,
      hasChildren: (groupChildren.get(id)?.length ?? 0) > 0,
      iconTypeID: representativeTypeID(id),
    }));
  const items = key === ROOT_KEY ? [] : itemsByGroup.get(key) ?? [];
  return { groups, items };
}
