// Character-specific market costs — Sales Tax and Broker's Fee — computed
// from the logged-in character's Accounting / Broker Relations skills and
// their RAW (unmodified, standing-skill-independent) standing to the owner
// of Jita IV - Moon 4, per CCP's published formula:
// https://support.eveonline.com/hc/en-us/articles/203218962-Broker-Fee-and-Sales-Tax
import { getAuth, getValidAccessToken } from "./oauth.js";
import { getTypeIdByName } from "./sde.js";

const STATION_ID = 60003760; // Jita IV - Moon 4 - Caldari Navy Assembly Plant
const RATES_CACHE_TTL_MS = 60 * 60 * 1000;
const STATION_OWNER_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // station ownership essentially never changes

const ACCOUNTING_SKILL_ID = getTypeIdByName("Accounting");
const BROKER_RELATIONS_SKILL_ID = getTypeIdByName("Broker Relations");

// Untrained-character defaults — used whenever nobody is logged in, or ESI
// can't be reached (e.g. auth was granted before these scopes existed).
export const DEFAULT_RATES = {
  loggedIn: false,
  characterName: null,
  accountingLevel: 0,
  brokerRelationsLevel: 0,
  factionStanding: 0,
  corpStanding: 0,
  salesTaxRate: 7.5,
  brokerFeeRate: 3,
};

let stationOwnerCache = null; // { corporationId, factionId }
let stationOwnerExpires = 0;

let ratesCache = null;
let ratesCacheCharacterId = null;
let ratesExpires = 0;

async function fetchJson(url, accessToken) {
  const headers = { "User-Agent": "eve-production-calc (local private tool)" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`ESI error ${res.status} for ${url}`);
  return res.json();
}

async function getStationOwner() {
  if (stationOwnerCache && stationOwnerExpires > Date.now()) return stationOwnerCache;
  const station = await fetchJson(`https://esi.evetech.net/latest/universe/stations/${STATION_ID}/?datasource=tranquility`);
  const corp = await fetchJson(`https://esi.evetech.net/latest/corporations/${station.owner}/?datasource=tranquility`);
  stationOwnerCache = { corporationId: station.owner, factionId: corp.faction_id ?? null };
  stationOwnerExpires = Date.now() + STATION_OWNER_CACHE_TTL_MS;
  return stationOwnerCache;
}

function skillLevel(skills, skillTypeId) {
  if (!skillTypeId) return 0;
  const entry = skills.find((s) => s.skill_id === skillTypeId);
  return entry ? entry.active_skill_level : 0;
}

// CCP's formula explicitly uses RAW standings (GET /characters/{id}/standings/),
// not the effective, connections/diplomacy-skill-modified ones shown in the client.
function rawStanding(standings, id, type) {
  const entry = standings.find((s) => s.from_id === id && s.from_type === type);
  return entry ? entry.standing : 0;
}

// Sales Tax = 7.5% base, reduced 11% relative per Accounting level
// (Accounting V => 7.5% * 0.45 ≈ 3.375%).
export function salesTaxFromSkill(accountingLevel) {
  return Math.max(0, 7.5 * (1 - 0.11 * accountingLevel));
}

// Broker's Fee = 3% base, -0.3%/level Broker Relations, -0.03%/point faction
// standing, -0.02%/point corp standing, floor 1% (NPC stations only — player
// structures set their own broker fee, unaffected by skills or standings).
export function brokerFeeFromSkills(brokerRelationsLevel, factionStanding, corpStanding) {
  return Math.max(1, 3 - 0.3 * brokerRelationsLevel - 0.03 * factionStanding - 0.02 * corpStanding);
}

// Loads (or reuses cached) Sales Tax / Broker's Fee for whichever character
// is currently logged in via EVE SSO. Falls back to DEFAULT_RATES (untrained,
// 0 standing) when nobody's logged in or ESI can't be reached — callers
// should surface that the fallback is in effect rather than pretend it's exact.
export async function getMarketRates() {
  const auth = getAuth();
  if (!auth) return { ...DEFAULT_RATES };

  if (ratesCache && ratesCacheCharacterId === auth.characterId && ratesExpires > Date.now()) {
    return ratesCache;
  }

  try {
    const accessToken = await getValidAccessToken();
    const [skillsRes, standings, stationOwner] = await Promise.all([
      fetchJson(`https://esi.evetech.net/latest/characters/${auth.characterId}/skills/?datasource=tranquility`, accessToken),
      fetchJson(`https://esi.evetech.net/latest/characters/${auth.characterId}/standings/?datasource=tranquility`, accessToken),
      getStationOwner(),
    ]);

    const accountingLevel = skillLevel(skillsRes.skills ?? [], ACCOUNTING_SKILL_ID);
    const brokerRelationsLevel = skillLevel(skillsRes.skills ?? [], BROKER_RELATIONS_SKILL_ID);
    const factionStanding = stationOwner.factionId ? rawStanding(standings, stationOwner.factionId, "faction") : 0;
    const corpStanding = rawStanding(standings, stationOwner.corporationId, "npc_corp");

    ratesCache = {
      loggedIn: true,
      characterName: auth.characterName,
      accountingLevel,
      brokerRelationsLevel,
      factionStanding,
      corpStanding,
      salesTaxRate: salesTaxFromSkill(accountingLevel),
      brokerFeeRate: brokerFeeFromSkills(brokerRelationsLevel, factionStanding, corpStanding),
    };
    ratesCacheCharacterId = auth.characterId;
    ratesExpires = Date.now() + RATES_CACHE_TTL_MS;
    return ratesCache;
  } catch (err) {
    // Most likely cause: the stored token was granted before the skills/
    // standings scopes existed and needs a fresh login — fall back instead
    // of breaking the whole calculation.
    return { ...DEFAULT_RATES, characterName: auth.characterName, error: String(err.message ?? err) };
  }
}
