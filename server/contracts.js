// Blueprint copy/original (BPC/BPO) prices from public item-exchange
// contracts across The Forge region (Jita's home region) — NOT limited to
// the Jita 4-4 station the way materials/finished-product pricing is
// elsewhere in this tool, since blueprint contracts are thin enough that
// restricting to one station misses real listings a few jumps away.
//
// Most blueprints can't have market sell/buy orders at all — every copy has
// its own material/time efficiency and runs remaining, so they aren't
// fungible the way a stack of minerals is. Contracts are the only
// ESI-visible price signal for "how much does a copy of this blueprint cost
// right now" (Reaction Formulas are the one exception — see esi.js/getForgeRegionPrices).
//
// The public contracts list (one cheap paginated call) tells us price,
// location and type but NOT contents — finding out whether a contract
// actually contains a given blueprint needs one extra call per contract
// (GET .../contracts/public/items/{contract_id}/). That fan-out is the
// expensive part, so contract contents are cached indefinitely per
// contract_id (a contract's contents never change while it's active) and
// only re-fetched for contracts that are new since the last list refresh.
const REGION_ID = 10000002; // The Forge — Jita's home region

const CONTRACT_LIST_TTL_MS = 10 * 60 * 1000;

let contractListCache = null; // Map contract_id -> {price, dateExpired}
let contractListExpires = 0;

const itemsCache = new Map(); // contract_id -> items[] (pruned when a contract drops off the live list)

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "eve-production-calc (local private tool)" } });
  if (!res.ok) throw new Error(`ESI error ${res.status} for ${url}`);
  return { body: await res.json(), headers: res.headers };
}

async function fetchAllPublicContracts() {
  const results = [];
  let page = 1;
  let totalPages = 1;
  do {
    const url = `https://esi.evetech.net/latest/contracts/public/${REGION_ID}/?datasource=tranquility&page=${page}`;
    const { body, headers } = await fetchJson(url);
    results.push(...body);
    totalPages = Number(headers.get("x-pages") ?? "1");
    page += 1;
  } while (page <= totalPages);
  return results;
}

// Region-wide (The Forge), not station-scoped — unlike everything else this
// tool prices (materials, the finished product), which stays Jita 4-4 only.
// Blueprint contracts and Reaction Formula market listings are thin enough
// that restricting to one station missed real, legitimate listings sitting
// a few jumps away in the same region (confirmed against a live example).
// Cheap to widen: fetchAllPublicContracts() already pulls the WHOLE region
// in one paginated scan — this filter just stops throwing most of it away.
async function ensureContractList() {
  if (contractListCache && contractListExpires > Date.now()) return contractListCache;

  const all = await fetchAllPublicContracts();
  const now = Date.now();
  const live = all.filter((c) => c.type === "item_exchange" && c.price > 0 && new Date(c.date_expired).getTime() > now);

  const map = new Map(live.map((c) => [c.contract_id, c]));
  for (const id of itemsCache.keys()) {
    if (!map.has(id)) itemsCache.delete(id); // no longer live — stop carrying it around
  }

  contractListCache = map;
  contractListExpires = Date.now() + CONTRACT_LIST_TTL_MS;
  return map;
}

async function getContractItems(contractId) {
  if (itemsCache.has(contractId)) return itemsCache.get(contractId);
  try {
    const { body } = await fetchJson(`https://esi.evetech.net/latest/contracts/public/items/${contractId}/?datasource=tranquility`);
    itemsCache.set(contractId, body);
    return body;
  } catch {
    // Contract completed/expired mid-scan, or ESI hiccup — treat as empty for
    // this run rather than retry (ensureContractList() will drop it once its
    // TTL expires if it's genuinely gone).
    itemsCache.set(contractId, []);
    return [];
  }
}

// For each requested blueprint typeID, finds the cheapest The Forge-region
// item-exchange contract offering a COPY and, separately, the cheapest one
// offering an ORIGINAL (BPO) — returns { bestCopy, bestOriginal }, each a
// Map<blueprintTypeID, {...}>. A contract only counts toward a blueprint's
// price if every included item in it is the SAME kind (all copies, or all
// originals) of THAT SAME blueprint — mixed-item or mixed-copy/original
// bundles have no well-defined per-item price, so they're skipped rather
// than mis-attributed. Originals have no "runs" to divide by (infinitely
// reusable), so bestOriginal is ranked by plain price, not price-per-run.
export async function findCheapestBlueprintContracts(blueprintTypeIDs, concurrency = 50) {
  const wanted = new Set(blueprintTypeIDs);
  const contracts = await ensureContractList();
  const ids = [...contracts.keys()];

  const bestCopy = new Map();
  const bestOriginal = new Map();
  const copyCandidateCounts = new Map();
  const originalCandidateCounts = new Map();

  let i = 0;
  async function worker() {
    while (i < ids.length) {
      const contractId = ids[i++];
      const items = await getContractItems(contractId);
      const included = items.filter((it) => it.is_included);
      if (!included.length) continue;

      const typeIds = new Set(included.map((it) => it.type_id));
      if (typeIds.size !== 1) continue; // mixed-item contract — price per blueprint is undefined

      const [typeId] = typeIds;
      if (!wanted.has(typeId)) continue;

      const contract = contracts.get(contractId);
      const count = included.length;
      const pricePerItem = contract.price / count;

      if (included.every((it) => it.is_blueprint_copy)) {
        // Runs can differ copy-to-copy inside the same contract in principle;
        // take the cheapest copy's own runs for the reported price-per-run.
        const cheapestItem = included.reduce((a, b) => (a.runs ?? 1) >= (b.runs ?? 1) ? a : b, included[0]);
        const runs = cheapestItem.runs ?? 1;
        const pricePerRun = pricePerItem / Math.max(1, runs);

        copyCandidateCounts.set(typeId, (copyCandidateCounts.get(typeId) ?? 0) + 1);
        const current = bestCopy.get(typeId);
        if (!current || pricePerRun < current.pricePerRun) {
          bestCopy.set(typeId, {
            price: pricePerItem,
            pricePerRun,
            runs,
            materialEfficiency: cheapestItem.material_efficiency ?? 0,
            timeEfficiency: cheapestItem.time_efficiency ?? 0,
            contractId,
            copiesInContract: count,
          });
        }
      } else if (included.every((it) => !it.is_blueprint_copy)) {
        const cheapestItem = included[0];
        originalCandidateCounts.set(typeId, (originalCandidateCounts.get(typeId) ?? 0) + 1);
        const current = bestOriginal.get(typeId);
        if (!current || pricePerItem < current.price) {
          bestOriginal.set(typeId, {
            price: pricePerItem,
            materialEfficiency: cheapestItem.material_efficiency ?? 0,
            timeEfficiency: cheapestItem.time_efficiency ?? 0,
            contractId,
            originalsInContract: count,
          });
        }
      }
      // else: a bundle mixing copies and originals of the same blueprint —
      // no well-defined per-item price, skip.
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));

  for (const [typeId, match] of bestCopy) match.candidateCount = copyCandidateCounts.get(typeId) ?? 0;
  for (const [typeId, match] of bestOriginal) match.candidateCount = originalCandidateCounts.get(typeId) ?? 0;
  return { bestCopy, bestOriginal, scannedContracts: ids.length };
}
