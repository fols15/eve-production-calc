// Correct build/buy costing for a production tree.
//
// The naive approach (decide build-vs-buy independently at every occurrence
// of a material in the tree) breaks down badly for anything that reuses the
// same reaction/component many times at very different quantities — e.g.
// Vagabond needs "Fernite Carbide" in 7 different places, from 284 up to
// 200,495 units. Because reactions/manufacturing run in discrete batches
// (Math.ceil to whole runs), the per-unit cost of building a *tiny* local
// requirement is wildly worse than building the *combined* requirement in
// one go (in one real test: 1,403 ISK/unit at qty 284 vs 30 ISK/unit at qty
// 200,495 — a 46x difference for the exact same material). Deciding per
// occurrence, then caching that single typeID→decision globally (as the
// first version of this tool did), picks whichever occurrence happened to
// be visited last and applies it everywhere — self-contradictory and wrong.
//
// The fix mirrors how a real EVE industrialist plans a build: first add up
// the TOTAL demand for each material across the whole tree, THEN decide
// once (per typeID) whether building that combined total is cheaper than
// buying it, in dependency order (deepest materials first, since a parent's
// build cost depends on its materials' already-resolved per-unit rates).
import { getRecipe } from "./sde.js";
import { walkOrderBook } from "./esi.js";

const MAX_DEPTH = 10;

// Fixed since the Feb 2024 patch — not reduced by any skill, standing, or
// structure bonus (confirmed against a real in-game "Job Gross Cost"
// breakdown: EIV × 4% matched the displayed "SCC surcharge" line exactly).
// EVE University: wiki.eveuniversity.org/Manufacturing.
const SCC_SURCHARGE_PCT = 4;

// Pass 1: continuous (unrounded) demand accumulation. Purely linear — a
// typeID's total demand is just the sum of what every consumer needs of it
// — so visit order doesn't matter and no rounding happens yet (rounding
// early would double-count waste across every consumer instead of once).
//
// `meOverrides` (typeID -> ME) lets each blueprint in the tree use ITS OWN
// material efficiency instead of one flat value for everything — real BPCs
// bought off contracts rarely all share the same ME/TE. `defaultMe` is what
// applies to any typeID with no explicit override (the "ME чертежей" slider).
// `structureMePct` is a SEPARATE bonus from the production structure itself
// (its hull's own material bonus — see structures.js/getStructureMePct),
// added on top of whichever ME the blueprint has, since it applies to every
// job run in that structure regardless of which blueprint — 0 for a plain
// NPC station.
function accumulateDemand(typeID, qty, defaultMe, meOverrides, structureMePct, depth, path, demand, maxDepth) {
  demand.set(typeID, (demand.get(typeID) ?? 0) + qty);
  maxDepth.set(typeID, Math.max(maxDepth.get(typeID) ?? 0, depth));
  if (depth >= MAX_DEPTH || path.has(typeID)) return;
  const recipe = getRecipe(typeID);
  if (!recipe) return;
  const nextPath = new Set(path);
  nextPath.add(typeID);
  const me = Math.min(100, (meOverrides.get(typeID) ?? defaultMe) + structureMePct);
  const runsFraction = qty / recipe.outputQuantity;
  for (const m of recipe.materials) {
    accumulateDemand(
      m.typeID,
      m.quantity * runsFraction * (1 - me / 100),
      defaultMe,
      meOverrides,
      structureMePct,
      depth + 1,
      nextPath,
      demand,
      maxDepth
    );
  }
}

// Pass 2: process typeIDs deepest-first so every material's per-unit rate is
// already known by the time its parent needs it. Rounds to whole runs/units
// exactly once, right here, using the TRUE combined demand.
//
// `blueprintCandidates` (typeID -> Array<{source, me, te, price, runsPerCopy}>)
// replaces a single fixed ME/price per typeID: a node can have several real,
// independently-priced ways to get its blueprint (own BPO, a contract copy,
// a contract original, a Forge market original/Reaction Formula), each with
// its OWN material efficiency — a cheap ME0 copy and an expensive ME10
// original aren't comparable without actually pricing both at the runs
// actually needed here, so every found candidate is tried and whichever
// gives the lowest total (materials + job + blueprint) wins. This is "find
// the best/most efficient production method" — a fixed priority order
// (always prefer a copy, say) can't know that in advance since it depends on
// how many runs are needed, which varies every calculation.
function rollUp(demand, maxDepth, defaultMe, meOverrides, structureMePct, industry, systemId, facilityTax, jobFeeBonusPct, prices, overrides, forceAllBuild, blueprintCandidates) {
  const order = [...demand.keys()].sort((a, b) => maxDepth.get(b) - maxDepth.get(a));
  const perUnitCost = new Map();
  const perUnitJobCost = new Map();
  const decision = new Map();
  const runsNeeded = new Map(); // typeID -> blueprint runs required (only set for "build")
  const chosenBlueprint = new Map(); // typeID -> the candidate actually used (only set for "build")
  let totalJobCost = 0;

  // Materials cost/EIV for THIS node at a given ME, using already-resolved
  // child per-unit rates — a node's own ME only affects how much of each
  // child ITS OWN materials line consumes, never the children's own
  // already-finalized rates, so this is a cheap, purely local computation
  // safe to run once per candidate.
  function materialsAt(recipe, runs, me) {
    let materialsEIV = 0;
    let materialsCost = 0;
    for (const m of recipe.materials) {
      const matQty = Math.max(1, Math.ceil(m.quantity * runs * (1 - me / 100)));
      materialsEIV += matQty * industry.adjustedPrice(m.typeID);
      materialsCost += matQty * (perUnitCost.get(m.typeID) ?? 0);
    }
    return { materialsEIV, materialsCost };
  }

  for (const typeID of order) {
    const totalDemand = demand.get(typeID);
    const recipe = getRecipe(typeID);
    const price = prices[typeID] ?? { sell: null, buy: null, sellOrders: [] };
    const forced = forceAllBuild ? "build" : overrides[typeID];

    if (!recipe) {
      perUnitCost.set(typeID, walkOrderBook(price.sellOrders, totalDemand).unitCost ?? 0);
      perUnitJobCost.set(typeID, 0);
      decision.set(typeID, "market");
      continue;
    }
    if (forced === "buy") {
      perUnitCost.set(typeID, walkOrderBook(price.sellOrders, totalDemand).unitCost ?? 0);
      perUnitJobCost.set(typeID, 0);
      decision.set(typeID, "buy");
      continue;
    }

    const runs = Math.max(1, Math.ceil(totalDemand / recipe.outputQuantity));
    const producedQty = runs * recipe.outputQuantity;
    // Real formula (confirmed against an in-game Job Gross Cost breakdown):
    //   EIV × ( SystemCostIndex × (1 − JobFeeBonus%) + FacilityTax% + SCCSurcharge% )
    // JobFeeBonus (Raitaru/Azbel/Sotiyo — structures.js/getStructureJobFeeBonus)
    // only discounts the cost-index portion; facility tax and the SCC
    // surcharge are untouched by it. Not modeled: Alpha clone tax (+0.25%,
    // only applies to Alpha-clone characters).
    const costIndex = industry.costIndex(systemId, recipe.activityID);

    // Try every real candidate source for this blueprint (see comment
    // above) and keep whichever is actually cheapest at these `runs`.
    // `runsPerCopy` falsy (null) marks a one-time buy — owned/original/a
    // market Reaction Formula, infinitely reusable once bought, so its full
    // price is charged exactly once regardless of runs, instead of
    // amortized per batch like a copy.
    const candidates = blueprintCandidates.get(typeID);
    let best = null;
    if (candidates?.length) {
      for (const cand of candidates) {
        const me = Math.min(100, cand.me + structureMePct);
        const { materialsEIV, materialsCost } = materialsAt(recipe, runs, me);
        const jobCostTotal = materialsEIV * (costIndex * (1 - jobFeeBonusPct / 100) + facilityTax / 100 + SCC_SURCHARGE_PCT / 100);
        const blueprintCost = cand.runsPerCopy ? Math.ceil(runs / cand.runsPerCopy) * cand.price : cand.price;
        const totalCost = materialsCost + jobCostTotal + blueprintCost;
        if (!best || totalCost < best.totalCost) best = { cand, me, materialsCost, jobCostTotal, totalCost };
      }
    } else {
      // No real blueprint found anywhere for this typeID — same fallback as
      // before candidates existed: defaultMe/meOverrides, zero blueprint
      // cost (can't price acquiring something with no known source).
      const me = Math.min(100, (meOverrides.get(typeID) ?? defaultMe) + structureMePct);
      const { materialsEIV, materialsCost } = materialsAt(recipe, runs, me);
      const jobCostTotal = materialsEIV * (costIndex * (1 - jobFeeBonusPct / 100) + facilityTax / 100 + SCC_SURCHARGE_PCT / 100);
      best = { cand: null, me, materialsCost, jobCostTotal, totalCost: materialsCost + jobCostTotal };
    }

    const buildCostTotal = best.totalCost;
    // Walked at producedQty (not totalDemand) to compare build vs buy at the
    // SAME quantity — building unavoidably yields whole batches, so this is
    // "what would producedQty units cost either way", which is what makes
    // buildCostTotal/producedQty a valid per-unit rate below.
    const marketBuy = walkOrderBook(price.sellOrders, producedQty);
    const buyCostTotal = marketBuy.unitCost != null ? marketBuy.totalCost : Infinity;

    const build = forced === "build" || buildCostTotal <= buyCostTotal;
    if (build) {
      perUnitCost.set(typeID, buildCostTotal / producedQty);
      perUnitJobCost.set(typeID, best.jobCostTotal / producedQty);
      decision.set(typeID, "build");
      runsNeeded.set(typeID, runs);
      totalJobCost += best.jobCostTotal;
      if (best.cand) chosenBlueprint.set(typeID, { ...best.cand, me: best.me });
    } else {
      perUnitCost.set(typeID, marketBuy.unitCost ?? 0);
      perUnitJobCost.set(typeID, 0);
      decision.set(typeID, "buy");
    }
  }

  return { perUnitCost, perUnitJobCost, decision, runsNeeded, totalJobCost, chosenBlueprint };
}

// Discovers every typeID reachable from the root (for bulk price fetching)
// without needing quantities — same reachability regardless of qty/me.
export function discoverTypeIDs(rootTypeID, out = new Set(), depth = 0, path = new Set()) {
  out.add(rootTypeID);
  if (depth >= MAX_DEPTH || path.has(rootTypeID)) return out;
  const recipe = getRecipe(rootTypeID);
  if (!recipe) return out;
  const nextPath = new Set(path);
  nextPath.add(rootTypeID);
  for (const m of recipe.materials) discoverTypeIDs(m.typeID, out, depth + 1, nextPath);
  return out;
}

// Pass 1 only — total demand per typeID, independent of system/facility tax.
// Reuse this across many rollUpBOM() calls (e.g. ranking candidate systems)
// instead of recomputing the same demand accumulation for each one.
export function computeDemand(rootTypeID, rootQty, me, meOverrides = new Map(), structureMePct = 0) {
  const demand = new Map();
  const maxDepth = new Map();
  accumulateDemand(rootTypeID, rootQty, me, meOverrides, structureMePct, 0, new Set(), demand, maxDepth);
  return { demand, maxDepth };
}

// Pass 2 only — decide build/buy and price everything for ONE system, given
// already-computed demand. `prices` must cover every typeID in `demand`.
// `forceAllBuild: true` ignores the buy option entirely (used for the "what
// would this cost if I built everything myself" baseline). `meOverrides` and
// `structureMePct` MUST be the same values passed to the computeDemand()
// call that produced `demand`/`maxDepth` — pass 1 already baked each
// typeID's effective ME (its own ME + the structure bonus) into how much of
// ITS materials were demanded, so pass 2 has to use that exact same
// effective ME again when pricing those materials, or the two would disagree.
export function rollUpBOM(
  rootTypeID,
  rootQty,
  demand,
  maxDepth,
  me,
  industry,
  systemId,
  facilityTax,
  prices,
  overrides = {},
  forceAllBuild = false,
  meOverrides = new Map(),
  structureMePct = 0,
  jobFeeBonusPct = 0,
  blueprintCandidates = new Map()
) {
  const { perUnitCost, perUnitJobCost, decision, runsNeeded, totalJobCost, chosenBlueprint } = rollUp(
    demand,
    maxDepth,
    me,
    meOverrides,
    structureMePct,
    industry,
    systemId,
    facilityTax,
    jobFeeBonusPct,
    prices,
    overrides,
    forceAllBuild,
    blueprintCandidates
  );
  const rootCost = (perUnitCost.get(rootTypeID) ?? 0) * rootQty;
  return { decision, perUnitCost, perUnitJobCost, runsNeeded, totalJobCost, chosenBlueprint, rootCost };
}

// Convenience wrapper for the common single-system case.
export function computeAggregateBOM(
  rootTypeID,
  rootQty,
  me,
  industry,
  systemId,
  facilityTax,
  prices,
  overrides = {},
  forceAllBuild = false,
  meOverrides = new Map(),
  structureMePct = 0,
  jobFeeBonusPct = 0,
  blueprintCandidates = new Map()
) {
  const { demand, maxDepth } = computeDemand(rootTypeID, rootQty, me, meOverrides, structureMePct);
  return {
    demand,
    ...rollUpBOM(
      rootTypeID,
      rootQty,
      demand,
      maxDepth,
      me,
      industry,
      systemId,
      facilityTax,
      prices,
      overrides,
      forceAllBuild,
      meOverrides,
      structureMePct,
      jobFeeBonusPct,
      blueprintCandidates
    ),
  };
}

// Flattens the tree's current "buy boundary" (raw/bought materials, given
// `decision`) into a shopping list grouped by typeID — what to actually
// instant-buy on the market. Stops descending once a node is bought, since
// its own materials aren't separately needed.
//
// Quantity comes from `demand` (the aggregate pass-1 total), NOT from
// summing the DISPLAY tree's node.quantity across occurrences. The display
// tree independently Math.ceil()s at every single level of every single
// occurrence (see buildTree in index.js) — a deliberate per-occurrence
// worst-case rounding for showing "what does this one branch need", which
// compounds across a deep tree and can overstate the true combined quantity
// by an order of magnitude (measured up to ~14x on a real T2 ship: e.g. one
// reaction material's occurrences summed to 5,265 units on the display tree
// vs 362.9 units of real aggregate demand). That was harmless while pricing
// used one flat rate regardless of quantity, but silently blew up once
// pricing started walking a real, quantity-sensitive order book. `demand`
// is exactly the corrected total rollUp() already used to compute
// `perUnitCost`, so using it here keeps this list's total equal to
// bom.rootCost instead of a multiple of it.
export function buildShoppingList(node, decision, demand, perUnitCost, acc = new Map()) {
  const isLeaf = !node.buildable || decision.get(node.typeID) !== "build";
  if (isLeaf) {
    if (!acc.has(node.typeID)) {
      // demand is intentionally continuous/unrounded (see accumulateDemand)
      // — fine for computing a per-unit rate, but you can't actually buy
      // 35.84 units of something, so round up for the quantity you'd type
      // into a buy order.
      const rawQty = demand.get(node.typeID) ?? node.quantity;
      acc.set(node.typeID, {
        typeID: node.typeID,
        name: node.name,
        quantity: Math.max(1, Math.ceil(rawQty)),
        unitPrice: perUnitCost.get(node.typeID) ?? null,
      });
    }
    return acc;
  }
  for (const m of node.materials) buildShoppingList(m, decision, demand, perUnitCost, acc);
  return acc;
}
