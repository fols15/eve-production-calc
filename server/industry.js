// System cost indices and CCP "adjusted prices" from ESI, used to estimate
// the job installation fee (job cost) of manufacturing/reacting in a given
// solar system: jobCost = EIV * (systemCostIndex + facilityTaxRate), where
// EIV (Estimated Item Value) = sum(material quantity * adjusted_price).
const CACHE_TTL_MS = 60 * 60 * 1000; // these change at most once a day on Tranquility

let costIndexCache = null; // Map solarSystemID -> {manufacturing, reaction, ...}
let costIndexExpires = 0;

let adjustedPriceCache = null; // Map typeID -> adjusted_price
let adjustedPriceExpires = 0;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "eve-production-calc (local private tool)" } });
  if (!res.ok) throw new Error(`ESI error ${res.status} for ${url}`);
  return res.json();
}

async function ensureCostIndices() {
  if (costIndexCache && costIndexExpires > Date.now()) return;
  const rows = await fetchJson("https://esi.evetech.net/latest/industry/systems/?datasource=tranquility");
  const map = new Map();
  for (const row of rows) {
    const byActivity = {};
    for (const ci of row.cost_indices) byActivity[ci.activity] = ci.cost_index;
    map.set(row.solar_system_id, byActivity);
  }
  costIndexCache = map;
  costIndexExpires = Date.now() + CACHE_TTL_MS;
}

async function ensureAdjustedPrices() {
  if (adjustedPriceCache && adjustedPriceExpires > Date.now()) return;
  const rows = await fetchJson("https://esi.evetech.net/latest/markets/prices/?datasource=tranquility");
  const map = new Map();
  for (const row of rows) map.set(row.type_id, row.adjusted_price ?? 0);
  adjustedPriceCache = map;
  adjustedPriceExpires = Date.now() + CACHE_TTL_MS;
}

// Loads (or reuses cached) industry data and returns synchronous accessors.
export async function loadIndustryData() {
  await Promise.all([ensureCostIndices(), ensureAdjustedPrices()]);
  return {
    costIndex(solarSystemID, activityID) {
      const activity = activityID === 11 ? "reaction" : "manufacturing";
      return costIndexCache.get(solarSystemID)?.[activity] ?? 0;
    },
    hasData(solarSystemID) {
      return costIndexCache.has(solarSystemID);
    },
    adjustedPrice(typeID) {
      return adjustedPriceCache.get(typeID) ?? 0;
    },
  };
}
