// Persists the user's known production structures (Upwell Engineering
// Complexes/Refineries — Raitaru, Azbel, Sotiyo, Athanor, Tatara, etc.) so
// they don't have to be re-entered every time. ESI has no way to search
// structures by type/region — only by exact ID, by a name the character
// already knows, or (for the character's own corp) via the corporation
// structures endpoint — so this list is either filled in by hand or synced
// from the logged-in character's corporation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getValidAccessToken, getAuth } from "./oauth.js";
import { getType, getSystem } from "./sde.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DIR = path.join(__dirname, "..", "data", "user");
const FILE = path.join(USER_DIR, "structures.json");

// Base manufacturing material bonus baked into the structure hull itself,
// independent of ME/TE research on the blueprint. CCP doesn't expose this
// through the dogma attributes ESI serves — it's server-side industry-formula
// logic with no inspectable attribute, so this is cited from EVE University's
// structure bonus table (wiki.eveuniversity.org/Upwell_structures) rather
// than derived from an API response. Refineries (Athanor/Tatara) are
// deliberately absent: their documented bonus is to REFINING (ore
// reprocessing) yield, a different job entirely from the reaction jobs this
// tool prices — no manufacturing/reaction material bonus for them is
// documented, so assume 0 rather than guess.
const STRUCTURE_BASE_ME_BONUS = { Raitaru: 1, Azbel: 1, Sotiyo: 1 };

export function getStructureMePct(structure) {
  return STRUCTURE_BASE_ME_BONUS[structure.typeName] ?? 0;
}

// Separate "Job fee" bonus — reduces the SYSTEM COST INDEX portion of job
// cost (not materials, not facility tax, not the SCC surcharge). Cross-
// checked against a real in-game "Job Gross Cost" breakdown (a Raitaru
// showed "Structure Role Bonus -3.0%" cutting exactly 3% off the cost-index
// amount, matching this table) — see bom.js for where it's applied.
const STRUCTURE_JOB_FEE_BONUS = { Raitaru: 3, Azbel: 4, Sotiyo: 5 };

export function getStructureJobFeeBonus(structure) {
  return STRUCTURE_JOB_FEE_BONUS[structure.typeName] ?? 0;
}

// Job DURATION bonus — separate from everything above, reduces wall-clock
// time only (ISK cost unaffected). Engineering Complexes speed up
// Manufacturing (and science) jobs; Refineries speed up Reaction jobs
// instead — a Raitaru gives 0% here for a reaction and vice versa. Source:
// EVE University's structure bonus table (wiki.eveuniversity.org/Upwell_structures).
const STRUCTURE_DURATION_BONUS = {
  Raitaru: { manufacturing: 15 },
  Azbel: { manufacturing: 20 },
  Sotiyo: { manufacturing: 30 },
  Athanor: { reaction: 3 },
  Tatara: { reaction: 25 },
};

export function getStructureDurationBonus(structure, activityID) {
  const key = activityID === 11 ? "reaction" : "manufacturing";
  return STRUCTURE_DURATION_BONUS[structure.typeName]?.[key] ?? 0;
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { manual: [], corp: [] };
  }
}

function save(data) {
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

export function listStructures() {
  const data = load();
  return [...data.manual, ...data.corp];
}

export function addManualStructure({ name, systemId, systemName, typeId, typeName, facilityTax, structureId }) {
  const data = load();
  const entry = {
    id: randomUUID(),
    name,
    systemId,
    systemName,
    typeId: typeId ?? null,
    typeName: typeName ?? null,
    structureId: structureId ?? null, // set when added via ESI search — the real Upwell structure_id
    facilityTax: Number(facilityTax) || 0,
    source: "manual",
  };
  data.manual.push(entry);
  save(data);
  return entry;
}

export function removeManualStructure(id) {
  const data = load();
  const before = data.manual.length;
  data.manual = data.manual.filter((s) => s.id !== id);
  save(data);
  return data.manual.length < before;
}

// Replaces the whole corp-sourced set (called after each sync from ESI) so
// structures that were sold/unanchored drop out automatically. ESI doesn't
// expose a structure's manufacturing tax rate, so carry over any tax the
// user already set by hand for a structure that's still there.
export function replaceCorpStructures(entries) {
  const data = load();
  const priorTax = new Map(data.corp.map((s) => [s.structureId, s.facilityTax]));
  data.corp = entries.map((e) => ({
    ...e,
    id: `corp:${e.structureId}`,
    source: "corp",
    facilityTax: priorTax.get(e.structureId) ?? 0,
  }));
  save(data);
}

// facilityTax is the only field the user needs to correct by hand — ESI has
// no endpoint that reports a structure's configured manufacturing tax rate.
export function updateStructureTax(id, facilityTax) {
  const data = load();
  const entry = data.manual.find((s) => s.id === id) ?? data.corp.find((s) => s.id === id);
  if (!entry) return false;
  entry.facilityTax = Number(facilityTax) || 0;
  save(data);
  return true;
}

// Pulls the logged-in character's own corporation's Upwell structures from
// ESI (requires the character to be a director — CCP restricts this
// endpoint to corp leadership) and stores them as the "corp" set.
export async function syncCorpStructures() {
  const auth = getAuth();
  if (!auth) throw new Error("не выполнен вход через EVE SSO");
  if (!auth.corporationId) throw new Error("не удалось определить корпорацию персонажа");

  const token = await getValidAccessToken();
  const headers = { Authorization: `Bearer ${token}` };

  const res = await fetch(
    `https://esi.evetech.net/latest/corporations/${auth.corporationId}/structures/?datasource=tranquility`,
    { headers }
  );
  if (res.status === 403) throw new Error("нужны права директора корпорации, чтобы видеть её структуры");
  if (!res.ok) throw new Error(`ESI error ${res.status}`);
  const rows = await res.json();

  const entries = [];
  for (const row of rows) {
    let name = row.name ?? null;
    if (!name) {
      const detailRes = await fetch(
        `https://esi.evetech.net/latest/universe/structures/${row.structure_id}/?datasource=tranquility`,
        { headers }
      );
      if (detailRes.ok) name = (await detailRes.json()).name;
    }
    const systemMeta = getSystem(row.system_id);
    const typeMeta = getType(row.type_id);
    entries.push({
      structureId: row.structure_id,
      name: name ?? `Структура #${row.structure_id}`,
      systemId: row.system_id,
      systemName: systemMeta?.name ?? `#${row.system_id}`,
      typeId: row.type_id,
      typeName: typeMeta?.name ?? null,
      services: row.services?.map((s) => s.name) ?? [],
    });
  }

  replaceCorpStructures(entries);
  return entries;
}

// Resolves a THIRD-PARTY structure (not your own corp's) by name into a real
// structure_id/system/type — the only ESI-legal way to do this, since there
// is no "list structures in system X" endpoint (unlike NPC stations, which
// are public knowledge; a citadel's existence is only visible to characters
// who already have some reason to know about it — docked there, fleeted
// with someone who did, etc.). /characters/{id}/search/ only returns IDs; a
// second call per ID resolves the actual name/system/type, and silently
// drops any ID the character no longer has visibility into (a stale/
// unanchored structure, or one they never really had access to) rather than
// failing the whole search over one bad result.
export async function searchStructuresByName(query) {
  const auth = getAuth();
  if (!auth) throw new Error("не выполнен вход через EVE SSO");
  const q = query.trim();
  if (q.length < 3) throw new Error("минимум 3 символа для поиска (ограничение ESI)");

  const token = await getValidAccessToken();
  const headers = { Authorization: `Bearer ${token}` };

  const searchRes = await fetch(
    `https://esi.evetech.net/latest/characters/${auth.characterId}/search/?categories=structure&search=${encodeURIComponent(q)}&datasource=tranquility`,
    { headers }
  );
  if (searchRes.status === 403) throw new Error("нужен scope esi-search.search_structures.v1 — перелогиньтесь через EVE SSO");
  if (!searchRes.ok) throw new Error(`ESI search error ${searchRes.status}`);
  const structureIds = (await searchRes.json()).structure ?? [];

  const results = [];
  for (const structureId of structureIds.slice(0, 15)) {
    const detailRes = await fetch(`https://esi.evetech.net/latest/universe/structures/${structureId}/?datasource=tranquility`, { headers });
    if (!detailRes.ok) continue; // no docking access to this one (anymore) — skip, don't fail the whole search
    const detail = await detailRes.json();
    const systemMeta = getSystem(detail.solar_system_id);
    const typeMeta = getType(detail.type_id);
    results.push({
      structureId,
      name: detail.name,
      systemId: detail.solar_system_id,
      systemName: systemMeta?.name ?? `#${detail.solar_system_id}`,
      typeId: detail.type_id,
      typeName: typeMeta?.name ?? null,
    });
  }
  return results;
}
