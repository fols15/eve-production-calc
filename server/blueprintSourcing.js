// Single, shared "how do I actually get this blueprint, and what does it
// cost" resolver — every profit calculation in this tool (the single-item
// tree, the best-systems comparison, the game-wide profit scan) now goes
// through this instead of each keeping its own flavor of ME assumption/
// blueprint-cost logic. For every candidate productTypeID this collects
// EVERY real source found (own, contract copy, contract original, Forge
// market) instead of just picking one by fixed priority — bom.js's rollUp()
// then tries each one at the actual runs needed and keeps whichever is
// really cheapest (an ME10 original can lose to a cheap ME0 copy, or win —
// depends entirely on runs needed, which resolveRealBlueprints itself has
// no way to know). A productTypeID with no real source ANYWHERE is left out
// entirely — there is no honest way to price building something you have no
// real path to a blueprint for.
import { getRecipe } from "./sde.js";
import { getForgeRegionPricesBulk } from "./esi.js";
import { findCheapestBlueprintContracts } from "./contracts.js";
import { getOwnedBlueprints } from "./character.js";

export async function resolveRealBlueprints(productTypeIDs) {
  const withRecipe = [...new Set(productTypeIDs)]
    .map((typeID) => ({ typeID, recipe: getRecipe(typeID) }))
    .filter((c) => c.recipe);
  const blueprintTypeIDs = withRecipe.map((c) => c.recipe.blueprintTypeID);

  let ownedByProduct = new Map();
  try {
    ownedByProduct = new Map((await getOwnedBlueprints()).map((o) => [o.productTypeID, o]));
  } catch {
    // not logged in via EVE SSO, or an ESI hiccup — fine, just no "already own it" fast path
  }

  const [{ bestCopy, bestOriginal }, marketPrices] = await Promise.all([
    findCheapestBlueprintContracts(blueprintTypeIDs),
    getForgeRegionPricesBulk(blueprintTypeIDs),
  ]);

  // productTypeID -> Array<{ source, me, te, price, runsPerCopy }>,
  // runsPerCopy null meaning a one-time buy (owned/original/market) rather
  // than a per-run amortized copy.
  const candidatesByType = new Map();
  // productTypeID -> highest ME among that type's candidates — used only to
  // size material DEMAND (accumulateDemand, bom.js pass 1) before it's known
  // which candidate rollUp() will actually pick as cheapest; assuming the
  // best-case material efficiency there is a safe, minor simplification
  // (the actual chosen candidate's own ME is what really prices materials
  // in pass 2 — see rollUp).
  const bestMe = new Map();

  for (const { typeID, recipe } of withRecipe) {
    const candidates = [];
    const owned = ownedByProduct.get(typeID);
    if (owned) candidates.push({ source: "owned", me: owned.me, te: owned.te, price: 0, runsPerCopy: null });

    const copy = bestCopy.get(recipe.blueprintTypeID);
    if (copy) candidates.push({ source: "copy", me: copy.materialEfficiency, te: copy.timeEfficiency, price: copy.price, runsPerCopy: copy.runs });

    const original = bestOriginal.get(recipe.blueprintTypeID);
    if (original) candidates.push({ source: "original", me: original.materialEfficiency, te: original.timeEfficiency, price: original.price, runsPerCopy: null });

    // Plain market orders carry no ME/TE field at all — Reaction Formulas
    // and the handful of BPOs NPC corps sell this way are always ME0/TE0 by
    // game design (verified live earlier this session), not a guess.
    const market = marketPrices[recipe.blueprintTypeID];
    if (market?.sell != null) candidates.push({ source: "market", me: 0, te: 0, price: market.sell, runsPerCopy: null });

    if (!candidates.length) continue; // no real blueprint anywhere

    candidatesByType.set(typeID, candidates);
    bestMe.set(typeID, Math.max(...candidates.map((c) => c.me)));
  }

  return { candidatesByType, bestMe };
}
