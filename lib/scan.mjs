import { HUBS } from "./store.mjs";
import { flipQuote } from "./fees.mjs";
import { feesForLocation } from "./character.mjs";
import { withPage, buildQuery } from "./esi.mjs";

const MAX_LEVELS = 10;
const PAGE_BATCH = 6;
const HISTORY_BATCH = 2; // история у ESI фактически последовательная (~1.5 c/запрос)

/**
 * Собираем список локаций: включённые NPC-хабы + выбранные структуры.
 */
export function buildLocations(config, character) {
  const out = [];
  const seen = new Set();

  for (const hub of HUBS) {
    if (!config.hubs?.[hub.key]) continue;
    if (seen.has(hub.stationId)) continue;
    seen.add(hub.stationId);
    out.push({
      id: hub.stationId,
      name: hub.name,
      kind: "npc",
      hubKey: hub.key,
      regionId: hub.regionId,
      systemId: hub.systemId,
    });
  }

  for (const s of config.structures || []) {
    const id = Number(s.id);
    if (!id || seen.has(id)) continue;
    const known = (character?.structures || []).find((x) => Number(x.id) === id);
    seen.add(id);
    out.push({
      id,
      name: known?.name || s.name || `Structure ${id}`,
      kind: "structure",
      regionId: known?.regionId ?? s.regionId ?? null,
      systemId: known?.systemId ?? null,
      tax: Number(s.tax ?? known?.tax ?? config.defaultStructureTax ?? 0.01),
    });
  }

  return out;
}

function addLevel(levels, price, volume, minVolume, isBuy) {
  for (let i = 0; i < levels.length; i += 1) {
    if (levels[i].price === price) {
      levels[i].volume += volume;
      levels[i].orders += 1;
      return;
    }
  }
  levels.push({ price, volume, orders: 1, minVolume: Number(minVolume) || 0 });
  levels.sort(isBuy ? (a, b) => b.price - a.price : (a, b) => a.price - b.price);
  if (levels.length > MAX_LEVELS) levels.length = MAX_LEVELS;
}

const median = (arr) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

function histStats(rows) {
  if (!Array.isArray(rows)) return null;
  const valid = rows.filter((r) => Number(r.volume) > 0 && Number(r.average) > 0);
  if (valid.length < 3) return null;

  const last = valid[valid.length - 1];
  const last7 = valid.slice(-7);
  const last30 = valid.slice(-30);
  const last90 = valid.slice(-90);

  const vol7 = median(last7.map((r) => Number(r.volume)));
  const vol30 = median(last30.map((r) => Number(r.volume)));
  const totalVol30 = sum(last30.map((r) => Number(r.volume)));
  const vwap30 = totalVol30 > 0 ? sum(last30.map((r) => Number(r.average) * Number(r.volume))) / totalVol30 : 0;
  const mean30 = avg(last30.map((r) => Number(r.average)));
  const std30 = Math.sqrt(avg(last30.map((r) => (Number(r.average) - mean30) ** 2)));
  const min90 = Math.min(...last90.map((r) => Number(r.lowest || r.average)));
  const max90 = Math.max(...last90.map((r) => Number(r.highest || r.average)));

  return {
    price: Number(last.average),
    date: last.date,
    vol7,
    vol30,
    vwap30,
    mean30,
    std30,
    volatility: mean30 > 0 ? std30 / mean30 : 0,
    min90,
    max90,
    days: valid.length,
  };
}

export async function runScan({ esi, config, character, onStatus = () => {} }) {
  const status = {
    phase: "books",
    message: "Подготовка…",
    pagesDone: 0,
    pagesTotal: 0,
    typesDone: 0,
    typesTotal: 0,
    locations: 0,
    rows: 0,
    warnings: [],
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
  };
  const emit = () => onStatus(status);
  const warn = (msg) => {
    status.warnings.push(msg);
    emit();
  };

  const locations = buildLocations(config, character);
  if (!locations.length) throw new Error("Не выбрано ни одного хаба или структуры");
  status.locations = locations.length;
  const locById = new Map(locations.map((l) => [Number(l.id), l]));

  const books = new Map();
  const ingest = (orders) => {
    if (!Array.isArray(orders)) return;
    for (const o of orders) {
      const loc = Number(o.location_id);
      if (!locById.has(loc)) continue;
      const key = `${o.type_id}:${loc}`;
      let book = books.get(key);
      if (!book) {
        book = { typeId: o.type_id, locId: loc, buy: [], sell: [] };
        books.set(key, book);
      }
      addLevel(o.is_buy_order ? book.buy : book.sell, Number(o.price), Number(o.volume_remain), o.min_volume, o.is_buy_order);
    }
  };

  emit();

  // ---------- Фаза 1: стаканы ----------
  const npcRegions = [...new Set(locations.filter((l) => l.kind === "npc").map((l) => l.regionId))];

  for (const regionId of npcRegions) {
    status.message = `Стакан региона ${regionId}`;
    emit();
    const path = `/markets/${regionId}/orders/${buildQuery({ datasource: "tranquility", order_type: "all" })}`;
    try {
      const first = await esi.request(withPage(path, 1), { cache: false });
      const total = Math.min(Number(first.headers.get("x-pages") || 1) || 1, 2000);
      status.pagesTotal += total;
      ingest(first.body);
      status.pagesDone += 1;
      emit();

      for (let start = 2; start <= total; start += PAGE_BATCH) {
        const reqs = [];
        for (let p = start; p < Math.min(start + PAGE_BATCH, total + 1); p += 1) {
          reqs.push(esi.request(withPage(path, p), { cache: false }));
        }
        const settled = await Promise.allSettled(reqs);
        for (const r of settled) {
          if (r.status === "fulfilled") ingest(r.value.body);
          else warn(`Регион ${regionId}: страница не загрузилась (${r.reason?.status || "сеть"})`);
          status.pagesDone += 1;
        }
        emit();
      }
    } catch (err) {
      warn(`Регион ${regionId}: ${err.message}`);
    }
  }

  // ---------- Фаза 1b: структуры ----------
  for (const loc of locations.filter((l) => l.kind === "structure")) {
    if (!character?.characterId) {
      warn(`${loc.name}: нужна авторизация EVE — структура пропущена`);
      continue;
    }
    status.message = `Стакан структуры ${loc.name}`;
    emit();
    const path = `/markets/structures/${loc.id}/${buildQuery({ datasource: "tranquility" })}`;
    try {
      const first = await esi.request(withPage(path, 1), { auth: true, cache: false });
      const total = Math.min(Number(first.headers.get("x-pages") || 1) || 1, 2000);
      status.pagesTotal += total;
      ingest(first.body);
      status.pagesDone += 1;
      emit();

      for (let start = 2; start <= total; start += PAGE_BATCH) {
        const reqs = [];
        for (let p = start; p < Math.min(start + PAGE_BATCH, total + 1); p += 1) {
          reqs.push(esi.request(withPage(path, p), { auth: true, cache: false }));
        }
        const settled = await Promise.allSettled(reqs);
        for (const r of settled) {
          if (r.status === "fulfilled") ingest(r.value.body);
          else warn(`${loc.name}: страница не загрузилась`);
          status.pagesDone += 1;
        }
        emit();
      }
    } catch (err) {
      if (err.status === 403 || err.status === 404) warn(`${loc.name}: нет доступа к рынку структуры`);
      else warn(`${loc.name}: ${err.message}`);
    }
  }

  // ---------- Фаза 2: предварительный отбор ----------
  status.phase = "score";
  status.message = "Считаю спреды…";
  emit();

  const byLocation = new Map();
  const allCandidates = [];

  for (const book of books.values()) {
    if (!book.buy.length || !book.sell.length) continue;
    const loc = locById.get(Number(book.locId));
    if (!loc) continue;
    const bid = book.buy[0].price;
    const ask = book.sell[0].price;
    if (!(bid > 0) || !(ask > bid)) continue;
    const fee = feesForLocation(character, loc);
    const q = flipQuote({ bid, ask, tax: fee.tax, broker: fee.broker });
    if (q.profit <= 0) continue;
    // заведомо «мусорные» спреды на тонких стаканах не рассматриваем
    if (q.margin > 3) continue;
    // bid, сильно оторванный от ask, — это низовой «лоттер»-ордер, который не исполняется
    if (q.grossSpreadPct > 0.6) continue;

    const depthBid = book.buy[0].volume;
    const depthAsk = book.sell[0].volume;
    const depth = Math.min(depthBid, depthAsk);
    if (depth < 1) continue;

    const cand = {
      book,
      loc,
      fee,
      q,
      depth,
      depthBid,
      depthAsk,
      // приоритет — глубина стакана; маржа важна, но насыщается на 5%
      prescore: Math.log10(1 + Math.min(depth, 100_000)) * Math.min(1, q.margin / 0.05),
    };
    allCandidates.push(cand);
    if (!byLocation.has(loc.id)) byLocation.set(loc.id, []);
    byLocation.get(loc.id).push(cand);
  }

  // бюджет запросов истории: распределяем по локациям, чтобы каждый хаб был представлен
  const budget = Math.max(20, Number(config.historyBudget) || 200);
  const perLoc = Math.max(6, Math.ceil(budget / Math.max(1, byLocation.size)));
  const selected = [];
  for (const arr of byLocation.values()) {
    arr.sort((a, b) => b.prescore - a.prescore);
    selected.push(...arr.slice(0, perLoc));
  }

  // ---------- Фаза 3: история ----------
  status.phase = "history";
  status.message = "Загружаю историю цен…";
  status.typesTotal = selected.length;
  emit();

  const pairs = new Map();
  for (const c of selected) {
    if (!c.loc.regionId) continue;
    pairs.set(`${c.book.typeId}:${c.loc.regionId}`, { typeId: c.book.typeId, regionId: c.loc.regionId });
  }
  const history = new Map();

  const pairList = [...pairs.values()];
  for (let i = 0; i < pairList.length; i += HISTORY_BATCH) {
    const chunk = pairList.slice(i, i + HISTORY_BATCH);
    const settled = await Promise.allSettled(
      chunk.map(async (p) => {
        const path = `/markets/${p.regionId}/history/${buildQuery({ datasource: "tranquility", type_id: p.typeId })}`;
        const rows = await esi.get(path);
        return { key: `${p.typeId}:${p.regionId}`, stats: histStats(rows) };
      })
    );
    for (const r of settled) {
      status.typesDone += 1;
      if (r.status === "fulfilled" && r.value.stats) history.set(r.value.key, r.value.stats);
    }
    emit();
  }

  // ---------- Фаза 4: скоринг ----------
  status.phase = "score";
  status.message = "Считаю прибыль…";
  emit();

  const capture = Number(config.capture) || 0.5;
  const rows = [];
  let filtered = 0;

  for (const c of selected) {
    const { book, loc, fee, q } = c;
    const stats = history.get(`${book.typeId}:${loc.regionId}`);
    if (!stats) {
      filtered += 1;
      continue;
    }

    const bid = book.buy[0].price;
    const ask = book.sell[0].price;
    const fair = stats.vwap30;

    // Санитарные проверки: отсекаем «фейковые» спреды из устаревших/манипулятивных ордеров.
    if (!(fair > 0)) { filtered += 1; continue; }
    // buy-ордер должен быть в пределах 15% ниже VWAP, иначе он просто не исполнится
    if (bid < fair * 0.85 || bid > fair * 1.7) { filtered += 1; continue; }
    if (ask < fair * 0.5 || ask > fair * 2.0) { filtered += 1; continue; }
    if (ask > bid * 2.5) { filtered += 1; continue; }
    if (stats.vol7 < 2) { filtered += 1; continue; }

    // Консервативная цена выхода: продавать «в пустоту» по лучшему ask оптимистично,
    // реальные сделки идут около VWAP. Берём VWAP, зажатый между bid и ask.
    const exitPrice = Math.min(ask, Math.max(fair, bid * 1.0001));
    const qCons = flipQuote({ bid, ask: exitPrice, tax: fee.tax, broker: fee.broker });
    if (qCons.profit <= 0) { filtered += 1; continue; }

    const bestAsk = book.sell[0];
    const competition = Math.max(1, bestAsk.orders);
    const share = 1 / (1 + (competition - 1) * 0.7);
    const throughput = stats.vol7 * share * capture;
    const depth5 = book.sell.slice(0, 5).reduce((a, l) => a + l.volume, 0);
    const units = Math.max(0, Math.min(throughput, depth5));
    const iskDay = units * qCons.profit;
    const qty = Math.max(1, Math.round(units * 2));
    const capital = qty * qCons.buyCost;
    const roiDay = capital > 0 ? iskDay / capital : 0;
    const daysToSell = units > 0 ? qty / units : Infinity;
    const discountPct = fair > 0 ? 1 - ask / fair : 0;

    rows.push({
      key: `${book.typeId}:${loc.id}`,
      typeId: book.typeId,
      typeName: null,
      locationId: loc.id,
      locationName: loc.name,
      kind: loc.kind,
      regionId: loc.regionId,
      bid,
      bidVol: book.buy[0].volume,
      bidOrders: book.buy[0].orders,
      bidMinVol: book.buy[0].minVolume,
      ask,
      askVol: bestAsk.volume,
      askOrders: bestAsk.orders,
      exitPrice,
      spreadPct: q.grossSpreadPct,
      marginNet: qCons.margin,
      profitUnit: qCons.profit,
      breakEvenAsk: qCons.breakEvenAsk,
      marginBook: q.margin,
      profitBook: q.profit,
      volumeDay: stats.vol7,
      volumeDay30: stats.vol30,
      iskVolumeDay: stats.vol7 * stats.price,
      iskDay,
      capital,
      roiDay,
      daysToSell,
      fair,
      discountPct,
      volatility: stats.volatility,
      min90: stats.min90,
      max90: stats.max90,
      depthAsk: depth5,
      competition,
      tax: fee.tax,
      broker: fee.broker,
      updatedAt: new Date().toISOString(),
    });
  }

  // ---------- Фаза 5: названия ----------
  status.phase = "names";
  status.message = "Загружаю названия…";
  emit();

  const typeIds = [...new Set(rows.map((r) => r.typeId))];
  const nameMap = new Map();
  for (let i = 0; i < typeIds.length; i += 900) {
    const chunk = typeIds.slice(i, i + 900);
    try {
      const res = await esi.post("/universe/names/?datasource=tranquility", chunk);
      for (const n of res || []) nameMap.set(n.id, n);
    } catch (err) {
      warn(`Не удалось получить названия: ${err.message}`);
      break;
    }
  }
  for (const r of rows) {
    const n = nameMap.get(r.typeId);
    r.typeName = n?.name || `Type ${r.typeId}`;
    r.category = n?.category || null;
  }

  rows.sort((a, b) => b.iskDay - a.iskDay);

  status.phase = "done";
  status.message = `Готово: ${rows.length} позиций`;
  status.rows = rows.length;
  status.finishedAt = Date.now();
  emit();

  return {
    rows: rows.slice(0, 2000),
    books,
    meta: {
      generatedAt: new Date().toISOString(),
      durationMs: status.finishedAt - status.startedAt,
      pages: status.pagesDone,
      candidates: allCandidates.length,
      selected: selected.length,
      filtered,
      locations: locations.map((l) => {
        const fee = feesForLocation(character, l);
        return { id: l.id, name: l.name, kind: l.kind, regionId: l.regionId, tax: fee.tax, broker: fee.broker };
      }),
      warnings: status.warnings,
      historyTypes: history.size,
      capture,
      feesSource: character?.fees?.source || "default",
    },
  };
}
