import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchTypes, getType, getRecipe, getProductForBlueprint, browseGroup, searchSystems, jumpsFrom, routeBetween, getManufacturingStations, systems as allSystems, getSystem, getTypeIdByName, blueprints } from "./sde.js";
import { getJitaPricesBulk, getOrderBook, walkOrderBook, getSystemPrices } from "./esi.js";
import { createAppraisalLink } from "./goonpraisal.js";
import { loadIndustryData } from "./industry.js";
import { computeAggregateBOM, computeDemand, rollUpBOM, discoverTypeIDs, buildShoppingList } from "./bom.js";
import * as oauth from "./oauth.js";
import * as structures from "./structures.js";
import { getTaxRates } from "./character.js";
import { getLpOffers, LP_CORPS } from "./lpstore.js";

const JITA_SYSTEM_ID = 30000142;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT ?? 3099;
const HOST = "127.0.0.1"; // localhost only — this is what makes the tool private

app.use(express.static(path.join(__dirname, "..", "public")));
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

app.get("/api/character/tax-rates", async (req, res) => {
  try {
    res.json(await getTaxRates());
  } catch (err) {
    res.status(400).json({ error: String(err.message ?? err) });
  }
});

// ---- known structures (manual + synced from corp) ----

app.get("/api/structures", (req, res) => {
  res.json(structures.listStructures());
});

app.post("/api/structures", (req, res) => {
  try {
    const { name, systemId, typeName, facilityTax } = req.body ?? {};
    if (!name || !systemId) return res.status(400).json({ error: "name и systemId обязательны" });
    const systemMeta = getSystem(Number(systemId));
    if (!systemMeta) return res.status(400).json({ error: "неизвестная система" });
    const entry = structures.addManualStructure({
      name,
      systemId: Number(systemId),
      systemName: systemMeta.name,
      typeId: typeName ? getTypeIdByName(typeName) : null,
      typeName: typeName ?? null,
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
function buildTree(typeID, quantity, me, depth, path, counter) {
  counter.n += 1;
  const type = getType(typeID);
  const name = type ? type.name : `#${typeID}`;
  const recipe = getRecipe(typeID);
  const buildable = Boolean(recipe) && depth < MAX_DEPTH && counter.n < MAX_NODES && !path.has(typeID);

  const node = { typeID, name, quantity, buildable };

  if (buildable) {
    const runs = Math.ceil(quantity / recipe.outputQuantity);
    const nextPath = new Set(path);
    nextPath.add(typeID);
    node.runs = runs;
    node.outputQuantity = recipe.outputQuantity;
    node.timePerRun = recipe.time;
    node.activityID = recipe.activityID;
    node.materials = recipe.materials.map((m) => {
      const matQty = Math.max(1, Math.ceil(m.quantity * runs * (1 - me / 100)));
      return buildTree(m.typeID, matQty, me, depth + 1, nextPath, counter);
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
function attachBomResults(node, bom) {
  node.decision = bom.decision.get(node.typeID) ?? "market";
  node.unitCost = bom.perUnitCost.get(node.typeID) ?? 0;
  if (node.buildable) {
    node.jobCost = (bom.perUnitJobCost.get(node.typeID) ?? 0) * node.quantity;
    for (const m of node.materials) attachBomResults(m, bom);
  }
}

async function buildPricedTree(typeID, quantity, me) {
  const industry = await loadIndustryData();
  const counter = { n: 0 };
  const tree = buildTree(typeID, quantity, me, 0, new Set(), counter);

  const ids = new Set();
  collectTypeIDs(tree, ids);
  const prices = await getJitaPricesBulk([...ids]);
  attachPrices(tree, prices);

  return { tree, industry, prices };
}

function parseTreeParams(req) {
  const typeID = Number(req.query.typeId);
  const quantity = Math.max(1, Number(req.query.quantity ?? 1));
  const me = Math.min(10, Math.max(0, Number(req.query.me ?? 0)));
  const facilityTax = Math.max(0, Number(req.query.facilityTax ?? 0));
  return { typeID, quantity, me, facilityTax };
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
    const { typeID, quantity, me, facilityTax } = parseTreeParams(req);
    const systemId = Number(req.query.systemId ?? JITA_SYSTEM_ID);
    if (!Number.isFinite(typeID)) return res.status(400).json({ error: "invalid typeId" });
    if (!getType(typeID)) return res.status(404).json({ error: "unknown type" });

    let overrides = {};
    if (req.query.overrides) {
      try {
        overrides = JSON.parse(req.query.overrides);
      } catch {
        return res.status(400).json({ error: "invalid overrides JSON" });
      }
    }

    const { tree, industry, prices } = await buildPricedTree(typeID, quantity, me);
    const { demand, maxDepth } = computeDemand(typeID, quantity, me);
    const bom = rollUpBOM(typeID, quantity, demand, maxDepth, me, industry, systemId, facilityTax, prices, overrides);
    attachBomResults(tree, bom);

    // Baseline for the "optimization saves you X ISK" comparison: what this
    // would cost if every buildable node were built, overrides ignored.
    const allBuild = rollUpBOM(typeID, quantity, demand, maxDepth, me, industry, systemId, facilityTax, prices, {}, true);

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
      totalCost: bom.rootCost,
      totalJobCost: bom.totalJobCost,
      totalMaterialsCost,
      allBuildCost: allBuild.rootCost,
      shoppingList,
      revenueSell,
      revenueQuickSell,
      sellSystemName,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

app.get("/api/best-systems", async (req, res) => {
  try {
    const { typeID, quantity, me, facilityTax } = parseTreeParams(req);
    const maxJumps = Math.min(20, Math.max(0, Number(req.query.maxJumps ?? 10)));
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 10)));
    const avoid = parseAvoidSet(req);
    if (!Number.isFinite(typeID)) return res.status(400).json({ error: "invalid typeId" });
    if (!getType(typeID)) return res.status(404).json({ error: "unknown type" });

    const { tree, industry, prices } = await buildPricedTree(typeID, quantity, me);
    const { demand, maxDepth } = computeDemand(typeID, quantity, me);
    const distances = jumpsFrom(JITA_SYSTEM_ID, maxJumps, avoid);

    const results = [];
    for (const [systemId, jumps] of distances) {
      if (!industry.hasData(systemId)) continue;
      const stations = getManufacturingStations(systemId);
      if (!stations.length) continue; // need a station that actually offers Manufacturing, not just any dock

      const bom = rollUpBOM(typeID, quantity, demand, maxDepth, me, industry, systemId, facilityTax, prices);
      const meta = allSystems[systemId];
      results.push({
        systemId,
        name: meta?.name ?? `#${systemId}`,
        security: meta?.security ?? null,
        jumps,
        costIndex: industry.costIndex(systemId, tree.activityID),
        totalCost: bom.rootCost,
        jobCost: bom.totalJobCost,
        materialsCost: bom.rootCost - bom.totalJobCost,
        stations: stations.slice(0, 5).map((s) => s.name),
        structure: null,
      });
    }

    // The user's own known/corp structures are shown regardless of the jump
    // cap (it's their structure — distance is informational, not a filter),
    // each priced with ITS OWN facility tax rather than the request's one.
    const allJumps = jumpsFrom(JITA_SYSTEM_ID, 50, avoid);
    for (const s of structures.listStructures()) {
      if (!industry.hasData(s.systemId)) continue;
      const bom = rollUpBOM(typeID, quantity, demand, maxDepth, me, industry, s.systemId, s.facilityTax, prices);
      const meta = allSystems[s.systemId];
      results.push({
        systemId: s.systemId,
        name: s.systemName ?? meta?.name ?? `#${s.systemId}`,
        security: meta?.security ?? null,
        jumps: allJumps.get(s.systemId) ?? null,
        costIndex: industry.costIndex(s.systemId, tree.activityID),
        totalCost: bom.rootCost,
        jobCost: bom.totalJobCost,
        materialsCost: bom.rootCost - bom.totalJobCost,
        stations: [],
        structure: { id: s.id, name: s.name, typeName: s.typeName, facilityTax: s.facilityTax, source: s.source },
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

// Scans every buildable product in the game (one blueprint run each, i.e.
// its natural output batch) and returns the ones whose profit (Sell revenue
// minus optimal build/buy cost, at Jita, 0% facility tax) falls inside the
// requested range. This is a genuinely heavy operation — thousands of ESI
// price lookups on a cold cache — but getJitaPricesBulk caches per-typeID
// for 5 minutes, so repeat scans (even with a different profit range) are
// fast once warmed up.
app.get("/api/scan-products", async (req, res) => {
  try {
    const me = Math.min(10, Math.max(0, Number(req.query.me ?? 10)));
    const minProfit = req.query.minProfit !== undefined && req.query.minProfit !== "" ? Number(req.query.minProfit) : -Infinity;
    const maxProfit = req.query.maxProfit !== undefined && req.query.maxProfit !== "" ? Number(req.query.maxProfit) : Infinity;
    const limit = Math.min(300, Math.max(1, Number(req.query.limit ?? 100)));
    // Sales Tax applies to every sale; Broker's Fee only to placing a sell
    // order (Quick Sell accepts an existing buy order instantly — no fee).
    const salesTaxPct = Math.max(0, Number(req.query.salesTaxPct ?? 0));
    const brokerFeePct = Math.max(0, Number(req.query.brokerFeePct ?? 0));

    const industry = await loadIndustryData();

    const products = []; // { typeID, name, quantity }
    const allIds = new Set();
    for (const productTypeIdStr of Object.keys(blueprints)) {
      const productTypeID = Number(productTypeIdStr);
      const recipe = getRecipe(productTypeID);
      if (!recipe) continue;
      const type = getType(productTypeID);
      products.push({ typeID: productTypeID, name: type ? type.name : `#${productTypeID}`, quantity: recipe.outputQuantity });
      discoverTypeIDs(productTypeID, allIds);
    }

    const prices = await getJitaPricesBulk([...allIds], 16);

    const results = [];
    for (const product of products) {
      const price = prices[product.typeID] ?? { sell: null, buy: null, buyOrders: [] };
      const sellUnit = price.sell;
      if (sellUnit === null || sellUnit === undefined) continue; // no ask price at all — can't estimate revenue

      const bom = computeAggregateBOM(product.typeID, product.quantity, me, industry, JITA_SYSTEM_ID, 0, prices);
      const cost = bom.rootCost;
      // revenueSell prices at the reference ask (you'd list at/near it and
      // wait to sell — no execution-depth issue). revenueQuickSell is a real
      // INSTANT sale into existing buy orders, so it has to walk the buy-side
      // book the same way Quick Buy walks the sell side — the top bid alone
      // rarely covers a whole production batch.
      const revenueSell = sellUnit * product.quantity * (1 - salesTaxPct / 100 - brokerFeePct / 100);
      const quickSellWalk = walkOrderBook(price.buyOrders, product.quantity);
      const revenueQuickSell = quickSellWalk.unitCost === null ? null : quickSellWalk.totalCost * (1 - salesTaxPct / 100);
      const profitSell = revenueSell - cost;
      const profitQuickSell = revenueQuickSell === null ? null : revenueQuickSell - cost;

      if (profitSell < minProfit || profitSell > maxProfit) continue;

      results.push({
        typeID: product.typeID,
        name: product.name,
        quantity: product.quantity,
        cost,
        jobCost: bom.totalJobCost,
        revenueSell,
        revenueQuickSell,
        profitSell,
        profitQuickSell,
      });
    }

    results.sort((a, b) => b.profitSell - a.profitSell);

    res.json({ scanned: products.length, matched: results.length, results: results.slice(0, limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// Prices every offer in the requested NPC corp LP stores (Guristas / State
// Protectorate, per LP_CORPS) so you can see which ones are actually worth
// redeeming: reward value minus ISK cost minus any required hand-in items,
// as both flat ISK profit and ISK-per-LP (the metric that matters for
// comparing offers, since LP itself has no fixed ISK price — treat it as
// free once earned). Offer rewards that are themselves BLUEPRINTS (no
// market orders exist for those) are priced via the existing BOM engine
// instead — one build run's worth, at the given ME. ESI's offer data
// doesn't say how many runs an LP blueprint copy actually has, so this is
// deliberately conservative: value of ONE run, not the whole copy.
app.get("/api/lp-offers", async (req, res) => {
  try {
    const me = Math.min(10, Math.max(0, Number(req.query.me ?? 0)));
    const requestedKeys = req.query.corp ? String(req.query.corp).split(",") : LP_CORPS.map((c) => c.key);
    const corps = LP_CORPS.filter((c) => requestedKeys.includes(c.key));
    if (!corps.length) return res.status(400).json({ error: "unknown corp" });

    const industry = await loadIndustryData();

    const entries = []; // { corpName, offer, productTypeId }
    const allIds = new Set();
    for (const corp of corps) {
      const offers = await getLpOffers(corp.corporationId);
      for (const offer of offers) {
        const productTypeId = getProductForBlueprint(offer.type_id);
        entries.push({ corpName: corp.name, offer, productTypeId });
        if (productTypeId) discoverTypeIDs(productTypeId, allIds);
        else allIds.add(offer.type_id);
        for (const ri of offer.required_items) allIds.add(ri.type_id);
      }
    }

    const prices = await getJitaPricesBulk([...allIds], 16);

    const results = [];
    for (const { corpName, offer, productTypeId } of entries) {
      // Items you hand in alongside ISK/LP — priced as an instant buy
      // (walked sell-order book), same convention as material costing.
      let requiredItemsCost = 0;
      let requiredItemsKnown = true;
      const requiredItems = offer.required_items.map((ri) => {
        const p = prices[ri.type_id] ?? { sellOrders: [] };
        const walk = walkOrderBook(p.sellOrders, ri.quantity);
        if (walk.unitCost === null) requiredItemsKnown = false;
        else requiredItemsCost += walk.totalCost;
        const type = getType(ri.type_id);
        return { typeID: ri.type_id, name: type ? type.name : `#${ri.type_id}`, quantity: ri.quantity };
      });

      let itemValue = null;
      let isBlueprint = false;
      let productName = null;
      let buildCost = null;
      let runQuantity = null;

      if (productTypeId) {
        isBlueprint = true;
        const recipe = getRecipe(productTypeId);
        const productType = getType(productTypeId);
        productName = productType ? productType.name : `#${productTypeId}`;
        if (recipe) {
          runQuantity = recipe.outputQuantity;
          const bom = computeAggregateBOM(productTypeId, runQuantity, me, industry, JITA_SYSTEM_ID, 0, prices);
          buildCost = bom.rootCost;
          const p = prices[productTypeId];
          if (p?.sell != null) itemValue = p.sell * runQuantity;
        }
      } else {
        const p = prices[offer.type_id];
        if (p?.sell != null) itemValue = p.sell * offer.quantity;
      }

      if (itemValue === null || !requiredItemsKnown) continue; // can't price this offer — skip rather than show a misleading number

      const rewardType = getType(offer.type_id);
      const totalCost = offer.isk_cost + requiredItemsCost + (buildCost ?? 0);
      const netProfit = itemValue - totalCost;
      const iskPerLp = offer.lp_cost > 0 ? netProfit / offer.lp_cost : null;

      results.push({
        offerId: offer.offer_id,
        corp: corpName,
        typeID: offer.type_id,
        name: rewardType ? rewardType.name : `#${offer.type_id}`,
        quantity: offer.quantity,
        iskCost: offer.isk_cost,
        lpCost: offer.lp_cost,
        requiredItems,
        requiredItemsCost,
        isBlueprint,
        productTypeId,
        productName,
        runQuantity,
        buildCost,
        itemValue,
        totalCost,
        netProfit,
        iskPerLp,
      });
    }

    results.sort((a, b) => (b.iskPerLp ?? -Infinity) - (a.iskPerLp ?? -Infinity));

    res.json({ scanned: entries.length, priced: results.length, results });
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
