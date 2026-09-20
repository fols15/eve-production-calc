import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchTypes, getType, getRecipe, browseGroup, searchSystems, jumpsFrom, routeBetween, getManufacturingStations, systems as allSystems, getSystem, getTypeIdByName, blueprints } from "./sde.js";
import { getJitaPricesBulk, getOrderBook, walkOrderBook, getSystemPrices, getMarketHistory } from "./esi.js";
import { createAppraisalLink } from "./goonpraisal.js";
import { loadIndustryData } from "./industry.js";
import { computeAggregateBOM, computeDemand, rollUpBOM, discoverTypeIDs, buildShoppingList } from "./bom.js";
import * as oauth from "./oauth.js";
import * as structures from "./structures.js";
import { getTaxRates, getOwnedBlueprints } from "./character.js";
import { resolveRealBlueprints } from "./blueprintSourcing.js";

const JITA_SYSTEM_ID = 30000142;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT ?? 3099;
// PUBLIC=1 снимает привязку к localhost и выключает EVE SSO (см. ниже).
// Без неё всё работает как раньше: только с этого компьютера.
const PUBLIC = process.env.PUBLIC === "1";
const HOST = process.env.HOST ?? (PUBLIC ? "0.0.0.0" : "127.0.0.1");

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/mode", (req, res) => res.json({ public: PUBLIC }));

// Публичный режим: калькулятор доступен всем, а всё, что зависит от личного
// персонажа, отключено — чтобы ни один посетитель не получил и не перезаписал
// токены владельца в data/user/auth.json. Эти маршруты объявлены раньше настоящих,
// поэтому Express берёт именно их. Ответы повторяют состояние «не выполнен вход»,
// которое фронтенд уже умеет обрабатывать.
if (PUBLIC) {
  const off = (req, res) =>
    res.status(403).json({ error: "\u041e\u0442\u043a\u043b\u044e\u0447\u0435\u043d\u043e \u0432 \u043f\u0443\u0431\u043b\u0438\u0447\u043d\u043e\u043c \u0440\u0435\u0436\u0438\u043c\u0435" });

  app.get("/api/auth/status", (req, res) => res.json({ loggedIn: false }));
  app.get("/api/oauth-config/status", (req, res) => res.json({ configured: false }));
  app.get("/auth/login", (req, res) => res.redirect("/"));
  app.get("/auth/callback", off);
  app.post("/api/oauth-config", off);
  app.post("/api/auth/logout", off);
  app.post("/api/my-corp-structures/sync", off);
  app.get("/api/character/tax-rates", off);
  app.get("/api/character/owned-blueprints", off);

  // GET /api/structures → пустой список; всё остальное под этим путём — 403.
  app.use("/api/structures", (req, res, next) => {
    if (req.method === "GET" && (req.path === "/" || req.path === "")) return res.json([]);
    return off(req, res);
  });
}
app.use(express.json());

app.get("/api/search", (req, res) => {
  const q = String(req.query.q ?? "");
  res.json(searchTypes(q));
});

app.get("/api/browse", (req, res) => {
  const groupId = req.query.groupId !== undefined ? Number(req.query.groupId) : null;
  res.json(browseGroup(groupId));
});

app.get("/api/systems/search", (req, res) => {
  const q = String(req.query.q ?? "");
  res.json(searchSystems(q));
});

// How much a single blueprint run of this item actually produces — shown
// right when an item is picked, before any quantity is typed or calculated.
// Batch size varies a lot by item (T1 small ammo: 100/run, some capital
// modules/Standup structure ammo: 1/run) and typing "1" in "Количество
// единиц" meaning "1 unit" rather than "1 run" for a big-batch item makes
// the resulting cost/revenue look tiny and easy to mistake for a bug.
app.get("/api/recipe-info", (req, res) => {
  const typeID = Number(req.query.typeId);
  if (!Number.isFinite(typeID)) return res.status(400).json({ error: "invalid typeId" });
  const recipe = getRecipe(typeID);
  if (!recipe) return res.json({ buildable: false });
  const blueprintType = getType(recipe.blueprintTypeID);
  res.json({
    buildable: true,
    outputQuantity: recipe.outputQuantity,
    activityID: recipe.activityID,
    blueprintTypeID: recipe.blueprintTypeID,
    blueprintName: blueprintType ? blueprintType.name : `#${recipe.blueprintTypeID}`,
  });
});

app.post("/api/appraise-link", async (req, res) => {
  try {
    const lines = Array.isArray(req.body?.lines) ? req.body.lines.filter((l) => typeof l === "string" && l.trim()) : [];
    if (!lines.length) return res.status(400).json({ error: "no lines to appraise" });
    res.json({ url: await createAppraisalLink(lines) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// ---- EVE SSO login + "my corp's structures" ----

app.get("/api/oauth-config/status", (req, res) => {
  const config = oauth.getConfig();
  res.json({ configured: Boolean(config), clientId: config?.clientId ?? null, redirectUri: oauth.REDIRECT_URI, scopes: oauth.SCOPES });
});

app.post("/api/oauth-config", (req, res) => {
  const { clientId, clientSecret } = req.body ?? {};
  if (!clientId || !clientSecret) return res.status(400).json({ error: "clientId и clientSecret обязательны" });
  oauth.saveConfig(clientId, clientSecret);
  res.json({ ok: true });
});

app.get("/api/auth/status", (req, res) => {
  const auth = oauth.getAuth();
  res.json({
    loggedIn: Boolean(auth),
    characterName: auth?.characterName ?? null,
    corporationId: auth?.corporationId ?? null,
  });
});

app.post("/api/auth/logout", (req, res) => {
  oauth.clearAuth();
  res.json({ ok: true });
});

app.get("/auth/login", (req, res) => {
  try {
    res.redirect(oauth.buildLoginUrl());
  } catch (err) {
    res.status(400).send(`Ошибка: ${err.message}`);
  }
});

app.get("/auth/callback", async (req, res) => {
  try {
    await oauth.handleCallback(req.query.code, req.query.state);
    res.redirect("/?loggedin=1");
  } catch (err) {
    res.status(400).send(`Ошибка входа через EVE SSO: ${err.message}`);
  }
});

app.post("/api/my-corp-structures/sync", async (req, res) => {
  try {
    const entries = await structures.syncCorpStructures();
    res.json({ count: entries.length });
  } catch (err) {
    res.status(400).json({ error: String(err.message ?? err) });
  }
});

// Resolves a structure you don't own by name via ESI (see structures.js/
// searchStructuresByName) — the only legal way to find one, since CCP has
// no "structures in this system" endpoint.
app.get("/api/structures/search", async (req, res) => {
  try {
    const q = String(req.query.q ?? "");
    res.json(await structures.searchStructuresByName(q));
  } catch (err) {
    res.status(400).json({ error: String(err.message ?? err) });
  }
});

app.get("/api/character/tax-rates", async (req, res) => {
  try {
    res.json(await getTaxRates());
  } catch (err) {
    res.status(400).json({ error: String(err.message ?? err) });
  }
});

// Blueprint ORIGINALS the character owns (see character.js/getOwnedBlueprints)
// — the client uses this to skip both the BPC-copy cost AND the contract
// price search for anything it covers, and to use the owned ME/TE instead
// of a contract-found or default one.
app.get("/api/character/owned-blueprints", async (req, res) => {
  try {
    res.json(await getOwnedBlueprints());
  } catch (err) {
    res.status(400).json({ error: String(err.message ?? err) });
  }
});

// ---- known structures (manual + synced from corp) ----

app.get("/api/structures", (req, res) => {
  res.json(
    structures.listStructures().map((s) => ({
      ...s,
      structureMePct: structures.getStructureMePct(s),
      jobFeeBonusPct: structures.getStructureJobFeeBonus(s),
    }))
  );
});

app.post("/api/structures", (req, res) => {
  try {
    // typeId comes straight from an ESI search result (structures.js) when
    // adding someone else's structure; typeName is the manual-entry form's
    // dropdown (Raitaru/Azbel/etc.) — either resolves to the same typeId.
    const { name, systemId, typeName, typeId, structureId, facilityTax } = req.body ?? {};
    if (!name || !systemId) return res.status(400).json({ error: "name и systemId обязательны" });
    const systemMeta = getSystem(Number(systemId));
    if (!systemMeta) return res.status(400).json({ error: "неизвестная система" });
    const resolvedTypeId = typeId ?? (typeName ? getTypeIdByName(typeName) : null);
    const entry = structures.addManualStructure({
      name,
      systemId: Number(systemId),
      systemName: systemMeta.name,
      typeId: resolvedTypeId,
      typeName: typeName ?? (resolvedTypeId ? getType(resolvedTypeId)?.name ?? null : null),
      structureId: structureId ?? null,
      facilityTax,
    });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

app.delete("/api/structures/:id", (req, res) => {
  const removed = structures.removeManualStructure(req.params.id);
  if (!removed) return res.status(404).json({ error: "not found (only manually added structures can be removed)" });
  res.json({ ok: true });
});

app.patch("/api/structures/:id/tax", (req, res) => {
  const ok = structures.updateStructureTax(req.params.id, req.body?.facilityTax);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

app.get("/api/orderbook", async (req, res) => {
  try {
    const typeID = Number(req.query.typeId);
    if (!Number.isFinite(typeID)) return res.status(400).json({ error: "invalid typeId" });
    res.json(await getOrderBook(typeID));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// Daily price/volume chart data (The Forge region — ESI has no per-station
// history) for the item view's price chart.
app.get("/api/market-history", async (req, res) => {
  try {
    const typeID = Number(req.query.typeId);
    if (!Number.isFinite(typeID)) return res.status(400).json({ error: "invalid typeId" });
    res.json(await getMarketHistory(typeID));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

const MAX_DEPTH = 10;
const MAX_NODES = 3000;

// Builds the DISPLAY tree — the hierarchy shown in the UI, with each node's
// quantity as needed AT THAT SPECIFIC POSITION. This is for showing "what
// needs what" and does NOT by itself decide build-vs-buy or job cost: the
// same material can appear here many times at very different quantities
// (Vagabond needs "Fernite Carbide" 7 times, from 284 to 200,495 units), and
// pricing each occurrence in isolation over- or under-estimates cost because
// reactions/manufacturing run in discrete batches. Real costing comes from
// computeAggregateBOM() (bom.js), which sums total demand per typeID across
// the WHOLE tree first, then decides build-vs-buy and prices it ONCE — see
// attachBomResults() below, which stamps each node with that shared,
// consistent per-typeID rate instead of a node-local one.
function buildTree(typeID, quantity, defaultMe, meOverrides, structureMePct, timeCtx, depth, path, counter) {
  counter.n += 1;
  const type = getType(typeID);
  const name = type ? type.name : `#${typeID}`;
  const recipe = getRecipe(typeID);
  const buildable = Boolean(recipe) && depth < MAX_DEPTH && counter.n < MAX_NODES && !path.has(typeID);

  const node = { typeID, name, quantity, buildable };

  if (buildable) {
    // Each blueprint can carry its OWN ME (a real BPC bought off a contract
    // has whatever ME it has) — meOverrides[typeID] wins over the "ME
    // чертежей" slider, which is just the default for anything not set.
    // node.me stays the BLUEPRINT's own ME (what the tree's per-row ME input
    // edits, feeding back into meOverrides) — structureMePct (the chosen
    // production structure's own hull bonus, 0 for a plain NPC station —
    // see structures.js) is kept separate and only folded in for the actual
    // material-quantity math, so editing that input never double-counts an
    // already-applied structure bonus.
    const blueprintMe = meOverrides.get(typeID) ?? defaultMe;
    const effectiveMe = Math.min(100, blueprintMe + structureMePct);
    const runs = Math.ceil(quantity / recipe.outputQuantity);
    const nextPath = new Set(path);
    nextPath.add(typeID);
    node.me = blueprintMe;
    node.structureMePct = structureMePct;
    node.runs = runs;
    node.outputQuantity = recipe.outputQuantity;
    node.timePerRun = recipe.time;
    node.activityID = recipe.activityID;

    // Same layering as ME, plus two more independent multiplicative factors
    // ME doesn't have: the structure's OWN duration bonus differs by activity
    // (an Engineering Complex speeds up Manufacturing, a Refinery speeds up
    // Reactions instead — never both), and the character's Industry/Advanced
    // Industry skills only ever speed up Manufacturing (confirmed via ESI
    // dogma — see character.js), never Reactions.
    const te = Math.min(20, Math.max(0, timeCtx.teOverrides.get(typeID) ?? timeCtx.defaultTe));
    const isReaction = recipe.activityID === 11;
    const durationBonusPct = isReaction ? timeCtx.structureReactionDurationPct : timeCtx.structureManufacturingDurationPct;
    const skillMultiplier = isReaction ? 1 : (1 - 0.04 * timeCtx.industryLevel) * (1 - 0.03 * timeCtx.advancedIndustryLevel);
    const timePerRunEffective = recipe.time * (1 - te / 100) * (1 - durationBonusPct / 100) * skillMultiplier;
    node.te = te;
    node.timeSec = runs * timePerRunEffective;

    node.materials = recipe.materials.map((m) => {
      const matQty = Math.max(1, Math.ceil(m.quantity * runs * (1 - effectiveMe / 100)));
      return buildTree(m.typeID, matQty, defaultMe, meOverrides, structureMePct, timeCtx, depth + 1, nextPath, counter);
    });
  }

  return node;
}

function collectTypeIDs(node, out) {
  out.add(node.typeID);
  if (node.materials) for (const m of node.materials) collectTypeIDs(m, out);
}

// Only sell/buy (the reference prices) go on tree nodes — the full order
// book per node would bloat the response for trees with thousands of nodes.
// `prices` itself (the bulk lookup result, kept separately) still carries
// the full sellOrders/buyOrders for whichever typeIDs need walked pricing.
function attachPrices(node, prices) {
  const p = prices[node.typeID];
  node.price = { sell: p?.sell ?? null, buy: p?.buy ?? null };
  if (node.materials) for (const m of node.materials) attachPrices(m, prices);
}

// Stamps each node with the GLOBALLY consistent per-typeID results from the
// aggregate BOM: the decision actually used (server default, or the
// request's override) and this occurrence's cost. node.unitCost already
// includes everything below it (job cost + materials, fully resolved) AND —
// for bought/raw nodes — is the order-book-walked rate for the material's
// TOTAL demand across the whole tree, not a flat "cheapest ask" price, so
// the UI can just multiply by node.quantity — no client-side recursion or
// re-pricing, which is what silently produced wrong, compounding totals
// before this fix. Runs for every node (not just buildable ones) so leaf/raw
// materials get a real unitCost too, instead of falling back to the flat
// reference price and quietly disagreeing with the aggregate totals.
function attachBomResults(node, bom, timeCtx) {
  node.decision = bom.decision.get(node.typeID) ?? "market";
  node.unitCost = bom.perUnitCost.get(node.typeID) ?? 0;
  if (node.buildable) {
    node.jobCost = (bom.perUnitJobCost.get(node.typeID) ?? 0) * node.quantity;
    // buildTree() had to guess a PROVISIONAL me/te before rollUp() had a
    // chance to try every real blueprint candidate and pick the actually
    // cheapest one (see bom.js) — correct the label (and the time estimate,
    // which depends on te) to whichever candidate really got chosen. Only
    // meaningful when this node is actually being built with a known real
    // source; otherwise the provisional value (already the best-available
    // ME, for a safe demand estimate) stands.
    const chosen = bom.chosenBlueprint?.get(node.typeID);
    if (chosen) {
      const recipe = getRecipe(node.typeID);
      node.me = chosen.me - node.structureMePct; // node.me is the BLUEPRINT's own ME, structure bonus tracked separately (see buildTree)
      node.te = chosen.te;
      const isReaction = recipe.activityID === 11;
      const durationBonusPct = isReaction ? timeCtx.structureReactionDurationPct : timeCtx.structureManufacturingDurationPct;
      const skillMultiplier = isReaction ? 1 : (1 - 0.04 * timeCtx.industryLevel) * (1 - 0.03 * timeCtx.advancedIndustryLevel);
      const timePerRunEffective = recipe.time * (1 - node.te / 100) * (1 - durationBonusPct / 100) * skillMultiplier;
      node.timeSec = node.runs * timePerRunEffective;
    }
    for (const m of node.materials) attachBomResults(m, bom, timeCtx);
  }
}

// Total job cost for the ACTUAL build path, prorated to what was actually
// requested — NOT bom.totalJobCost, which sums every build-decided typeID's
// FULL job-run fee regardless of how much of that run's output the parent
// actually needed. That undercounts nothing but also never prorates: asking
// for 10 units of a 100-unit-batch blueprint still shows the fee for the
// WHOLE 100-unit run, which can even exceed the request's own totalCost
// (perUnitCost IS prorated: buildCostTotal/producedQty * requestedQty) —
// making the "материалы + job cost" breakdown not add up, and appearing to
// "not change" as long as the requested quantity stays under one full run.
// Walking the tree instead (like buildShoppingList/collectBlueprintsNeeded)
// sums each node's already-prorated node.quantity * perUnitJobCost, stopping
// at buy boundaries so a bought node's now-irrelevant sub-materials don't
// count either.
function sumJobCost(node, decision, perUnitJobCost) {
  const isLeaf = !node.buildable || decision.get(node.typeID) !== "build";
  if (isLeaf) return 0;
  let sum = (perUnitJobCost.get(node.typeID) ?? 0) * node.quantity;
  for (const m of node.materials) sum += sumJobCost(m, decision, perUnitJobCost);
  return sum;
}

// Every node the BOM decided to actually BUILD needs its own blueprint — a
// separate acquisition cost from materials/job cost, since blueprints can't
// be bought with plain market orders (see contracts.js). Walks the TREE
// (like buildShoppingList) rather than bom.decision's flat map: `demand`
// accumulates every reachable typeID's quantity unconditionally, regardless
// of an ANCESTOR's decision, so a material only stops mattering once you
// stop descending past a "buy" boundary — iterating the flat map would keep
// listing blueprints for a node's sub-materials even after that node itself
// got switched to "buy" (they're no longer actually needed at all).
function collectBlueprintsNeeded(node, bom, seen = new Map()) {
  const isLeaf = !node.buildable || bom.decision.get(node.typeID) !== "build";
  if (isLeaf) return seen;

  if (!seen.has(node.typeID)) {
    const recipe = getRecipe(node.typeID);
    if (recipe && recipe.blueprintTypeID) {
      const productType = getType(node.typeID);
      const blueprintType = getType(recipe.blueprintTypeID);
      seen.set(node.typeID, {
        productTypeID: node.typeID,
        productName: productType ? productType.name : `#${node.typeID}`,
        blueprintTypeID: recipe.blueprintTypeID,
        blueprintName: blueprintType ? blueprintType.name : `#${recipe.blueprintTypeID}`,
        runsNeeded: bom.runsNeeded.get(node.typeID) ?? null,
        outputQuantity: recipe.outputQuantity,
        me: node.me ?? null,
      });
    }
  }
  for (const m of node.materials) collectBlueprintsNeeded(m, bom, seen);
  return seen;
}

async function buildPricedTree(typeID, quantity, me, meOverrides, structureMePct = 0, timeCtx = DEFAULT_TIME_CTX) {
  const industry = await loadIndustryData();
  const counter = { n: 0 };
  const tree = buildTree(typeID, quantity, me, meOverrides, structureMePct, timeCtx, 0, new Set(), counter);

  const ids = new Set();
  collectTypeIDs(tree, ids);
  const prices = await getJitaPricesBulk([...ids]);
  attachPrices(tree, prices);

  return { tree, industry, prices };
}

// Stamps each blueprintsNeeded entry with the source rollUp() actually chose
// (see bom.js — it tried every real candidate at the runs really needed and
// kept whichever was cheapest) and how many COPIES that took to buy (whole
// copies, since a bought copy can't be reused elsewhere), using the
// aggregate runsNeeded (bom.runsNeeded, already correctly de-duplicated
// across every occurrence in the tree — NOT the display tree's
// per-occurrence values, same class of bug fixed earlier for job cost).
// Returns the grand total to fold into the response's totalCost.
function attachBlueprintCosts(blueprintsNeeded, chosenBlueprint) {
  let total = 0;
  for (const bp of blueprintsNeeded) {
    const chosen = chosenBlueprint.get(bp.productTypeID);
    if (!chosen) continue; // no real blueprint found — shouldn't happen for a "build" node, but stay defensive
    bp.source = chosen.source;
    if (!bp.runsNeeded) continue;
    // runsPerCopy falsy (null) means a one-time buy (own/original/market) —
    // exactly one purchase regardless of runs needed, same convention as bom.js.
    bp.copiesNeeded = chosen.runsPerCopy ? Math.max(1, Math.ceil(bp.runsNeeded / chosen.runsPerCopy)) : 1;
    bp.pricePerCopy = chosen.price;
    bp.totalBlueprintCost = bp.copiesNeeded * chosen.price;
    total += bp.totalBlueprintCost;
  }
  return total;
}

// Character-wide job-duration inputs: the default TE for any blueprint
// without its own override, plus Industry/Advanced Industry skill levels
// (sent by the client — normally filled in via "Подтянуть из аккаунта",
// same flow as Sales Tax/Broker's Fee; see character.js for what those
// skills actually do). None of this depends on which system/structure is
// chosen, unlike structureManufacturingDurationPct/structureReactionDurationPct
// (see resolveProductionSite), which get merged in separately per node.
function parseTimeParams(req) {
  const defaultTe = Math.min(20, Math.max(0, Number(req.query.te ?? 0)));
  const industryLevel = Math.min(5, Math.max(0, Number(req.query.industryLevel ?? 0)));
  const advancedIndustryLevel = Math.min(5, Math.max(0, Number(req.query.advancedIndustryLevel ?? 0)));
  return { defaultTe, industryLevel, advancedIndustryLevel };
}

const DEFAULT_TIME_CTX = {
  defaultTe: 0,
  teOverrides: new Map(),
  structureManufacturingDurationPct: 0,
  structureReactionDurationPct: 0,
  industryLevel: 0,
  advancedIndustryLevel: 0,
};

// Resolves WHERE the job actually runs. Passing a known structureId (your
// own corp's, or any player's structure you've added to "Мои структуры" —
// nothing about that list requires ownership) makes the server the single
// source of truth for that structure's systemId/facilityTax/ME bonus,
// instead of trusting whatever the client last had cached; a plain systemId
// (searching by system name, or no structure known for this build) keeps
// today's behavior — manual facilityTax, no structure ME bonus.
function resolveProductionSite(req) {
  const structureId = req.query.structureId ? String(req.query.structureId) : null;
  if (structureId) {
    const structure = structures.listStructures().find((s) => s.id === structureId);
    if (!structure) throw Object.assign(new Error("unknown structureId"), { status: 404 });
    return {
      systemId: structure.systemId,
      facilityTax: structure.facilityTax,
      structureMePct: structures.getStructureMePct(structure),
      jobFeeBonusPct: structures.getStructureJobFeeBonus(structure),
      // Activity-specific (Engineering Complex vs Refinery) — buildTree picks
      // whichever applies per node's own activityID (see structures.js).
      structureManufacturingDurationPct: structures.getStructureDurationBonus(structure, 1),
      structureReactionDurationPct: structures.getStructureDurationBonus(structure, 11),
    };
  }
  const systemId = Number(req.query.systemId ?? JITA_SYSTEM_ID);
  const facilityTax = Math.max(0, Number(req.query.facilityTax ?? 0));
  return {
    systemId,
    facilityTax,
    structureMePct: 0,
    jobFeeBonusPct: 0,
    structureManufacturingDurationPct: 0,
    structureReactionDurationPct: 0,
  };
}

// Parses a comma-separated list of solarSystemIDs (e.g. "?avoid=30000142,30002187")
// into a Set for jumpsFrom/routeBetween — systems the user wants routed around
// entirely (unsafe space, blocked route, etc.) rather than just deprioritized.
function parseAvoidSet(req) {
  const raw = String(req.query.avoid ?? "").trim();
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  return ids.length ? new Set(ids) : null;
}

app.get("/api/tree", async (req, res) => {
  try {
    const typeID = Number(req.query.typeId);
    const quantity = Math.max(1, Number(req.query.quantity ?? 1));
    if (!Number.isFinite(typeID)) return res.status(400).json({ error: "invalid typeId" });
    if (!getType(typeID)) return res.status(404).json({ error: "unknown type" });

    // Manual per-node build/buy override from the tree's checkboxes — still
    // supported, independent of blueprint sourcing below.
    let overrides = {};
    if (req.query.overrides) {
      try {
        overrides = JSON.parse(req.query.overrides);
      } catch {
        return res.status(400).json({ error: "invalid overrides JSON" });
      }
    }
    let systemId, facilityTax, structureMePct, jobFeeBonusPct, structureManufacturingDurationPct, structureReactionDurationPct;
    try {
      ({
        systemId,
        facilityTax,
        structureMePct,
        jobFeeBonusPct,
        structureManufacturingDurationPct,
        structureReactionDurationPct,
      } = resolveProductionSite(req));
    } catch (err) {
      return res.status(err.status ?? 400).json({ error: err.message });
    }
    const { industryLevel, advancedIndustryLevel } = parseTimeParams(req);

    // Steps 1+2 of the unified profit calculation: for every blueprint
    // reachable from this item, find out whether a REAL one exists (own,
    // contract copy, contract original, Forge market — every one found, not
    // just the first by priority) and, via bom.js's rollUp(), let it try
    // each and keep whichever is actually cheapest at the runs really
    // needed — never an assumed "ME чертежей" slider. See blueprintSourcing.js.
    const reachable = [...discoverTypeIDs(typeID)];
    const { candidatesByType, bestMe } = await resolveRealBlueprints(reachable);

    // Anything buildable with no real blueprint found ANYWHERE can't
    // honestly be "built" — force it to a market buy instead of silently
    // costing it as if a free, perfectly-efficient blueprint existed.
    const autoOverrides = {};
    for (const rid of reachable) {
      if (getRecipe(rid) && !candidatesByType.has(rid)) autoOverrides[rid] = "buy";
    }
    // The user's own manual checkbox choice (if any) wins over the automatic
    // "no blueprint found" buy — they may know something ESI can't tell us
    // (an in-progress trade, a friend's spare copy, etc.).
    const mergedOverrides = { ...autoOverrides, ...overrides };

    // bestMe (the highest ME among any found candidate) sizes DEMAND
    // (accumulateDemand) and the tree's provisional display — rollUp() below
    // then picks whichever candidate is really cheapest per node and
    // attachBomResults() corrects the node's me/te label to match; see
    // bom.js and attachBomResults for why a node's own local materials
    // waste can be corrected after the fact but a child's already-resolved
    // demand can't.
    const timeCtx = {
      defaultTe: 0,
      teOverrides: new Map(), // corrected per-node after rollUp by attachBomResults, see below
      structureManufacturingDurationPct,
      structureReactionDurationPct,
      industryLevel,
      advancedIndustryLevel,
    };

    const { tree, industry, prices } = await buildPricedTree(typeID, quantity, 0, bestMe, structureMePct, timeCtx);
    const { demand, maxDepth } = computeDemand(typeID, quantity, 0, bestMe, structureMePct);

    // "Не строить реакции": force every Reaction Formula product found in
    // the tree (activityID 11) to be bought on the Jita market instead of
    // run as a job, overriding whatever the build/buy optimizer would
    // otherwise pick — for players who don't want to deal with reactions at
    // all, regardless of cost.
    const disableReactions = req.query.disableReactions === "1" || req.query.disableReactions === "true";
    if (disableReactions) {
      for (const demandTypeID of demand.keys()) {
        const demandRecipe = getRecipe(demandTypeID);
        if (demandRecipe?.activityID === 11) mergedOverrides[demandTypeID] = "buy";
      }
    }

    const bom = rollUpBOM(
      typeID,
      quantity,
      demand,
      maxDepth,
      0,
      industry,
      systemId,
      facilityTax,
      prices,
      mergedOverrides,
      false,
      bestMe,
      structureMePct,
      jobFeeBonusPct,
      candidatesByType
    );
    attachBomResults(tree, bom, timeCtx);

    // Baseline for the "optimization saves you X ISK" comparison: what this
    // would cost if every buildable node were built, overrides ignored (but
    // still with the REAL ME/blueprint cost wherever one was found).
    const allBuild = rollUpBOM(
      typeID,
      quantity,
      demand,
      maxDepth,
      0,
      industry,
      systemId,
      facilityTax,
      prices,
      {},
      true,
      bestMe,
      structureMePct,
      jobFeeBonusPct,
      candidatesByType
    );

    // Every blueprint the fully-informed decision above actually uses — real
    // source, real ME/TE, real cost already folded into totalCost. Empty
    // means the decision is "buy" all the way down, which is now the
    // honest, fully-informed answer (real blueprint costs already factored
    // in), not a sign of missing data the way it used to be.
    const blueprintsNeeded = [...collectBlueprintsNeeded(tree, bom).values()].sort((a, b) => a.productName.localeCompare(b.productName));
    const totalBlueprintCost = attachBlueprintCosts(blueprintsNeeded, bom.chosenBlueprint);

    const shoppingList = [...buildShoppingList(tree, bom.decision, demand, bom.perUnitCost).values()];
    const totalMaterialsCost = shoppingList.reduce((sum, e) => sum + e.quantity * (e.unitPrice ?? 0), 0);

    // Sell = list at the current reference ask and wait — no execution-depth
    // issue, a single reference price is the right model. Quick Sell = an
    // actual INSTANT sale into existing buy orders, so — same as Quick Buy
    // on the cost side — it has to walk the buy-side book: the top bid alone
    // rarely covers a whole production batch.
    const salesTaxPct = Math.max(0, Number(req.query.salesTaxPct ?? 0));
    const brokerFeePct = Math.max(0, Number(req.query.brokerFeePct ?? 0));

    // Where to SELL the finished product — independent of the production
    // system above (job cost) and independent of materials (always Jita,
    // see esi.js). Defaults to Jita, reusing the price already fetched in
    // bulk for materials — no extra ESI call. Any other system costs one
    // extra lookup, scoped to just that system's own orders.
    const sellSystemId = Number(req.query.sellSystemId ?? JITA_SYSTEM_ID);
    let rootPrice = prices[typeID] ?? { sell: null, buy: null, sellOrders: [], buyOrders: [] };
    let sellSystemName = "Jita";
    if (sellSystemId !== JITA_SYSTEM_ID) {
      const sellSystemMeta = getSystem(sellSystemId);
      if (!sellSystemMeta) return res.status(404).json({ error: "unknown sellSystemId" });
      sellSystemName = sellSystemMeta.name;
      rootPrice = await getSystemPrices(sellSystemMeta.regionID, sellSystemId, typeID);
    }

    const revenueSell = rootPrice.sell != null ? rootPrice.sell * quantity * (1 - salesTaxPct / 100 - brokerFeePct / 100) : null;
    const quickSellWalk = walkOrderBook(rootPrice.buyOrders, quantity);
    const revenueQuickSell = quickSellWalk.unitCost === null ? null : quickSellWalk.totalCost * (1 - salesTaxPct / 100);

    res.json({
      tree,
      station: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
      // bom.rootCost already includes blueprint COPY cost where known (see
      // rollUp in bom.js) — it now feeds the build-vs-buy DECISION itself,
      // not just the total, so a blueprint too expensive to be worth buying
      // correctly tips that node to "buy" instead of silently showing
      // "build" as cheaper against a buy price that was never comparable in
      // the first place. totalBlueprintCost below is a breakdown of how much
      // of rootCost that was — do not add it again.
      totalCost: bom.rootCost,
      totalJobCost: sumJobCost(tree, bom.decision, bom.perUnitJobCost),
      totalMaterialsCost,
      totalBlueprintCost,
      allBuildCost: allBuild.rootCost,
      shoppingList,
      blueprintsNeeded,
      revenueSell,
      revenueQuickSell,
      // The RAW, pre-tax per-unit price, shown alongside the net revenue
      // above so "why is this lower than what the market window shows" never
      // comes up again: revenueSell/revenueQuickSell are already net of
      // Sales Tax + Broker's Fee, but the price you'd actually type into a
      // sell order (or see accepted) is this one.
      sellUnitPrice: rootPrice.sell,
      quickSellUnitPrice: quickSellWalk.unitCost,
      sellSystemName,
      productionSite: {
        systemId,
        facilityTax,
        structureMePct,
        jobFeeBonusPct,
        structureManufacturingDurationPct,
        structureReactionDurationPct,
        industryLevel,
        advancedIndustryLevel,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

app.get("/api/best-systems", async (req, res) => {
  try {
    const typeID = Number(req.query.typeId);
    const quantity = Math.max(1, Number(req.query.quantity ?? 1));
    const facilityTax = Math.max(0, Number(req.query.facilityTax ?? 0));
    const maxJumps = Math.min(20, Math.max(0, Number(req.query.maxJumps ?? 10)));
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 10)));
    const avoid = parseAvoidSet(req);
    if (!Number.isFinite(typeID)) return res.status(400).json({ error: "invalid typeId" });
    if (!getType(typeID)) return res.status(404).json({ error: "unknown type" });

    // Same real blueprint sourcing as /api/tree — ME/blueprint cost don't
    // depend on which system you'd build in, so this is resolved once and
    // reused for every candidate system/structure below.
    const reachable = [...discoverTypeIDs(typeID)];
    const { candidatesByType, bestMe } = await resolveRealBlueprints(reachable);
    const autoOverrides = {};
    for (const rid of reachable) {
      if (getRecipe(rid) && !candidatesByType.has(rid)) autoOverrides[rid] = "buy";
    }

    const { tree, industry, prices } = await buildPricedTree(typeID, quantity, 0, bestMe);
    const { demand, maxDepth } = computeDemand(typeID, quantity, 0, bestMe);
    const distances = jumpsFrom(JITA_SYSTEM_ID, maxJumps, avoid);

    const results = [];
    for (const [systemId, jumps] of distances) {
      if (!industry.hasData(systemId)) continue;
      const stations = getManufacturingStations(systemId);
      if (!stations.length) continue; // need a station that actually offers Manufacturing, not just any dock

      const bom = rollUpBOM(typeID, quantity, demand, maxDepth, 0, industry, systemId, facilityTax, prices, autoOverrides, false, bestMe, 0, 0, candidatesByType);
      const jobCost = sumJobCost(tree, bom.decision, bom.perUnitJobCost);
      const meta = allSystems[systemId];
      results.push({
        systemId,
        name: meta?.name ?? `#${systemId}`,
        security: meta?.security ?? null,
        jumps,
        costIndex: industry.costIndex(systemId, tree.activityID),
        totalCost: bom.rootCost,
        jobCost,
        materialsCost: bom.rootCost - jobCost,
        stations: stations.slice(0, 5).map((s) => s.name),
        structure: null,
      });
    }

    // The user's own known/corp structures — or anyone else's you can build
    // at and added by hand, ownership isn't required — are shown regardless
    // of the jump cap (it's a real, chosen option — distance is
    // informational, not a filter), each priced with its OWN facility tax
    // AND its own ME bonus (hull type — see structures.js). That
    // bonus changes how much material a job actually needs, so unlike the
    // generic systems above, demand/tree have to be recomputed per
    // structure rather than reusing the request's flat-ME ones.
    const allJumps = jumpsFrom(JITA_SYSTEM_ID, 50, avoid);
    for (const s of structures.listStructures()) {
      if (!industry.hasData(s.systemId)) continue;
      const structureMePct = structures.getStructureMePct(s);
      const jobFeeBonusPct = structures.getStructureJobFeeBonus(s);
      const sCounter = { n: 0 };
      const sTree = buildTree(typeID, quantity, 0, bestMe, structureMePct, DEFAULT_TIME_CTX, 0, new Set(), sCounter);
      attachPrices(sTree, prices);
      const { demand: sDemand, maxDepth: sMaxDepth } = computeDemand(typeID, quantity, 0, bestMe, structureMePct);
      const bom = rollUpBOM(typeID, quantity, sDemand, sMaxDepth, 0, industry, s.systemId, s.facilityTax, prices, autoOverrides, false, bestMe, structureMePct, jobFeeBonusPct, candidatesByType);
      const jobCost = sumJobCost(sTree, bom.decision, bom.perUnitJobCost);
      const meta = allSystems[s.systemId];
      results.push({
        systemId: s.systemId,
        name: s.systemName ?? meta?.name ?? `#${s.systemId}`,
        security: meta?.security ?? null,
        jumps: allJumps.get(s.systemId) ?? null,
        costIndex: industry.costIndex(s.systemId, tree.activityID),
        totalCost: bom.rootCost,
        jobCost,
        materialsCost: bom.rootCost - jobCost,
        stations: [],
        structure: { id: s.id, name: s.name, typeName: s.typeName, facilityTax: s.facilityTax, structureMePct, jobFeeBonusPct, source: s.source },
      });
    }

    // Lowest cost wins; ties (common once cost index hits its floor) are
    // broken by fewer jumps, then by higher security for easier logistics.
    const byRank = (a, b) => a.totalCost - b.totalCost || (a.jumps ?? 99) - (b.jumps ?? 99) || b.security - a.security;
    results.sort(byRank);

    // The user's own structures are always shown (so "what would MY citadel
    // cost" is never hidden by the ranking) on top of the top-`limit` general
    // candidates, even if a structure isn't itself cost-competitive.
    const topGeneral = results.filter((r) => !r.structure).slice(0, limit);
    const own = results.filter((r) => r.structure);
    const combined = [...topGeneral, ...own.filter((o) => !topGeneral.includes(o))].sort(byRank);

    res.json({ origin: "Jita", maxJumps, avoid: avoid ? [...avoid] : [], results: combined });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// Returns the actual stargate-by-stargate route to a system (default origin
// Jita), honoring the same avoid-list the best-systems scan used — lets the
// UI show *why* a candidate system is however many jumps away, and confirms
// the route doesn't quietly pass back through a system the user meant to
// route around.
app.get("/api/route", (req, res) => {
  const to = Number(req.query.to);
  const from = req.query.from !== undefined ? Number(req.query.from) : JITA_SYSTEM_ID;
  const avoid = parseAvoidSet(req);
  if (!Number.isFinite(to) || !getSystem(to)) return res.status(400).json({ error: "invalid or unknown 'to' system" });
  if (!Number.isFinite(from) || !getSystem(from)) return res.status(400).json({ error: "invalid or unknown 'from' system" });

  const path = routeBetween(from, to, 50, avoid);
  if (!path) return res.status(404).json({ error: "no route found within 50 jumps (avoided systems may be blocking it)" });

  res.json({
    jumps: path.length - 1,
    path: path.map((systemId) => {
      const meta = allSystems[systemId];
      return { systemId, name: meta?.name ?? `#${systemId}`, security: meta?.security ?? null };
    }),
  });
});

// CCP's own SDE (industryActivityProducts/Materials) carries recipe entries
// for plenty of items no player can actually walk up and manufacture — a
// real BPO/BPC for them either doesn't exist or isn't obtainable through
// ordinary industry at all, only through LP stores, NPC loot, or promotions.
// Building the profit scanner's normal "cost = materials + job, revenue =
// Jita sell" math for these produces nonsense (multi-billion "profit" on a
// Dread Guristas module or an Abyssal mutaplasmid, since either the Jita
// price is a wild, near-untraded outlier or the item was never buildable to
// begin with). typeID.metaGroupID (data/types.json, sourced from Fuzzwork's
// invMetaTypes.csv — verified live: 3 Storyline, 4 Faction, 5 Officer,
// 6 Deadspace, 15 Abyssal, 17 Premium, 19 Limited Time, 52 Structure
// Faction) is CCP's own tag for exactly this distinction. Plain Tech I/II/III
// and Structure Tech I/II (metaGroupID 1/2/14/53/54) stay in — those ARE
// ordinary player industry, invention included.
const NON_INDUSTRY_META_GROUP_IDS = new Set([3, 4, 5, 6, 15, 17, 19, 52]);

// categoryID 6 = "Ship" (verified live against Fuzzwork's invCategories.csv)
// — Upwell structures (Sotiyo, Fortizar, ...) are their own category (65),
// so this correctly excludes them from a "ships only" filter.
const SHIP_CATEGORY_ID = 6;

// A handful of ships (Praxis, Metamorphosis, Gnosis, Sunesis, InterBus
// Shuttle, Leopard — all NES/opportunity-reward ships, never built through
// ordinary industry) still carry a leftover industryActivityProducts stub in
// the SDE with a near-empty materials list (Praxis: "1 Tritanium" for an
// entire battlecruiser) — metaGroupID alone doesn't flag them, they're
// plain Tech I. Verified live: their cost/revenue ratio sits at 1e-8..3e-5,
// four full orders of magnitude below the next real item (~1e-3, Triglavian
// Condenser Packs — deliberately cheap-to-build conversion items, still a
// real recipe). No legitimate recipe in this game prices materials at under
// 0.05% of what the item sells for, so that gap is the filter.
const MIN_COST_TO_REVENUE_RATIO = 0.0005;

// How much to evaluate cost/revenue for was, for a while, scaled to the
// market's current buy-order depth (up to some cap) — the idea being to
// reward items that are both profitable AND actually sellable at scale. In
// practice that made the numbers useless for real planning: depth swings
// with whatever corp buyback/standing orders happen to exist right now (100
// units one day, 130,000 the next), so the same ship could show wildly
// different "profit" run to run for reasons that have nothing to do with
// whether it's worth building. Real industrialists think in blueprint runs,
// not order-book depth — the caller passes an explicit `quantity` instead
// (see /api/scan-products below): normally one run's worth (recipe.
// outputQuantity — 1 for a ship, 100 for common ammo, ...), or a
// user-requested number of runs times that.
function evaluateScanCandidate(productTypeID, recipe, name, quantity, prices, ctx) {
  const price = prices[productTypeID] ?? { sell: null, buy: null, sellOrders: [], buyOrders: [] };
  const sellUnit = price.sell;
  if (sellUnit === null || sellUnit === undefined) return null; // no ask price at all — can't estimate revenue

  // Informational only now (not used to size the batch) — "how much demand
  // exists right now", shown alongside the fixed-quantity numbers above.
  const sellDepth = (price.buyOrders ?? []).reduce((sum, o) => sum + o.quantity, 0);

  // defaultMe (0) never actually applies: every node either has a real
  // bestMe (a real blueprint was found for it) or is forced to "buy" in
  // ctx.overrides (none was) — see resolveRealBlueprints/autoOverrides.
  const bom = computeAggregateBOM(
    productTypeID,
    quantity,
    0,
    ctx.industry,
    ctx.systemId,
    ctx.facilityTax,
    prices,
    ctx.overrides ?? {},
    false,
    ctx.bestMe ?? new Map(),
    ctx.structureMePct,
    ctx.jobFeeBonusPct,
    ctx.candidatesByType
  );
  const cost = bom.rootCost;
  const revenueSell = sellUnit * quantity * (1 - ctx.salesTaxPct / 100 - ctx.brokerFeePct / 100);
  if (cost / revenueSell < MIN_COST_TO_REVENUE_RATIO) return null; // stub recipe, not real production — see comment below

  const quickSellWalk = walkOrderBook(price.buyOrders, quantity);
  const revenueQuickSell = quickSellWalk.unitCost === null ? null : quickSellWalk.totalCost * (1 - ctx.salesTaxPct / 100);
  const profitSell = revenueSell - cost;
  const profitQuickSell = revenueQuickSell === null ? null : revenueQuickSell - cost;
  // Ships (and other low-volume items) routinely have zero active buy
  // orders right now — that's normal; you'd list a sell order and wait, not
  // instant-sell. profitQuickSell === null must NOT mean "unsellable, hide
  // it" (it used to, and it silently dropped every ship with a thin buy
  // side — including genuinely profitable ones — from ships-only results).
  // Rank/filter on this instead: real Quick Sell profit when there's
  // depth to back it, the Sell (ask) profit otherwise.
  const rankProfit = profitQuickSell ?? profitSell;

  return {
    typeID: productTypeID,
    name,
    quantity,
    sellDepth,
    cost,
    jobCost: bom.totalJobCost,
    revenueSell,
    revenueQuickSell,
    profitSell,
    profitQuickSell,
    rankProfit,
    // Whichever real source rollUp() found cheapest for the ROOT itself
    // (own/copy/original/market — see bom.js) — always set, since a null
    // here would mean this candidate had no real blueprint at all and was
    // already filtered out before evaluateScanCandidate was ever called.
    bpc: bom.chosenBlueprint.get(productTypeID) ?? null,
  };
}

// The unified profit scan: every candidate gets the exact same treatment as
// a single /api/tree calculation — a REAL blueprint (own > contract copy >
// contract original > Forge market) with its REAL ME, or it's excluded
// entirely (nothing honest to rank it by). findCheapestBlueprintContracts/
// getForgeRegionPricesBulk scan the WHOLE region regardless of how many
// blueprintTypeIDs are asked about, so resolving this for every candidate
// here costs about the same as the old two-stage version's "refine the top
// 20" step did — there's no accuracy/speed tradeoff left to make.
app.get("/api/scan-products", async (req, res) => {
  try {
    const minProfit = req.query.minProfit !== undefined && req.query.minProfit !== "" ? Number(req.query.minProfit) : -Infinity;
    const maxProfit = req.query.maxProfit !== undefined && req.query.maxProfit !== "" ? Number(req.query.maxProfit) : Infinity;
    const limit = Math.min(300, Math.max(1, Number(req.query.limit ?? 100)));
    // 1 RUN by default (not 1 unit) — a run's own output varies wildly (1
    // ship, 100 rounds of ammo, ...), so this is runs, multiplied by each
    // candidate's own recipe.outputQuantity below to get its real quantity.
    const runs = Math.max(1, Number(req.query.runs ?? 1));
    // Sales Tax applies to every sale; Broker's Fee only to placing a sell
    // order (Quick Sell accepts an existing buy order instantly — no fee).
    const salesTaxPct = Math.max(0, Number(req.query.salesTaxPct ?? 0));
    const brokerFeePct = Math.max(0, Number(req.query.brokerFeePct ?? 0));
    const shipsOnly = req.query.shipsOnly === "1" || req.query.shipsOnly === "true";
    // Same production site a single-item calculation would use — "most
    // efficient production method" means evaluating at YOUR best structure
    // (ME/Job Fee bonus), not always a plain 0%-tax Jita NPC station.
    let systemId, facilityTax, structureMePct, jobFeeBonusPct;
    try {
      ({ systemId, facilityTax, structureMePct, jobFeeBonusPct } = resolveProductionSite(req));
    } catch (err) {
      return res.status(err.status ?? 400).json({ error: err.message });
    }

    const industry = await loadIndustryData();

    // Two different sets on purpose: shipsOnly narrows which items get
    // RANKED as scan results, but a ship's own sub-materials (armor plates,
    // components, ...) are almost never ships themselves — resolving
    // blueprints only for the ships-only set left every non-ship
    // sub-material with no meOverride, silently forcing it to "buy" instead
    // of letting the real build-vs-buy decision run, and made costs here
    // disagree with the exact same item's /api/tree cost (verified live:
    // Stork scanned at 40.2M with shipsOnly on, but /api/tree said 45.9M for
    // the same ME3 copy — the 5.7M gap was Titanium Diborite Armor Plate
    // getting force-bought instead of built at its own real ME10 copy).
    // resolveTypeIDs is the FULL metaGroup-filtered universe regardless of
    // shipsOnly, so every candidate's tree is priced identically here and in
    // /api/tree.
    const resolveTypeIDs = [];
    for (const productTypeIdStr of Object.keys(blueprints)) {
      const productTypeID = Number(productTypeIdStr);
      const recipe = getRecipe(productTypeID);
      if (!recipe) continue;
      const type = getType(productTypeID);
      if (type && NON_INDUSTRY_META_GROUP_IDS.has(type.metaGroupID)) continue;
      resolveTypeIDs.push(productTypeID);
    }

    // Steps 1+2 for every resolvable item at once — doubles as the "does a
    // real blueprint even exist" filter AND as the per-node ME/cost source
    // for whatever sub-materials happen to also be buildable products.
    const { candidatesByType, bestMe } = await resolveRealBlueprints(resolveTypeIDs);
    const autoOverrides = {};
    for (const id of resolveTypeIDs) {
      if (!candidatesByType.has(id)) autoOverrides[id] = "buy"; // no real blueprint anywhere — can't honestly build it
    }

    const products = resolveTypeIDs
      .filter((id) => candidatesByType.has(id))
      .filter((id) => !shipsOnly || getType(id)?.categoryID === SHIP_CATEGORY_ID)
      .map((id) => ({ typeID: id, name: getType(id)?.name ?? `#${id}`, recipe: getRecipe(id) }));

    const allIds = new Set();
    for (const p of products) discoverTypeIDs(p.typeID, allIds);
    const prices = await getJitaPricesBulk([...allIds], 16);

    const ctx = {
      industry,
      systemId,
      facilityTax,
      structureMePct,
      jobFeeBonusPct,
      salesTaxPct,
      brokerFeePct,
      candidatesByType,
      bestMe,
      overrides: autoOverrides,
    };

    const results = [];
    for (const product of products) {
      const quantity = runs * product.recipe.outputQuantity;
      const r = evaluateScanCandidate(product.typeID, product.recipe, product.name, quantity, prices, ctx);
      if (!r) continue;
      if (r.rankProfit < minProfit || r.rankProfit > maxProfit) continue;
      results.push(r);
    }

    results.sort((a, b) => b.rankProfit - a.rankProfit);

    res.json({ scanned: products.length, matched: results.length, results: results.slice(0, limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`EVE production calculator running at http://${HOST}:${PORT}`);
});
// The full-catalog scan can take several minutes on a cold cache — don't let
// Node's default request/idle timeouts kill it partway through.
server.requestTimeout = 20 * 60 * 1000;
server.headersTimeout = 20 * 60 * 1000 + 1000;
server.timeout = 0;
