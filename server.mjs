import http from "node:http";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));
import path from "node:path";
import zlib from "node:zlib";
import { exec } from "node:child_process";
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
  createBackup,
  listBackups,
} from "./lib/store.mjs";
import { EsiClient } from "./lib/esi.mjs";
import { Auth } from "./lib/auth.mjs";
import { loadCharacter as fetchCharacter, defaultFees } from "./lib/character.mjs";
import { runScan } from "./lib/scan.mjs";
import { analyzeColony, summarizePi } from "./lib/pi.mjs";
import { IntelService } from "./lib/intel.mjs";
import { markOrders, fetchQuotes, fetchTypeNames } from "./lib/portfolio.mjs";

initDirs();

setTimeout(() => {
  try {
    createBackup("startup");
  } catch {
    /* ignore */
  }
}, 5000);
setInterval(() => {
  try {
    createBackup("daily");
  } catch {
    /* ignore */
  }
}, 24 * 3600_000);

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

let portfolioCache = { ts: 0, data: null };
const compareCache = new Map();
const locationCache = new Map();

function withTimeout(promise, ms, fallback = null) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function locationInfo(locationId, characterId) {
  const id = Number(locationId);
  if (!id) return { name: null, systemName: null };
  const hit = locationCache.get(id);
  if (hit && Date.now() - hit.ts < 6 * 3600_000) return hit;

  let name = null;
  let systemName = null;
  try {
    if (id < 1e12) {
      const st = await esi.get(`/universe/stations/${id}/`);
      name = st?.name || null;
      if (st?.system_id) {
        const sys = await esi.get(`/universe/systems/${st.system_id}/`);
        systemName = sys?.name || null;
      }
    } else {
      // сначала смотрим в известных структурах (конфиг/профиль персонажа)
      const known = mergedStructures().find((s) => Number(s.id) === id);
      if (known?.name) {
        name = known.name;
        if (known.systemId) {
          const sys = await withTimeout(esi.get(`/universe/systems/${known.systemId}/`), 3000);
          systemName = sys?.name || null;
        }
      } else {
        const st = await esi.get(`/universe/structures/${id}/`, { auth: characterId });
        name = st?.name || null;
        if (st?.system_id) {
          const sys = await withTimeout(esi.get(`/universe/systems/${st.system_id}/`), 3000);
          systemName = sys?.name || null;
        }
      }
    }
  } catch {
    /* структура может быть недоступна */
  }
  const info = { name, systemName, ts: Date.now() };
  locationCache.set(id, info);
  return info;
}

async function buildPortfolio() {
  const ch = primaryCharacter();
  if (!ch) return null;
  if (portfolioCache.data && Date.now() - portfolioCache.ts < 60_000) return portfolioCache.data;

  const orders = ch.ordersList || [];
  const byLoc = new Map();
  for (const o of orders) {
    if (!byLoc.has(o.location_id)) byLoc.set(o.location_id, new Set());
    byLoc.get(o.location_id).add(o.type_id);
  }

  const quoteMaps = new Map();
  for (const [loc, ids] of byLoc) {
    const hub = HUBS.find((h) => h.stationId === Number(loc));
    const regionId = hub ? hub.regionId : 10000002;
    quoteMaps.set(loc, await fetchQuotes({ stationId: loc, regionId, typeIds: [...ids] }));
  }
  const marked = markOrders(orders, (o) => quoteMaps.get(o.location_id)?.get(Number(o.type_id)));

  const stacks = (ch.assetStacks || []).filter((s) => s.qty > 0);
  const baseStacks = stacks.length
    ? stacks
    : (ch.assetTotals || []).map((a) => ({ typeId: a.typeId, locationId: null, qty: a.qty }));

  const typeTotals = new Map();
  for (const s of baseStacks) typeTotals.set(s.typeId, (typeTotals.get(s.typeId) || 0) + s.qty);
  const pricedTypes = [...typeTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 300)
    .map(([id]) => id);
  const pricedSet = new Set(pricedTypes);
  const assetQuotes = await fetchQuotes({ regionId: 10000002, typeIds: pricedTypes });

  const typeIds = [
    ...new Set([
      ...orders.map((o) => o.type_id),
      ...pricedTypes,
      ...(ch.transactionsStats?.rows || []).map((r) => r.typeId),
    ]),
  ];
  const names = await fetchTypeNames(typeIds);
  const nameOf = (id) => names.get(Number(id)) || `Type ${id}`;
  const locName = (id) => {
    const hub = HUBS.find((h) => h.stationId === Number(id));
    if (hub) return hub.name;
    const st = mergedStructures().find((s) => Number(s.id) === Number(id));
    return st ? st.name : `#${id}`;
  };

  const inventoryRaw = baseStacks
    .filter((s) => pricedSet.has(s.typeId))
    .map((s) => {
      const price = assetQuotes.get(s.typeId)?.bid || 0;
      return {
        typeId: s.typeId,
        locationId: s.locationId,
        typeName: nameOf(s.typeId),
        qty: s.qty,
        price,
        value: price * s.qty,
      };
    })
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 30);

  const locInfos = await mapLimit(inventoryRaw, 6, (r) =>
    r.locationId ? withTimeout(locationInfo(r.locationId, ch.characterId), 4000) : null
  );
  const inventory = inventoryRaw.map((r, i) => ({
    ...r,
    locationName: locInfos[i]?.name || null,
    systemName: locInfos[i]?.systemName || null,
  }));

  const ordersValue = marked.reduce((s, o) => s + o.value, 0);
  const inventoryValue = inventory.reduce((s, x) => s + x.value, 0);
  const tx = ch.transactionsStats || { rows: [], total: {} };

  const result = {
    character: { id: ch.characterId, name: ch.name, wallet: ch.wallet },
    summary: {
      wallet: ch.wallet,
      escrow: ch.orders?.escrow || 0,
      ordersValue,
      inventoryValue,
      realized: tx.total?.realized || 0,
      boughtIsk: tx.total?.boughtIsk || 0,
      soldIsk: tx.total?.soldIsk || 0,
      undercut: marked.filter((o) => o.undercut).length,
    },
    orders: marked.map((o) => ({ ...o, typeName: nameOf(o.typeId), locationName: locName(o.locationId) })),
    pnl: (tx.rows || []).map((r) => ({ ...r, typeName: nameOf(r.typeId) })).sort((a, b) => b.realized - a.realized),
    inventory,
    generatedAt: Date.now(),
  };
  portfolioCache = { ts: Date.now(), data: result };
  return result;
}

// ---------------------------------------------------------------- SSE

const sseClients = new Set();
let lastScanBroadcast = 0;

function sseFormat(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcast(event, data) {
  if (!sseClients.size) return;
  const msg = sseFormat(event, data);
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch {
      sseClients.delete(client);
    }
  }
}

function broadcastScan(force = false) {
  if (!sseClients.size) return;
  const now = Date.now();
  if (!force && now - lastScanBroadcast < 400) return;
  lastScanBroadcast = now;
  broadcast("scan", publicScanState());
}

setInterval(async () => {
  if (!sseClients.size) return;
  if (scanState.running) broadcastScan();
  try {
    broadcast("intel", await intel.snapshot());
    broadcast("esi", esi.status());
  } catch {
    /* ignore */
  }
}, 2000);

// автоматическая проверка доступности ESI, когда он «упал»
setInterval(() => {
  if (esi.stats.consecutiveErrors >= 3) {
    esi.probe().catch(() => {});
  }
}, 15_000);

setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(": ping\n\n");
    } catch {
      sseClients.delete(client);
    }
  }
}, 20_000);

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
    portfolioCache = { ts: 0, data: null };
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
  broadcastScan(true);

  runScan({
    esi,
    config: jobConfig,
    character: jobCharacter,
    onStatus: (s) => {
      scanState = { ...s, running: true };
      broadcastScan();
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
      broadcastScan(true);
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
      broadcastScan(true);
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
      sendJson(req, res, 200, { ok: true, version: pkg.version, ai: pkg.ai || null, time: new Date().toISOString() });
      return;
    }

    if (pathname === "/api/esi/status" && req.method === "GET") {
      sendJson(req, res, 200, esi.status());
      return;
    }

    if (pathname === "/api/backup/list" && req.method === "GET") {
      sendJson(req, res, 200, { backups: listBackups().slice(0, 30) });
      return;
    }

    if (pathname === "/api/backup/now" && req.method === "POST") {
      let files = [];
      try {
        files = createBackup("manual");
      } catch (e) {
        sendJson(req, res, 500, { error: e.message });
        return;
      }
      sendJson(req, res, 200, { ok: true, files, backups: listBackups().slice(0, 30) });
      return;
    }

    if (pathname === "/api/portfolio" && req.method === "GET") {
      const data = await buildPortfolio();
      if (!data) {
        sendJson(req, res, 401, { error: "Нет авторизованного персонажа" });
        return;
      }
      sendJson(req, res, 200, data);
      return;
    }

    if (pathname === "/api/portfolio/refresh" && req.method === "POST") {
      portfolioCache = { ts: 0, data: null };
      const data = await buildPortfolio();
      sendJson(req, res, data ? 200 : 401, data || { error: "Нет авторизованного персонажа" });
      return;
    }

    if (pathname === "/api/compare" && req.method === "GET") {
      const typeId = Number(url.searchParams.get("type"));
      if (!typeId) {
        sendJson(req, res, 400, { error: "Нужен параметр type" });
        return;
      }
      const hit = compareCache.get(typeId);
      if (hit && Date.now() - hit.ts < 60_000) {
        sendJson(req, res, 200, hit.data);
        return;
      }
      const rows = [];
      for (const h of HUBS) {
        const q = await fetchQuotes({ stationId: h.stationId, regionId: h.regionId, typeIds: [typeId] });
        const v = q.get(typeId);
        rows.push({ hub: h.name, bid: v?.bid || 0, ask: v?.ask || 0 });
      }
      const data = { typeId, rows };
      compareCache.set(typeId, { ts: Date.now(), data });
      sendJson(req, res, 200, data);
      return;
    }

    if (pathname === "/api/esi/retry" && req.method === "POST") {
      esi.penaltyUntil = 0;
      await esi.probe();
      broadcast("esi", esi.status());
      sendJson(req, res, 200, esi.status());
      return;
    }

    if (pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 3000\n\n");
      sseClients.add(res);

      intel
        .snapshot()
        .then((snap) => {
          try {
            res.write(sseFormat("intel", snap));
          } catch {
            /* ignore */
          }
        })
        .catch(() => {});
      try {
        res.write(sseFormat("scan", publicScanState()));
      } catch {
        /* ignore */
      }

      req.on("close", () => {
        sseClients.delete(res);
      });
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
        esiStatus: esi.status(),
        version: pkg.version,
        ai: pkg.ai || null,
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

    if (pathname === "/api/notifier/alerts" && req.method === "GET") {
      const state = await intel.snapshot();
      const nowMs = Date.now();
      const items = [];

      for (const a of state.alerts || []) {
        const names = (a.names || []).map((n) => n.name).join(", ");
        items.push({
          id: `intel:${a.key}`,
          type: "intel",
          ts: a.ts,
          title: `Интел · ${a.jumps} пр.`,
          text: `${names}${a.extra ? ` +${a.extra}` : ""} — ${a.systemName || "?"}${
            a.regionName ? ` (${a.regionName})` : ""
          }${a.ship ? ` · ${a.ship}` : ""}${
            a.trend === "toward" ? " · движется к вам" : a.trend === "away" ? " · уходит" : ""
          }`,
          names: (a.names || []).map((n) => n.name),
          extra: a.extra || 0,
          system: a.systemName || null,
          region: a.regionName || null,
          jumps: a.jumps,
          ship: a.ship || null,
          trend: a.trend || null,
        });
      }

      for (const z of state.zkb || []) {
        items.push({
          id: `zkb:${z.key}`,
          type: "zkb",
          ts: Date.parse(z.time) || nowMs,
          title: `ZKB · ${z.isLoss ? "убит" : "убил"}`,
          text: `${z.name}${z.ship ? ` (${z.ship})` : ""} — ${z.systemName || "?"}${
            z.regionName ? ` (${z.regionName})` : ""
          } · ${z.jumps} пр.`,
          names: [z.name],
          extra: 0,
          system: z.systemName || null,
          region: z.regionName || null,
          jumps: z.jumps,
          ship: z.ship || null,
          isLoss: Boolean(z.isLoss),
        });
      }

      try {
        const pi = await buildPiOverview(false);
        for (const q of pi.queue || []) {
          if (q.status !== "expired" && q.status !== "critical") continue;
          items.push({
            id: `pi:${q.characterId}:${q.planetId}:${q.pinId}:${q.expiresAt}`,
            type: "pi",
            ts: q.expiresAt,
            title: `Планетарка · ${q.status === "expired" ? "остановлен" : "скоро остановится"}`,
            text: `${q.planetName}: ${q.productName} · ${q.characterName}`,
          });
        }
      } catch {
        /* планетарка не критична */
      }

      items.sort((a, b) => b.ts - a.ts);
      sendJson(req, res, 200, { now: nowMs, items: items.slice(0, 60) });
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

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Порт ${port} уже занят — возможно, сервер уже запущен: http://${host}:${port}`);
    process.exit(0);
  }
  throw err;
});

server.listen(port, host, () => {
  console.log(`EVE Flip Scanner: http://${host}:${port}`);
  console.log(`Callback URL для приложения EVE: ${auth.redirectUri()}`);
  if (process.env.OPEN_BROWSER === "1" && process.platform === "win32") {
    exec(`start "" "http://${host}:${port}"`);
  }
});
