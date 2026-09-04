// Live market price lookups against EVE's ESI. Materials are always priced
// at Jita IV - Moon 4 (station 60003760, The Forge region 10000002) — that's
// this tool's whole premise, see README. getSystemPrices() is the one
// exception: it prices an arbitrary solar system, used only for "where to
// sell the finished product" (revenue), never for material costing.
const JITA_REGION_ID = 10000002; // The Forge
const JITA_STATION_ID = 60003760; // Jita IV - Moon 4 - Caldari Navy Assembly Plant
const CACHE_TTL_MS = 5 * 60 * 1000;

const regionOrderCache = new Map(); // `${regionId}:${typeID}` -> { expires, orders }

async function fetchAllPages(regionId, typeID) {
  const orders = [];
  let page = 1;
  let totalPages = 1;
  do {
    const url = `https://esi.evetech.net/latest/markets/${regionId}/orders/?datasource=tranquility&order_type=all&page=${page}&type_id=${typeID}`;
    const res = await fetch(url, { headers: { "User-Agent": "eve-production-calc (local private tool)" } });
    if (!res.ok) {
      if (res.status === 404) break; // no orders for this type at all
      throw new Error(`ESI error ${res.status} for type ${typeID}`);
    }
    const body = await res.json();
    orders.push(...body);
    totalPages = Number(res.headers.get("x-pages") ?? "1");
    page += 1;
  } while (page <= totalPages);
  return orders;
}

// All orders for typeID across an entire REGION (unfiltered by station/
// system) — callers narrow down from here by location_id or system_id.
// Cached per region+typeID so a station-scoped and a system-scoped lookup
// for the same region/typeID share one ESI fetch.
async function getRegionOrders(regionId, typeID) {
  const key = `${regionId}:${typeID}`;
  const cached = regionOrderCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.orders;

  const orders = await fetchAllPages(regionId, typeID);
  regionOrderCache.set(key, { expires: Date.now() + CACHE_TTL_MS, orders });
  return orders;
}

// { sell, buy, sellOrders, buyOrders }. sell/buy are the single best price
// (lowest ask / highest bid) — handy as a display reference price.
// sellOrders/buyOrders are the FULL order book, best-price-first, as
// {price, quantity} tiers — needed because a single "cheapest ask" price
// badly misprices any quantity beyond what that one order actually holds.
function summarizeOrders(orders) {
  const sellOrders = orders
    .filter((o) => !o.is_buy_order)
    .sort((a, b) => a.price - b.price)
    .map((o) => ({ price: o.price, quantity: o.volume_remain }));
  const buyOrders = orders
    .filter((o) => o.is_buy_order)
    .sort((a, b) => b.price - a.price)
    .map((o) => ({ price: o.price, quantity: o.volume_remain }));
  return {
    sell: sellOrders[0]?.price ?? null,
    buy: buyOrders[0]?.price ?? null,
    sellOrders,
    buyOrders,
  };
}

// EVE order books are often thin at the top: e.g. the lowest ask might cover
// only a few hundred units while a BOM needs hundreds of thousands, so the
// realistic cost has to walk down through many tiers at rising prices (this
// is exactly what real appraisal tools like Goonpraisal do, and why a flat
// price × quantity can understate a bulk purchase by 30-50%+). Restricted to
// Jita 4-4 station orders only, per this tool's scope for materials.
export async function getJitaPrices(typeID) {
  const orders = await getRegionOrders(JITA_REGION_ID, typeID);
  const stationOrders = orders.filter((o) => o.location_id === JITA_STATION_ID);
  return summarizeOrders(stationOrders);
}

// Same shape as getJitaPrices, but for an arbitrary solar system — used only
// for "where to sell the finished product" (revenue side). Aggregated
// across every station IN the system rather than one specific station:
// unlike Jita 4-4 (a well-known, universally-used trade hub), an arbitrary
// system has no single "the" station to assume, and ESI order objects carry
// system_id directly so this needs no station list at all.
export async function getSystemPrices(regionId, systemId, typeID) {
  const orders = await getRegionOrders(regionId, typeID);
  const systemOrders = orders.filter((o) => o.system_id === systemId);
  return summarizeOrders(systemOrders);
}

// Walks a best-price-first order book (ascending for buying against sell
// orders, descending for selling into buy orders) to find the TRUE cost/
// revenue of trading `qty` units, instead of assuming the whole quantity
// trades at the single best price. Once the book itself is exhausted (real
// depth ran out), the remainder is priced at the last tier's price as a
// conservative estimate — better than silently pretending it doesn't exist.
export function walkOrderBook(tiers, qty) {
  if (!tiers || !tiers.length || !(qty > 0)) return { totalCost: 0, unitCost: null, exhausted: !tiers?.length };
  let remaining = qty;
  let total = 0;
  let lastPrice = tiers[tiers.length - 1].price;
  for (const tier of tiers) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, tier.quantity);
    total += take * tier.price;
    remaining -= take;
    lastPrice = tier.price;
  }
  const exhausted = remaining > 0;
  if (exhausted) total += remaining * lastPrice;
  return { totalCost: total, unitCost: total / qty, exhausted };
}

// Returns the top N sell (ascending) and buy (descending) orders at Jita 4-4,
// shaped like EVE's own market order book: { sell: [{price, quantity}], buy: [...] }
export async function getOrderBook(typeID, limit = 5) {
  const orders = await getRegionOrders(JITA_REGION_ID, typeID);
  const stationOrders = orders.filter((o) => o.location_id === JITA_STATION_ID);
  const sell = stationOrders
    .filter((o) => !o.is_buy_order)
    .sort((a, b) => a.price - b.price)
    .slice(0, limit)
    .map((o) => ({ price: o.price, quantity: o.volume_remain }));
  const buy = stationOrders
    .filter((o) => o.is_buy_order)
    .sort((a, b) => b.price - a.price)
    .slice(0, limit)
    .map((o) => ({ price: o.price, quantity: o.volume_remain }));
  return { sell, buy };
}

export async function getJitaPricesBulk(typeIDs, concurrency = 8) {
  const unique = [...new Set(typeIDs)];
  const results = {};
  const CONCURRENCY = concurrency;
  let i = 0;
  async function worker() {
    while (i < unique.length) {
      const idx = i++;
      const typeID = unique[idx];
      try {
        results[typeID] = await getJitaPrices(typeID);
      } catch (err) {
        results[typeID] = { sell: null, buy: null, error: String(err.message ?? err) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
  return results;
}
