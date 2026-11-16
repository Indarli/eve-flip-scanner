import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { URL } from "node:url";

import {
  HUBS,
  PUBLIC_DIR,
  CACHE_DIR,
  DATA_DIR,
  initDirs,
  loadConfig,
  saveConfig,
  loadCharacters,
  saveCharacters,
  loadResults,
  saveResults,
  loadPiCache,
  savePiCache,
  loadNames,
  saveNames,
} from "./lib/store.mjs";
import { EsiClient } from "./lib/esi.mjs";
import { Auth } from "./lib/auth.mjs";
import { loadCharacter as fetchCharacter, defaultFees } from "./lib/character.mjs";
import { runScan } from "./lib/scan.mjs";
import { analyzeColony, summarizePi } from "./lib/pi.mjs";
import { IntelService } from "./lib/intel.mjs";

initDirs();

let config = loadConfig();
const auth = new Auth({ getConfig: () => config });
const esi = new EsiClient({ cacheDir: CACHE_DIR, getToken: (id) => auth.tokenFor(id) });

let characters = loadCharacters();
let currentResults = loadResults();
let lastBooks = new Map();

const piCache = loadPiCache() || { layouts: {}, schematics: {} };
if (!piCache.layouts) piCache.layouts = {};
if (!piCache.schematics) piCache.schematics = {};
let namesCache = loadNames();
let piOverview = null;
let piBuilding = null;
let priceCache = { ts: 0, map: new Map() };

let scanState = {
  running: false,
  phase: "idle",
  message: "Готов к сканированию",
  pagesDone: 0,
  pagesTotal: 0,
  typesDone: 0,
  typesTotal: 0,
  rows: 0,
  warnings: [],
  startedAt: null,
  finishedAt: null,
  error: null,
};

const intel = new IntelService({ esi, auth, getConfig: () => config, dataDir: DATA_DIR });
intel.init().catch((e) => console.log(`[intel] init failed: ${e.message}`));

// ---------------------------------------------------------------- helpers

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function sendJson(req, res, status, payload) {
  const buf = Buffer.from(JSON.stringify(payload));
  const accept = req.headers["accept-encoding"] || "";
  if (buf.length > 1024 && accept.includes("gzip")) {
    const gz = zlib.gzipSync(buf);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Encoding": "gzip",
      "Cache-Control": "no-store",
    });
    res.end(gz);
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(buf);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(text);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function sendAuthPage(res, status, title, messageHtml, extraHtml = "") {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
  <style>
    body{background:#070a10;color:#dde7f6;font:15px/1.55 "Segoe UI",system-ui,sans-serif;padding:48px 24px;max-width:760px;margin:0 auto}
    h1{font-size:22px;margin:0 0 12px}
    code{background:#121b28;border:1px solid rgba(120,165,225,.2);padding:2px 6px;border-radius:4px;font-size:13px}
    a{color:#48c9f0}
    .muted{color:#7f90ab}
  </style></head><body>
  <h1>${escapeHtml(title)}</h1>
  <p>${messageHtml}</p>
  ${extraHtml}
  <p class="muted"><a href="/#settings">← вернуться в приложение</a></p>
  </body></html>`);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("Слишком большой запрос");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Некорректный JSON");
  }
}

function primaryCharacter() {
  if (config.primaryCharacterId && characters[config.primaryCharacterId]) return characters[config.primaryCharacterId];
  return Object.values(characters)[0] || null;
}

function mergedStructures() {
  const map = new Map();
  for (const c of Object.values(characters)) {
    for (const s of c.structures || []) map.set(Number(s.id), s);
  }
  return [...map.values()];
}

function characterList() {
  const out = new Map();
  for (const a of auth.list()) {
    out.set(a.characterId, {
      characterId: a.characterId,
      name: a.name,
      wallet: 0,
      colonies: 0,
      updatedAt: null,
      pending: true,
    });
  }
  for (const c of Object.values(characters)) {
    out.set(c.characterId, {
      characterId: c.characterId,
      name: c.name,
      wallet: c.wallet,
      colonies: (c.colonies || []).length,
      updatedAt: c.updatedAt,
      pending: false,
    });
  }
  return [...out.values()];
}

/** Догружаем профили персонажей, у которых есть токен, но нет сохранённых данных. */
function ensureProfiles() {
  for (const a of auth.list()) {
    if (!characters[a.characterId]) {
      refreshCharacter(a.characterId).catch(() => {});
    }
  }
}

function publicScanState() {
  return { ...scanState, eta: estimateEta(scanState) };
}

function estimateEta(s) {
  if (!s.running || !s.startedAt) return null;
  const elapsed = Date.now() - s.startedAt;
  let fraction = 0;
  if (s.phase === "books" && s.pagesTotal > 0) fraction = (s.pagesDone / s.pagesTotal) * 0.7;
  else if (s.phase === "history") fraction = 0.7 + (s.typesTotal ? (s.typesDone / s.typesTotal) * 0.25 : 0);
  else if (s.phase === "score") fraction = 0.9;
  else if (s.phase === "names") fraction = 0.97;
  if (fraction <= 0.02) return null;
  return Math.round((elapsed / fraction - elapsed) / 1000);
}

function sanitizeConfig(cfg) {
  return { ...cfg, clientId: cfg.clientId || "" };
}

const refreshing = new Map();

async function refreshCharacter(characterId) {
  if (refreshing.has(characterId)) return refreshing.get(characterId);
  const promise = (async () => {
    const profile = await fetchCharacter({ esi, auth, config, characterId });
    characters[profile.characterId] = profile;
    saveCharacters(characters);
    piOverview = null;
    return profile;
  })().finally(() => refreshing.delete(characterId));
  refreshing.set(characterId, promise);
  return promise;
}

async function startScan() {
  if (scanState.running) {
    const err = new Error("Сканирование уже идёт");
    err.status = 409;
    throw err;
  }
  esi.resetStats();
  const startedAt = Date.now();
  scanState = {
    running: true,
    phase: "books",
    message: "Запуск…",
    pagesDone: 0,
    pagesTotal: 0,
    typesDone: 0,
    typesTotal: 0,
    rows: 0,
    warnings: [],
    startedAt,
    finishedAt: null,
    error: null,
  };

  const jobConfig = JSON.parse(JSON.stringify(config));
  const primary = primaryCharacter();
  const jobCharacter = primary ? { ...primary, structures: mergedStructures() } : null;

  runScan({
    esi,
    config: jobConfig,
    character: jobCharacter,
    onStatus: (s) => {
      scanState = { ...s, running: true };
    },
  })
    .then((result) => {
      currentResults = { rows: result.rows, meta: result.meta };
      lastBooks = result.books || new Map();
      saveResults(currentResults);
      scanState = {
        ...scanState,
        running: false,
        phase: "done",
        message: `Готово: ${result.rows.length} позиций`,
        finishedAt: Date.now(),
        rows: result.rows.length,
      };
    })
    .catch((err) => {
      scanState = {
        ...scanState,
        running: false,
        phase: "error",
        message: err.message,
        error: err.message,
        finishedAt: Date.now(),
      };
    });
}

function findLocation(locationId) {
  const id = Number(locationId);
  const hub = HUBS.find((h) => h.stationId === id);
  if (hub) return { id, name: hub.name, kind: "npc", regionId: hub.regionId };
  const st = mergedStructures().find((s) => Number(s.id) === id);
  if (st) return { id, name: st.name, kind: "structure", regionId: st.regionId, tax: st.tax };
  const cfgSt = (config.structures || []).find((s) => Number(s.id) === id);
  if (cfgSt) return { id, name: cfgSt.name || `Structure ${id}`, kind: "structure", regionId: cfgSt.regionId, tax: cfgSt.tax };
  return null;
}

async function regionOfSystem(systemId) {
  const sys = await esi.get(`/universe/systems/${systemId}/`).catch(() => null);
  if (!sys?.constellation_id) return null;
  const cons = await esi.get(`/universe/constellations/${sys.constellation_id}/`).catch(() => null);
  return cons?.region_id ?? null;
}

function levelsFromOrders(orders) {  const buy = [];
  const sell = [];
  for (const o of orders) {
    const side = o.is_buy_order ? buy : sell;
    const price = Number(o.price);
    let lvl = side.find((l) => l.price === price);
    if (!lvl) {
      lvl = { price, volume: 0, orders: 0, minVolume: Number(o.min_volume) || 0 };
      side.push(lvl);
    }
    lvl.volume += Number(o.volume_remain);
    lvl.orders += 1;
  }
  buy.sort((a, b) => b.price - a.price);
  sell.sort((a, b) => a.price - b.price);
  return { buy: buy.slice(0, 12), sell: sell.slice(0, 12) };
}

async function itemDetail(typeId, locationId) {
  const loc = findLocation(locationId);
  if (!loc) throw Object.assign(new Error("Локация не найдена"), { status: 404 });
  if (!loc.regionId) throw Object.assign(new Error("Неизвестный регион структуры"), { status: 400 });

  const cachedBook = lastBooks.get(`${typeId}:${loc.id}`);
  let levels;
  if (cachedBook) {
    levels = { buy: cachedBook.buy, sell: cachedBook.sell };
  } else {
    if (loc.kind === "structure") {
      throw Object.assign(new Error("Нет данных по структуре — выполните скан"), { status: 404 });
    }
    const path = `/markets/${loc.regionId}/orders/?datasource=tranquility&order_type=all&type_id=${typeId}`;
    const orders = await esi.pagesAll(path, { cache: false, maxPages: 10 });
    const mine = orders.filter((o) => Number(o.location_id) === Number(loc.id));
    levels = levelsFromOrders(mine);
  }

  const [history, typeInfo] = await Promise.all([
    esi.get(`/markets/${loc.regionId}/history/?datasource=tranquility&type_id=${typeId}`).catch(() => []),
    esi.get(`/universe/types/${typeId}/`).catch(() => null),
  ]);
  let group = null;
  if (typeInfo?.group_id) {
    group = await esi.get(`/universe/groups/${typeInfo.group_id}/`).catch(() => null);
  }

  const primary = primaryCharacter();
  const fee = loc.kind === "structure"
    ? { tax: primary?.fees?.tax ?? defaultFees().tax, broker: 0.005 + (loc.tax ?? config.defaultStructureTax ?? 0.01) }
    : (() => {
        const hubFee = Object.values(primary?.fees?.hubs || {}).find((h) => h.stationId === loc.id);
        return { tax: primary?.fees?.tax ?? defaultFees().tax, broker: hubFee?.broker ?? defaultFees().broker };
      })();

  return {
    location: loc,
    type: typeInfo
      ? {
          id: typeId,
          name: typeInfo.name,
          volume: typeInfo.volume,
          groupId: typeInfo.group_id,
          groupName: group?.name || null,
          categoryId: group?.category_id || null,
          packagedVolume: typeInfo.packaged_volume,
        }
      : { id: typeId, name: `Type ${typeId}` },
    book: levels,
    history: (Array.isArray(history) ? history : []).slice(-180),
    fees: fee,
  };
}

// ---------------------------------------------------------------- PI

async function resolveNames(ids) {
  const missing = [...new Set(ids.map(Number).filter(Boolean))].filter((id) => !namesCache[id]);

  // /universe/names/ отдаёт 404 на весь батч, если хотя бы один id невалиден,
  // поэтому при ошибке дробим запрос пополам вплоть до одного id.
  async function fetchChunk(chunk) {
    if (!chunk.length) return;
    try {
      const res = await esi.post("/universe/names/?datasource=tranquility", chunk);
      for (const n of res || []) namesCache[n.id] = { name: n.name, category: n.category };
    } catch {
      if (chunk.length <= 1) return;
      const mid = Math.ceil(chunk.length / 2);
      await fetchChunk(chunk.slice(0, mid));
      await fetchChunk(chunk.slice(mid));
    }
  }

  for (let i = 0; i < missing.length; i += 900) {
    await fetchChunk(missing.slice(i, i + 900));
  }
  if (missing.length) saveNames(namesCache);

  const map = new Map();
  for (const id of ids) {
    const v = namesCache[Number(id)];
    if (v) map.set(Number(id), v);
  }
  return map;
}

async function resolveSchematics(ids) {
  for (const id of ids) {
    if (!id || piCache.schematics[id]) continue;
    try {
      piCache.schematics[id] = await esi.get(`/universe/schematics/${id}/?datasource=tranquility`);
    } catch {
      /* ignore */
    }
  }
  savePiCache(piCache);
  return new Map(Object.entries(piCache.schematics).map(([k, v]) => [Number(k), v]));
}

async function getPiPrices(typeIds) {
  const out = new Map();
  const fromScan = new Map((currentResults?.rows || []).map((r) => [r.typeId, { bid: r.bid, ask: r.ask }]));
  const missing = [];

  for (const id of typeIds) {
    const cached = priceCache.ts && Date.now() - priceCache.ts < 5 * 60_000 ? priceCache.map.get(id) : null;
    if (cached) out.set(id, cached);
    else if (fromScan.has(id)) out.set(id, fromScan.get(id));
    else missing.push(id);
  }

  if (missing.length) {
    try {
      const url = `https://market.fuzzwork.co.uk/aggregates/?region=10000002&types=${missing.join(",")}`;
      const res = await fetch(url, { headers: { "User-Agent": "EVE-Flip-Scanner/1.0" } });
      if (res.ok) {
        const data = await res.json();
        for (const [idStr, v] of Object.entries(data || {})) {
          const value = { bid: Number(v?.buy?.max) || 0, ask: Number(v?.sell?.min) || 0 };
          priceCache.map.set(Number(idStr), value);
          out.set(Number(idStr), value);
        }
        priceCache.ts = Date.now();
      }
    } catch {
      /* без цен показываем нули */
    }
  }
  return out;
}

async function buildPiOverview(force = false) {
  if (!force && piOverview && Date.now() - piOverview.generatedAt < 5 * 60_000) return piOverview;
  if (piBuilding) return piBuilding;

  piBuilding = (async () => {
    const warnings = [];
    const allProfiles = [];

    // берём всех авторизованных, а не только тех, у кого уже сохранён профиль
    for (const a of auth.list()) {
      let c = characters[a.characterId];
      if (!c) {
        let colonies = [];
        let coloniesError = null;
        try {
          colonies = await esi.get(`/characters/${a.characterId}/planets/?datasource=tranquility`, { auth: a.characterId });
        } catch (e) {
          coloniesError =
            e.status === 403
              ? "нет доступа к планетарке — нужен повторный вход (scope esi-planets.manage_planets.v1)"
              : e.message;
        }
        c = { characterId: a.characterId, name: a.name, colonies, coloniesError };
      }
      allProfiles.push(c);
      if (c.coloniesError) warnings.push(`${c.name || c.characterId}: ${c.coloniesError}`);
      if (!(a.scopes || []).includes("esi-planets.manage_planets.v1")) {
        warnings.push(`${a.name || a.characterId}: нет scope для планетарки — нажмите «+ персонаж» и войдите заново`);
      }
    }

    const profiles = allProfiles.filter((c) => Array.isArray(c.colonies) && c.colonies.length);
    const layouts = piCache.layouts;
    const ids = new Set();

    for (const c of profiles) {
      for (const col of c.colonies) {
        const key = `${c.characterId}:${col.planet_id}`;
        let entry = layouts[key];
        if (!entry || force || Date.now() - entry.ts > 10 * 60_000) {
          try {
            const layout = await esi.get(`/characters/${c.characterId}/planets/${col.planet_id}/?datasource=tranquility`, {
              auth: c.characterId,
            });
            entry = { ts: Date.now(), layout };
          } catch (err) {
            entry = entry || { ts: 0, layout: null, error: err.message };
          }
          layouts[key] = entry;
        }
        for (const p of entry.layout?.pins || []) {
          if (p.type_id) ids.add(p.type_id);
          if (p.extractor_details?.product_type_id) ids.add(p.extractor_details.product_type_id);
          for (const ct of p.contents || []) if (ct.type_id) ids.add(ct.type_id);
        }
        ids.add(col.planet_id);
        ids.add(col.solar_system_id);
      }
    }
    savePiCache(piCache);

    const names = await resolveNames([...ids]);

    // имена планет могли не прийти из /names — добираем точечно
    for (const c of profiles) {
      for (const col of c.colonies) {
        if (names.has(Number(col.planet_id))) continue;
        try {
          const p = await esi.get(`/universe/planets/${col.planet_id}/`);
          names.set(Number(col.planet_id), { name: p.name, category: "planet" });
          namesCache[col.planet_id] = { name: p.name, category: "planet" };
        } catch {
          /* ignore */
        }
      }
    }
    saveNames(namesCache);

    const schematicIds = new Set();
    for (const c of profiles) {
      for (const col of c.colonies) {
        const entry = layouts[`${c.characterId}:${col.planet_id}`];
        for (const p of entry?.layout?.pins || []) {
          if (p.schematic_id) schematicIds.add(p.schematic_id);
        }
      }
    }
    const schematics = await resolveSchematics([...schematicIds]);
    const prices = await getPiPrices(ids);

    const colonies = [];
    for (const c of profiles) {
      for (const col of c.colonies) {
        const entry = layouts[`${c.characterId}:${col.planet_id}`];
        if (!entry?.layout) continue;
        colonies.push(
          analyzeColony({
            colony: col,
            layout: entry.layout,
            names,
            schematics,
            prices,
            characterId: c.characterId,
            characterName: c.name,
            now: Date.now(),
          })
        );
      }
    }

    const { totals, queue } = summarizePi(colonies);
    piOverview = {
      generatedAt: Date.now(),
      characters: profiles.map((c) => ({ characterId: c.characterId, name: c.name })),
      colonies,
      totals,
      queue,
      warnings,
      errors: Object.entries(layouts)
        .filter(([, v]) => v.error)
        .map(([k, v]) => `${k}: ${v.error}`),
    };
    return piOverview;
  })().finally(() => {
    piBuilding = null;
  });

  return piBuilding;
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    // ---- статика ----
    if (req.method === "GET" && !pathname.startsWith("/api/") && pathname !== "/callback") {
      const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const file = path.join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR)) {
        sendText(res, 403, "Forbidden");
        return;
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          sendText(res, 404, "Not found");
          return;
        }
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
          "Cache-Control": "no-store",
        });
        res.end(data);
      });
      return;
    }

    // ---- OAuth callback ----
    if (req.method === "GET" && pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const err = url.searchParams.get("error");
      console.log(`[auth] callback: code=${code ? "yes" : "no"} state=${(state || "").slice(0, 6)} error=${err || "-"}`);
      if (err || !code) {
        sendAuthPage(
          res,
          400,
          "Вход не завершён",
          `EVE вернула ошибку: <code>${escapeHtml(err || "нет кода авторизации")}</code>.`,
          `<p>Попробуйте войти ещё раз из приложения.</p>`
        );
        return;
      }
      try {
        const { characterId } = await auth.finishLogin(code, state);
        console.log(`[auth] callback: ok, character ${characterId}`);
        // Отвечаем сразу, не дожидаясь тяжёлой загрузки профиля (ассеты/ордера/структуры).
        res.writeHead(302, { Location: `/?auth=ok&char=${characterId}#pi` });
        res.end();
        refreshCharacter(characterId).catch((e) => console.log(`[auth] profile load failed: ${e.message}`));
      } catch (e) {
        console.log(`[auth] callback error: ${e.message}`);
        sendAuthPage(
          res,
          400,
          "Не удалось завершить вход",
          `${escapeHtml(e.message)}`,
          `<p>Если страница выбора персонажа зависала — попробуйте ещё раз в режиме инкогнито
           или вставьте адрес из строки браузера в поле «Ручной вход» в настройках приложения.</p>`
        );
      }
      return;
    }

    // ---- API ----
    if (pathname === "/api/health") {
      sendJson(req, res, 200, { ok: true, time: new Date().toISOString() });
      return;
    }

    if (pathname === "/api/config" && req.method === "GET") {
      ensureProfiles();
      sendJson(req, res, 200, {
        config: sanitizeConfig(config),
        hubs: HUBS,
        auth: auth.status(),
        characters: characterList(),
        character: primaryCharacter(),
        scan: publicScanState(),
        resultsCount: currentResults?.rows?.length || 0,
        resultsMeta: currentResults?.meta || null,
        fees: primaryCharacter()?.fees || { source: "default", tax: defaultFees().tax, broker: defaultFees().broker, hubs: {} },
        esiStats: esi.stats,
      });
      return;
    }

    if (pathname === "/api/config" && req.method === "POST") {
      const body = await readBody(req);
      const next = {
        ...config,
        clientId: typeof body.clientId === "string" ? body.clientId.trim() : config.clientId,
        callbackUrl: typeof body.callbackUrl === "string" && body.callbackUrl ? body.callbackUrl : config.callbackUrl,
        capture: body.capture !== undefined ? Math.min(1, Math.max(0.05, Number(body.capture) || 0.5)) : config.capture,
        historyBudget:
          body.historyBudget !== undefined
            ? Math.min(1000, Math.max(20, Number(body.historyBudget) || 250))
            : config.historyBudget,
        primaryCharacterId:
          body.primaryCharacterId && characters[body.primaryCharacterId] ? Number(body.primaryCharacterId) : config.primaryCharacterId,
        hubs: { ...config.hubs, ...(body.hubs || {}) },
        filters: { ...config.filters, ...(body.filters || {}) },
        structures: Array.isArray(body.structures) ? body.structures : config.structures,
        defaultStructureTax:
          body.defaultStructureTax !== undefined
            ? Math.min(0.1, Math.max(0, Number(body.defaultStructureTax) || 0))
            : config.defaultStructureTax,
      };
      config = next;
      saveConfig(config);
      sendJson(req, res, 200, { ok: true, config: sanitizeConfig(config) });
      return;
    }

    if (pathname === "/api/auth/login" && req.method === "GET") {
      try {
        const target = await auth.loginUrl();
        const state = new URL(target).searchParams.get("state") || "";
        console.log(`[auth] login start state=${state.slice(0, 6)} pending=${auth.pendingCount()}`);
        res.writeHead(302, { Location: target });
        res.end();
      } catch (e) {
        sendAuthPage(res, 500, "Не удалось начать вход", escapeHtml(e.message));
      }
      return;
    }

    if (pathname === "/api/auth/manual" && req.method === "POST") {
      const body = await readBody(req);
      let code = null;
      let state = null;
      try {
        const u = new URL(String(body.url || "").trim());
        code = u.searchParams.get("code");
        state = u.searchParams.get("state");
      } catch {
        /* ниже вернём ошибку */
      }
      if (!code || !state) {
        sendJson(req, res, 400, {
          error: "В ссылке нет code/state. Скопируйте адрес целиком из строки браузера после входа.",
        });
        return;
      }
      try {
        const { characterId } = await auth.finishLogin(code, state);
        sendJson(req, res, 200, { ok: true, characterId });
        refreshCharacter(characterId).catch((e) => console.log(`[auth] profile load failed: ${e.message}`));
      } catch (e) {
        sendJson(req, res, 400, { error: e.message });
      }
      return;
    }

    if (pathname === "/api/auth/diagnose" && req.method === "GET") {
      const t0 = Date.now();
      let sso;
      try {
        const meta = await auth.metadata();
        sso = {
          ok: true,
          ms: Date.now() - t0,
          authorization_endpoint: meta.authorization_endpoint,
          token_endpoint: meta.token_endpoint,
        };
      } catch (e) {
        sso = { ok: false, ms: Date.now() - t0, error: e.message };
      }
      sendJson(req, res, 200, {
        clientIdSet: auth.isConfigured(),
        clientIdLength: auth.clientId().length,
        callbackUrl: auth.redirectUri(),
        expectedCallback: `http://${host}:${port}/callback`,
        callbackMatches: auth.redirectUri() === `http://${host}:${port}/callback`,
        pending: auth.pendingCount(),
        characters: auth.list().map((c) => ({
          characterId: c.characterId,
          name: c.name,
          scopes: (c.scopes || []).length,
          planets: (c.scopes || []).includes("esi-planets.manage_planets.v1"),
        })),
        sso,
        now: new Date().toISOString(),
      });
      return;
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      if (body.characterId) {
        auth.remove(Number(body.characterId));
        delete characters[body.characterId];
      } else {
        for (const id of Object.keys(characters)) auth.remove(Number(id));
        characters = {};
      }
      saveCharacters(characters);
      piOverview = null;
      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/auth/status" && req.method === "GET") {
      sendJson(req, res, 200, { auth: auth.status(), characters: characterList(), character: primaryCharacter() });
      return;
    }

    if (pathname === "/api/character/refresh" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const ids = body.characterId
        ? [Number(body.characterId)]
        : auth.list().map((c) => Number(c.characterId)).filter((id) => auth.has(id));

      if (!ids.length) {
        sendJson(req, res, 401, { error: "Нет авторизации" });
        return;
      }
      for (const id of ids) {
        refreshCharacter(id).catch((e) => console.log(`[character] refresh ${id} failed: ${e.message}`));
      }
      sendJson(req, res, 202, { ok: true, started: ids.length });
      return;
    }

    if (pathname === "/api/scan" && req.method === "POST") {
      if (scanState.running) {
        sendJson(req, res, 409, { error: "Сканирование уже идёт", scan: publicScanState() });
        return;
      }
      await startScan();
      sendJson(req, res, 202, { ok: true, scan: publicScanState() });
      return;
    }

    if (pathname === "/api/scan/status" && req.method === "GET") {
      sendJson(req, res, 200, { scan: publicScanState(), esiStats: esi.stats });
      return;
    }

    if (pathname === "/api/results" && req.method === "GET") {
      sendJson(req, res, 200, currentResults || { rows: [], meta: null });
      return;
    }

    if (pathname === "/api/item" && req.method === "GET") {
      const typeId = Number(url.searchParams.get("type"));
      const locationId = Number(url.searchParams.get("loc"));
      if (!typeId || !locationId) {
        sendJson(req, res, 400, { error: "Нужны параметры type и loc" });
        return;
      }
      sendJson(req, res, 200, await itemDetail(typeId, locationId));
      return;
    }

    if (pathname === "/api/pi/overview" && req.method === "GET") {
      const force = url.searchParams.get("refresh") === "1";
      ensureProfiles();
      const data = await buildPiOverview(force);
      sendJson(req, res, 200, data);
      return;
    }

    if (pathname === "/api/pi/refresh" && req.method === "POST") {
      const data = await buildPiOverview(true);
      sendJson(req, res, 200, data);
      return;
    }

    if (pathname === "/api/intel/state" && req.method === "GET") {
      sendJson(req, res, 200, await intel.snapshot());
      return;
    }

    if (pathname === "/api/intel/channels" && req.method === "GET") {
      sendJson(req, res, 200, { channels: intel.listChannels(), selected: config.intel?.channels || [] });
      return;
    }

    if (pathname === "/api/intel/config" && req.method === "POST") {
      const body = await readBody(req);
      const prev = new Set(config.intel?.channels || []);
      const nextIntel = { ...(config.intel || {}) };
      if (Array.isArray(body.channels)) nextIntel.channels = body.channels.map(String);
      if (body.threshold !== undefined) nextIntel.threshold = Math.min(20, Math.max(1, Number(body.threshold) || 5));
      if (body.sound !== undefined) nextIntel.sound = Boolean(body.sound);
      if (body.recentMinutes !== undefined)
        nextIntel.recentMinutes = Math.min(1440, Math.max(2, Number(body.recentMinutes) || 30));
      if (typeof body.chatDir === "string" && body.chatDir.trim()) nextIntel.chatDir = body.chatDir.trim();

      config = { ...config, intel: nextIntel };
      saveConfig(config);

      const changed =
        nextIntel.channels.length !== prev.size ||
        nextIntel.channels.some((c) => !prev.has(c)) ||
        body.recentMinutes !== undefined;
      if (changed) {
        intel.offsets.clear();
        intel.scanFiles(true);
      }
      sendJson(req, res, 200, { ok: true, intel: nextIntel });
      return;
    }

    if (pathname === "/api/intel/sound" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const ext = intel.saveSound(body.dataUrl);
        sendJson(req, res, 200, { ok: true, ext });
      } catch (e) {
        sendJson(req, res, 400, { error: e.message });
      }
      return;
    }

    if (pathname === "/api/intel/sound" && req.method === "GET") {
      if (!intel.soundFile || !fs.existsSync(intel.soundFile)) {
        sendJson(req, res, 404, { error: "Файл не загружен" });
        return;
      }
      const ext = path.extname(intel.soundFile).toLowerCase();
      const type =
        ext === ".mp3" ? "audio/mpeg" : ext === ".wav" ? "audio/wav" : ext === ".ogg" ? "audio/ogg" : "audio/mp4";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      fs.createReadStream(intel.soundFile).pipe(res);
      return;
    }

    if (pathname === "/api/intel/refresh" && req.method === "POST") {
      intel.offsets.clear();
      intel.scanFiles(true);
      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/intel/recalc" && req.method === "POST") {
      intel.recalcDistances();
      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/structures" && req.method === "POST") {
      const body = await readBody(req);
      const id = Number(body.id);
      if (!id) {
        sendJson(req, res, 400, { error: "Нужен id структуры" });
        return;
      }
      const primary = primaryCharacter();
      let info = null;
      if (primary) {
        info = await esi.get(`/universe/structures/${id}/`, { auth: primary.characterId }).catch(() => null);
      }
      if (!info && !body.force) {
        sendJson(req, res, 404, { error: "Структура не найдена или нет прав доступа. Можно добавить принудительно (force)." });
        return;
      }
      const regionId = info ? await regionOfSystem(info.solar_system_id) : null;
      const entry = {
        id,
        name: info?.name || body.name || `Structure ${id}`,
        regionId,
        tax: body.tax !== undefined ? Math.min(0.1, Math.max(0, Number(body.tax) || 0)) : config.defaultStructureTax,
      };
      if (!config.structures.some((s) => Number(s.id) === id)) config.structures.push(entry);
      saveConfig(config);
      sendJson(req, res, 200, { ok: true, structure: entry });
      return;
    }

    if (pathname.startsWith("/api/structures/") && req.method === "DELETE") {
      const id = Number(pathname.split("/").pop());
      config.structures = config.structures.filter((s) => Number(s.id) !== id);
      saveConfig(config);
      sendJson(req, res, 200, { ok: true });
      return;
    }

    sendJson(req, res, 404, { error: "Не найдено" });
  } catch (err) {
    sendJson(req, res, err.status || 500, { error: err.message || String(err) });
  }
});

const port = Number(process.env.PORT) || Number(config.server?.port) || 8787;
const host = process.env.HOST || config.server?.host || "127.0.0.1";

server.listen(port, host, () => {
  console.log(`EVE Flip Scanner: http://${host}:${port}`);
  console.log(`Callback URL для приложения EVE: ${auth.redirectUri()}`);
});
