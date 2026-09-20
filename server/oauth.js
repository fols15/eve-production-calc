// EVE SSO (OAuth2 authorization code flow) — lets the tool ask ESI for
// structures belonging to the logged-in character's own corporation
// (Raitaru/Azbel/Sotiyo/etc.), which is the one part of "find nearby
// citadels" that ESI actually supports without the user typing anything in.
// Docs: https://developers.eveonline.com/docs/services/sso/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DIR = path.join(__dirname, "..", "data", "user");
const CONFIG_FILE = path.join(USER_DIR, "oauth-config.json");
const AUTH_FILE = path.join(USER_DIR, "auth.json");

export const REDIRECT_URI = "http://localhost:3099/auth/callback";
export const SCOPES = [
  "esi-corporations.read_structures.v1",
  "esi-universe.read_structures.v1",
  "esi-skills.read_skills.v1",
  "esi-characters.read_standings.v1",
  // Lets the character look up a THIRD-PARTY structure by name (ESI's
  // GET /characters/{id}/search/, category "structure") — the only way to
  // resolve one you don't own into a real structure_id/system/type, since
  // CCP doesn't expose a "list structures in this system" endpoint at all
  // (unlike NPC stations, which are public). See structures.js/searchStructuresByName.
  "esi-search.search_structures.v1",
  // Character's OWNED blueprints (GET /characters/{id}/blueprints/) — lets
  // the calc skip charging for a blueprint copy the character already owns
  // as an ORIGINAL (infinitely reusable, quantity -1 or a positive stack —
  // see character.js/getOwnedBlueprints) and use its real ME/TE instead of
  // guessing from a contract-bought copy.
  "esi-characters.read_blueprints.v1",
];

let pendingState = null;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function getConfig() {
  return readJson(CONFIG_FILE); // { clientId, clientSecret } | null
}

export function saveConfig(clientId, clientSecret) {
  writeJson(CONFIG_FILE, { clientId, clientSecret });
}

export function getAuth() {
  return readJson(AUTH_FILE); // { characterId, characterName, corporationId, accessToken, refreshToken, expiresAt } | null
}

export function clearAuth() {
  try {
    fs.unlinkSync(AUTH_FILE);
  } catch {
    // already logged out
  }
}

export function buildLoginUrl() {
  const config = getConfig();
  if (!config) throw new Error("EVE SSO не настроен: сначала сохраните Client ID и Client Secret");

  pendingState = randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    client_id: config.clientId,
    scope: SCOPES.join(" "),
    state: pendingState,
  });
  return `https://login.eveonline.com/v2/oauth/authorize?${params.toString()}`;
}

function decodeJwtPayload(jwt) {
  const payload = jwt.split(".")[1];
  const json = Buffer.from(payload, "base64url").toString("utf8");
  return JSON.parse(json);
}

export async function handleCallback(code, state) {
  if (!pendingState || state !== pendingState) throw new Error("state mismatch — начните вход заново");
  pendingState = null;

  const config = getConfig();
  if (!config) throw new Error("EVE SSO не настроен");

  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const res = await fetch("https://login.eveonline.com/v2/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Host: "login.eveonline.com",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const tokens = await res.json();

  // We fetched this JWT ourselves, straight from CCP's token endpoint over
  // TLS with our client secret — no untrusted party handed it to us, so a
  // plain decode (no signature check) of the character id/name is enough here.
  const claims = decodeJwtPayload(tokens.access_token);
  const characterId = Number(claims.sub.split(":").pop());
  const characterName = claims.name;

  const charRes = await fetch(`https://esi.evetech.net/latest/characters/${characterId}/?datasource=tranquility`);
  const charInfo = charRes.ok ? await charRes.json() : {};

  writeJson(AUTH_FILE, {
    characterId,
    characterName,
    corporationId: charInfo.corporation_id ?? null,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  });
}

export async function getValidAccessToken() {
  const auth = getAuth();
  if (!auth) throw new Error("не выполнен вход через EVE SSO");
  if (auth.expiresAt > Date.now() + 30000) return auth.accessToken;

  const config = getConfig();
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const res = await fetch("https://login.eveonline.com/v2/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Host: "login.eveonline.com",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: auth.refreshToken }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status}`);
  const tokens = await res.json();

  const updated = {
    ...auth,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? auth.refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
  writeJson(AUTH_FILE, updated);
  return updated.accessToken;
}
