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

export function addManualStructure({ name, systemId, systemName, typeId, typeName, facilityTax }) {
  const data = load();
  const entry = {
    id: randomUUID(),
    name,
    systemId,
    systemName,
    typeId: typeId ?? null,
    typeName: typeName ?? null,
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
