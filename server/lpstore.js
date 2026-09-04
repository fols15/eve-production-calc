// Public NPC corporation Loyalty Point store offers. ESI's
// /loyalty/stores/ endpoint needs no auth — LP store contents are public
// knowledge, only a character's LP *balance* is private. Used to answer
// "which of these offers are actually worth redeeming": reward value minus
// ISK cost minus any required hand-in items, both as flat ISK profit and as
// ISK-per-LP (the metric that actually matters for comparing offers, since
// LP itself has no fixed ISK price — its real cost is the missions/time
// spent earning it, not something this tool can price).
const CACHE_TTL_MS = 60 * 60 * 1000; // offer lists only change on game patches

// corporationId resolved via ESI's /universe/ids/ name search.
export const LP_CORPS = [
  { key: "guristas", name: "Guristas", corporationId: 1000127 },
  { key: "state_protectorate", name: "State Protectorate", corporationId: 1000180 },
];

const cache = new Map(); // corporationId -> { expires, offers }

export async function getLpOffers(corporationId) {
  const cached = cache.get(corporationId);
  if (cached && cached.expires > Date.now()) return cached.offers;

  const res = await fetch(`https://esi.evetech.net/latest/loyalty/stores/${corporationId}/offers/?datasource=tranquility`, {
    headers: { "User-Agent": "eve-production-calc (local private tool)" },
  });
  if (!res.ok) throw new Error(`ESI error ${res.status} for LP store ${corporationId}`);
  const offers = await res.json();
  cache.set(corporationId, { expires: Date.now() + CACHE_TTL_MS, offers });
  return offers;
}
