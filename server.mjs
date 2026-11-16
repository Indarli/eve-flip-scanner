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
  loadCharacter,
  saveCharacter,
  loadResults,
  saveResults,
} from "./lib/store.mjs";
import { EsiClient } from "./lib/esi.mjs";
import { Auth } from "./lib/auth.mjs";
import { loadCharacter as fetchCharacter, emptyCharacterSummary, defaultFees } from "./lib/character.mjs";
import { runScan } from "./lib/scan.mjs";

initDirs();

let config = loadConfig();
const auth = new Auth({ getConfig: () => config });
const esi = new EsiClient({ cacheDir: CACHE_DIR, getToken: () => auth.token() });

let character = loadCharacter();
let currentResults = loadResults();
let lastBooks = new Map();
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

function publicScanState() {
  return {
    ...scanState,
    eta: estimateEta(scanState),
  };
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
  return {
    ...cfg,
    clientId: cfg.clientId || "",
  };
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
  const jobCharacter = character;

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
  const st = (character?.structures || []).find((s) => Number(s.id) === id);
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

  // Стакан берём из последнего скана (там есть и структуры), иначе — живьём из ESI.
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

  const fee = loc.kind === "structure"
    ? { tax: character?.fees?.tax ?? defaultFees().tax, broker: 0.005 + (loc.tax ?? config.defaultStructureTax ?? 0.01) }
    : (() => {
        const hubFee = Object.values(character?.fees?.hubs || {}).find((h) => h.stationId === loc.id);
        return { tax: character?.fees?.tax ?? defaultFees().tax, broker: hubFee?.broker ?? defaultFees().broker };
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
        await auth.finishLogin(code, state);
        character = await fetchCharacter({ esi, auth, config });
        saveCharacter(character);
        res.writeHead(302, { Location: "/?auth=ok" });
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
        character: character || null,
        scan: publicScanState(),
        resultsCount: currentResults?.rows?.length || 0,
        resultsMeta: currentResults?.meta || null,
        fees: character?.fees || { source: "default", tax: defaultFees().tax, broker: defaultFees().broker, hubs: {} },
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
            ? Math.min(1000, Math.max(20, Number(body.historyBudget) || 200))
            : config.historyBudget,
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
      auth.logout();
      character = null;
      saveCharacter(null);
      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/auth/status" && req.method === "GET") {
      sendJson(req, res, 200, { auth: auth.status(), character: character || null });
      return;
    }

    if (pathname === "/api/character/refresh" && req.method === "POST") {
      if (!auth.characterId()) {
        sendJson(req, res, 401, { error: "Нет авторизации" });
        return;
      }
      character = await fetchCharacter({ esi, auth, config });
      saveCharacter(character);
      sendJson(req, res, 200, { ok: true, character });
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
      const data = await itemDetail(typeId, locationId);
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
      let info = null;
      if (auth.characterId()) {
        info = await esi.get(`/universe/structures/${id}/`, { auth: true }).catch(() => null);
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

    if (pathname === "/api/stop" && req.method === "POST") {
      // мягкая остановка не поддерживается на уровне ESI-запросов; просто сообщаем
      sendJson(req, res, 200, { ok: true, note: "Текущий скан доработает до конца" });
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
