// Computes the logged-in character's real Sales Tax and Broker's Fee at
// Jita 4-4 (an NPC station) from their Accounting/Broker Relations skills
// and their standing toward the station's owner. Formulas per CCP (patch
// 22.02, March 2025) and the long-standing broker fee mechanic:
//   Sales Tax %  = 7.5% * (1 - 0.11 * AccountingLevel)
//   Broker Fee % = 3%  - 0.3%*BrokerRelationsLevel - 0.03%*factionStanding - 0.02%*corpStanding
import { getValidAccessToken, getAuth } from "./oauth.js";
import { getTypeIdByName } from "./sde.js";

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
  const accountingLevel = skills.find((s) => s.skill_id === accountingTypeID)?.active_skill_level ?? 0;
  const brokerRelationsLevel = skills.find((s) => s.skill_id === brokerRelationsTypeID)?.active_skill_level ?? 0;

  const factionStanding = standings.find((s) => s.from_id === JITA_44_OWNER_FACTION_ID)?.standing ?? 0;
  const corpStanding = standings.find((s) => s.from_id === JITA_44_OWNER_CORP_ID)?.standing ?? 0;

  const salesTaxPct = clamp(7.5 * (1 - 0.11 * accountingLevel), 0, 7.5);
  const brokerFeePct = clamp(3 - 0.3 * brokerRelationsLevel - 0.03 * factionStanding - 0.02 * corpStanding, 0, 3);

  return {
    accountingLevel,
    brokerRelationsLevel,
    factionStanding,
    corpStanding,
    salesTaxPct,
    brokerFeePct,
  };
}
