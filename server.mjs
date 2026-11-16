import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { URL } from "node:url";

import {
  HUBS,
  PUBLIC_DIR,
  CACHE_DIR,
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
  return Object.values(characters).map((c) => ({
    characterId: c.characterId,
    name: c.name,
    wallet: c.wallet,
    colonies: (c.colonies || []).length,
    updatedAt: c.updatedAt,
  }));
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

async function refreshCharacter(characterId) {
  const profile = await fetchCharacter({ esi, auth, config, characterId });
  characters[profile.characterId] = profile;
  saveCharacters(characters);
  piOverview = null;
  return profile;
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

function levelsFromOrders(orders) {
  const buy = [];
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
    const allProfiles = Object.values(characters);
    const warnings = [];
    for (const c of allProfiles) {
      if (c.coloniesError) warnings.push(`${c.name || c.characterId}: ${c.coloniesError}`);
    }
    for (const a of auth.list()) {
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
      if (err || !code) {
        res.writeHead(302, { Location: `/?auth=error&message=${encodeURIComponent(err || "Нет кода авторизации")}` });
        res.end();
        return;
      }
      try {
        const { characterId } = await auth.finishLogin(code, state);
        await refreshCharacter(characterId);
        res.writeHead(302, { Location: "/?auth=ok#pi" });
        res.end();
      } catch (e) {
        res.writeHead(302, { Location: `/?auth=error&message=${encodeURIComponent(e.message)}` });
        res.end();
      }
      return;
    }

    // ---- API ----
    if (pathname === "/api/health") {
      sendJson(req, res, 200, { ok: true, time: new Date().toISOString() });
      return;
    }

    if (pathname === "/api/config" && req.method === "GET") {
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
        res.writeHead(302, { Location: target });
        res.end();
      } catch (e) {
        res.writeHead(302, { Location: `/?auth=error&message=${encodeURIComponent(e.message)}` });
        res.end();
      }
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
      const updated = [];
      for (const id of ids) {
        try {
          updated.push(await refreshCharacter(id));
        } catch (e) {
          /* пропускаем персонажа с ошибкой */
        }
      }
      sendJson(req, res, 200, { ok: true, characters: updated.map((c) => ({ characterId: c.characterId, name: c.name })) });
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
      const data = await buildPiOverview(force);
      sendJson(req, res, 200, data);
      return;
    }

    if (pathname === "/api/pi/refresh" && req.method === "POST") {
      const data = await buildPiOverview(true);
      sendJson(req, res, 200, data);
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
      const system = info ? await esi.get(`/universe/systems/${info.solar_system_id}/`).catch(() => null) : null;
      const entry = {
        id,
        name: info?.name || body.name || `Structure ${id}`,
        regionId: system?.region_id ?? null,
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
