// Computes the logged-in character's real Sales Tax and Broker's Fee at
// Jita 4-4 (an NPC station) from their Accounting/Broker Relations skills
// and their standing toward the station's owner. Formulas per CCP (patch
// 22.02, March 2025) and the long-standing broker fee mechanic:
//   Sales Tax %  = 7.5% * (1 - 0.11 * AccountingLevel)
//   Broker Fee % = 3%  - 0.3%*BrokerRelationsLevel - 0.03%*factionStanding - 0.02%*corpStanding
import { getValidAccessToken, getAuth } from "./oauth.js";
import { getTypeIdByName, getProductForBlueprint, getType } from "./sde.js";

// Jita IV - Moon 4 - Caldari Navy Assembly Plant is owned by the "Caldari
// Navy" NPC corporation (1000035), which belongs to the Caldari State
// faction (500001) — confirmed live via ESI (/universe/stations/60003760/)
// and the SDE (crpNPCCorporations). Fixed because the site only ever prices
// off this one station.
const JITA_44_OWNER_CORP_ID = 1000035;
const JITA_44_OWNER_FACTION_ID = 500001;

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export async function getTaxRates() {
  const auth = getAuth();
  if (!auth) throw new Error("не выполнен вход через EVE SSO");

  const token = await getValidAccessToken();
  const headers = { Authorization: `Bearer ${token}` };

  const [skillsRes, standingsRes] = await Promise.all([
    fetch(`https://esi.evetech.net/latest/characters/${auth.characterId}/skills/?datasource=tranquility`, { headers }),
    fetch(`https://esi.evetech.net/latest/characters/${auth.characterId}/standings/?datasource=tranquility`, { headers }),
  ]);
  if (!skillsRes.ok) throw new Error(`ESI skills error ${skillsRes.status} (нужен scope esi-skills.read_skills.v1 — перелогиньтесь через EVE SSO)`);
  if (!standingsRes.ok) throw new Error(`ESI standings error ${standingsRes.status} (нужен scope esi-characters.read_standings.v1 — перелогиньтесь через EVE SSO)`);

  const skills = (await skillsRes.json()).skills ?? [];
  const standings = await standingsRes.json();

  const accountingTypeID = getTypeIdByName("Accounting");
  const brokerRelationsTypeID = getTypeIdByName("Broker Relations");
  const industryTypeID = getTypeIdByName("Industry");
  const advancedIndustryTypeID = getTypeIdByName("Advanced Industry");
  const accountingLevel = skills.find((s) => s.skill_id === accountingTypeID)?.active_skill_level ?? 0;
  const brokerRelationsLevel = skills.find((s) => s.skill_id === brokerRelationsTypeID)?.active_skill_level ?? 0;
  // Confirmed live via ESI dogma (GET /universe/types/{id}/): Industry's
  // effect 412/425 and Advanced Industry's effect 5903/5908 both scale
  // attribute 219 (manufactureTimeMultiplier) by -4%/level and -3%/level of
  // skillLevel respectively — Advanced Industry also touches copying/
  // invention/ME-TE-research speed (not modeled here, this tool only prices
  // Manufacturing + Reaction jobs) but NOT the reaction time attribute, so
  // neither skill reduces Reaction job duration — see bom.js.
  const industryLevel = skills.find((s) => s.skill_id === industryTypeID)?.active_skill_level ?? 0;
  const advancedIndustryLevel = skills.find((s) => s.skill_id === advancedIndustryTypeID)?.active_skill_level ?? 0;

  const factionStanding = standings.find((s) => s.from_id === JITA_44_OWNER_FACTION_ID)?.standing ?? 0;
  const corpStanding = standings.find((s) => s.from_id === JITA_44_OWNER_CORP_ID)?.standing ?? 0;

  const salesTaxPct = clamp(7.5 * (1 - 0.11 * accountingLevel), 0, 7.5);
  // CCP documents a hard floor of 1% even at Broker Relations V + max standings.
  const brokerFeePct = clamp(3 - 0.3 * brokerRelationsLevel - 0.03 * factionStanding - 0.02 * corpStanding, 1, 3);

  return {
    accountingLevel,
    brokerRelationsLevel,
    industryLevel,
    advancedIndustryLevel,
    factionStanding,
    corpStanding,
    salesTaxPct,
    brokerFeePct,
  };
}

// Blueprint ORIGINALS the character owns (anywhere — this endpoint doesn't
// filter by location) never need to be bought again: unlike a copy (BPC,
// consumed run-by-run), an original is reused indefinitely, so a BOM never
// has to charge for it more than once — never mind "once per calculation".
// ESI's own quantity field is exactly this distinction: -1 (a single
// original) or a positive number (a stack of originals fresh off the
// market) means original; -2 means copy — copies are deliberately excluded
// here, the caller should keep pricing those from contracts as before.
// Keyed by PRODUCT typeID (not the blueprint's own typeID) to match
// meOverrides/teOverrides/blueprintPrices elsewhere. If the character owns
// more than one original of the same blueprint at different ME/TE (e.g.
// bought a second one instead of researching further), the best ME (ties
// broken by best TE) wins, since that's the one a rational builder would use.
export async function getOwnedBlueprints() {
  const auth = getAuth();
  if (!auth) throw new Error("не выполнен вход через EVE SSO");

  const token = await getValidAccessToken();
  const headers = { Authorization: `Bearer ${token}` };

  const res = await fetch(`https://esi.evetech.net/latest/characters/${auth.characterId}/blueprints/?datasource=tranquility`, { headers });
  if (!res.ok) throw new Error(`ESI blueprints error ${res.status} (нужен scope esi-characters.read_blueprints.v1 — перелогиньтесь через EVE SSO)`);
  const rows = await res.json();

  const byProduct = new Map();
  for (const row of rows) {
    if (row.quantity === -2) continue; // a copy, not an original — not modeled here
    const productTypeID = getProductForBlueprint(row.type_id);
    if (!productTypeID) continue; // not a manufacturing/reaction blueprint this tool knows about

    const existing = byProduct.get(productTypeID);
    if (existing && (existing.me > row.material_efficiency || (existing.me === row.material_efficiency && existing.te >= row.time_efficiency))) {
      continue; // already have a same-or-better one recorded
    }
    const blueprintType = getType(row.type_id);
    const productType = getType(productTypeID);
    byProduct.set(productTypeID, {
      productTypeID,
      productName: productType ? productType.name : `#${productTypeID}`,
      blueprintTypeID: row.type_id,
      blueprintName: blueprintType ? blueprintType.name : `#${row.type_id}`,
      me: row.material_efficiency,
      te: row.time_efficiency,
    });
  }
  return [...byProduct.values()];
}
