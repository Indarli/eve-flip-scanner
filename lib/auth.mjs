import crypto from "node:crypto";
import { loadTokens, saveTokens } from "./store.mjs";

const META_URL = "https://login.eveonline.com/.well-known/oauth-authorization-server";

export const SCOPES = [
  "esi-skills.read_skills.v1",
  "esi-wallet.read_character_wallet.v1",
  "esi-characters.read_standings.v1",
  "esi-markets.read_character_orders.v1",
  "esi-markets.structure_markets.v1",
  "esi-universe.read_structures.v1",
  "esi-assets.read_assets.v1",
  "esi-location.read_location.v1",
  "esi-location.read_online.v1",
  "esi-planets.manage_planets.v1",
  "esi-planets.read_customs_offices.v1",
];

function decodeJwt(token) {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export class Auth {
  constructor({ getConfig }) {
    this.getConfig = getConfig;
    this.meta = null;
    this.metaAt = 0;
    this.pending = new Map();
    this.refreshing = new Map();
    this.tokens = loadTokens();
  }

  async metadata() {
    if (this.meta && Date.now() - this.metaAt < 3_600_000) return this.meta;
    const res = await fetch(META_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`SSO metadata: HTTP ${res.status}`);
    this.meta = await res.json();
    this.metaAt = Date.now();
    return this.meta;
  }

  pendingCount() {
    return this.pending.size;
  }

  clientId() {
    return String(this.getConfig().clientId || "").trim();
  }

  redirectUri() {
    const cfg = this.getConfig();
    return cfg.callbackUrl || "http://127.0.0.1:8787/callback";
  }

  isConfigured() {
    return this.clientId().length > 0;
  }

  /** Список авторизованных персонажей (без токенов). */
  list() {
    return Object.values(this.tokens.characters || {}).map((t) => ({
      characterId: t.character_id,
      name: t.character_name || `Character ${t.character_id}`,
      expiresAt: t.expires_at,
      scopes: t.scopes || [],
      addedAt: t.updated_at || null,
    }));
  }

  has(characterId) {
    return Boolean(this.tokens.characters?.[characterId]);
  }

  async loginUrl() {
    if (!this.isConfigured()) throw new Error("Не задан Client ID приложения EVE.");
    const meta = await this.metadata();
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = crypto.randomBytes(16).toString("base64url");

    for (const [k, v] of this.pending) {
      if (Date.now() - v.created > 10 * 60_000) this.pending.delete(k);
    }
    this.pending.set(state, {
      verifier,
      created: Date.now(),
      redirectUri: this.redirectUri(),
      clientId: this.clientId(),
    });

    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId());
    url.searchParams.set("redirect_uri", this.redirectUri());
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async finishLogin(code, state) {
    const pending = state ? this.pending.get(state) : null;
    if (!pending) throw new Error("Неизвестный state — начните вход заново.");
    this.pending.delete(state);

    const meta = await this.metadata();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
    });

    const res = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Обмен кода не удался: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    return this.#store(data);
  }

  #store(data) {
    const claims = decodeJwt(data.access_token) || {};
    const characterId = Number(String(claims.sub || "").split(":").pop()) || null;
    if (!characterId) throw new Error("Не удалось определить персонажа из токена");

    const entry = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || this.tokens.characters?.[characterId]?.refresh_token || null,
      expires_at: Date.now() + (Number(data.expires_in) || 1200) * 1000,
      character_id: characterId,
      character_name: claims.name || null,
      scopes: claims.scp || String(data.scope || "").split(" ").filter(Boolean),
      updated_at: Date.now(),
    };
    this.tokens.characters[characterId] = entry;
    saveTokens(this.tokens);
    return { characterId, name: entry.character_name };
  }

  async tokenFor(characterId) {
    const entry = this.tokens.characters?.[characterId];
    if (!entry?.access_token) return null;
    if (entry.expires_at - 60_000 > Date.now()) return entry.access_token;
    if (!entry.refresh_token) return null;

    if (this.refreshing.has(characterId)) return this.refreshing.get(characterId);

    const promise = (async () => {
      try {
        const meta = await this.metadata();
        const body = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: entry.refresh_token,
          client_id: this.clientId(),
        });
        const res = await fetch(meta.token_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body,
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`refresh HTTP ${res.status}`);
        const data = await res.json();
        const claims = decodeJwt(data.access_token) || {};
        entry.access_token = data.access_token;
        entry.refresh_token = data.refresh_token || entry.refresh_token;
        entry.expires_at = Date.now() + (Number(data.expires_in) || 1200) * 1000;
        entry.character_name = claims.name || entry.character_name;
        entry.scopes = claims.scp || entry.scopes;
        entry.updated_at = Date.now();
        saveTokens(this.tokens);
        return entry.access_token;
      } catch {
        delete this.tokens.characters[characterId];
        saveTokens(this.tokens);
        return null;
      } finally {
        this.refreshing.delete(characterId);
      }
    })();

    this.refreshing.set(characterId, promise);
    return promise;
  }

  remove(characterId) {
    delete this.tokens.characters[characterId];
    saveTokens(this.tokens);
  }

  status() {
    return {
      configured: this.isConfigured(),
      characters: this.list(),
      loggedIn: this.list().length > 0,
      redirectUri: this.redirectUri(),
      requiredScopes: SCOPES,
    };
  }
}
