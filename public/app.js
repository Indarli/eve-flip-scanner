const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  cfg: null,
  hubs: [],
  auth: null,
  character: null,
  characters: [],
  rows: [],
  meta: null,
  sort: { key: "iskDay", dir: "desc" },
  filters: { search: "", margin: 2, volume: 10, maxPrice: 2e9, location: "", kind: "", onlyGood: true },
  poll: null,
  rowLimit: 400,
  pi: null,
  piFilter: "all",
  piTimer: null,
};

// ------------------------------------------------------------------ utils
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmt(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function isk(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(digits) + "T";
  if (a >= 1e9) return (v / 1e9).toFixed(digits) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(digits) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return v.toFixed(a < 10 ? 2 : 0);
}
function pct(x, digits = 1) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return "—";
  return (Number(x) * 100).toFixed(digits) + "%";
}
function toast(msg, isErr = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (isErr ? " err" : "");
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), 4200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// ------------------------------------------------------------------ tabs
function setTab(name, updateHash = true) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((s) => s.classList.toggle("active", s.id === `tab-${name}`));
  if (updateHash) history.replaceState({}, "", `#${name}`);
  if (name === "character") renderCharacter();
  if (name === "settings") renderSettings();
  if (name === "pi") loadPi();
}
$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (btn) setTab(btn.dataset.tab);
});

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    const cfg = await api("/api/config");
    applyConfig(cfg);
    await loadResults();
    renderAuth();
    renderCharacter();
    renderSettings();
    renderFilters();
    bindUI();
    const initialTab = location.hash.replace("#", "");
    if (["scan", "pi", "character", "settings"].includes(initialTab)) setTab(initialTab, false);
    if (state.cfg.scan?.running) pollScan();

    const params = new URLSearchParams(location.search);
    if (params.get("auth") === "ok") {
      toast("Авторизация успешна");
      history.replaceState({}, "", "/");
    } else if (params.get("auth") === "error") {
      toast("Ошибка авторизации: " + (params.get("message") || ""), true);
      history.replaceState({}, "", "/");
    }
  } catch (err) {
    toast("Не удалось загрузить конфигурацию: " + err.message, true);
  }
}

function applyConfig(cfg) {
  state.cfg = cfg.config;
  state.hubs = cfg.hubs;
  state.auth = cfg.auth;
  state.character = cfg.character;
  state.characters = cfg.characters || [];
  state.scan = cfg.scan;
  state.resultsMeta = cfg.resultsMeta;
  $("#capture").value = state.cfg.capture;
  $("#captureVal").textContent = Number(state.cfg.capture).toFixed(2);
  $("#callbackUrl").textContent = state.auth.redirectUri;
  $("#clientId").value = state.cfg.clientId || "";
  $("#defTax").value = (Number(state.cfg.defaultStructureTax || 0.01) * 100).toFixed(1);
  $("#defMargin").value = (Number(state.cfg.filters.minMargin || 0.02) * 100).toFixed(1);
  $("#defVolume").value = state.cfg.filters.minVolume ?? 20;
  $("#clientStatus").textContent = state.cfg.clientId ? "Client ID сохранён" : "Client ID не задан";
  if (cfg.esiStats) renderDiag(cfg.esiStats);
}

async function loadResults() {
  const r = await api("/api/results");
  state.rows = r.rows || [];
  state.meta = r.meta || null;
  renderFilters();
  renderTable();
  renderMeta();
}

// ------------------------------------------------------------------ auth
function renderAuth() {
  const box = $("#authbox");
  const chars = state.characters || [];
  if (chars.length) {
    const total = chars.reduce((a, c) => a + (c.wallet || 0), 0);
    const label = chars.length === 1 ? esc(chars[0].name || "пилот") : `${chars.length} персонажа`;
    box.innerHTML = `
      <div class="char"><span class="dot"></span><span>${label}</span>
        <span class="muted mono">${isk(total)} ISK</span></div>
      <button class="btn small" id="btnAddCharTop" title="Добавить персонажа">+</button>
      <button class="btn small" id="btnLogout">Выйти</button>`;
    $("#btnAddCharTop").onclick = addCharacter;
    $("#btnLogout").onclick = async () => {
      if (!confirm("Выйти из всех персонажей?")) return;
      await api("/api/auth/logout", { method: "POST" });
      location.reload();
    };
  } else {
    box.innerHTML = `<span class="muted">не авторизован</span><button class="btn small" id="btnLogin">Войти через EVE</button>`;
    $("#btnLogin").onclick = addCharacter;
  }
}

function addCharacter() {
  if (!state.cfg?.clientId) {
    setTab("settings");
    toast("Сначала укажите Client ID в настройках", true);
    return;
  }
  location.href = "/api/auth/login";
}

// ------------------------------------------------------------------ scan
async function startScan() {
  $("#btnScan").disabled = true;
  try {
    await api("/api/scan", { method: "POST" });
    $("#progress").hidden = false;
    pollScan();
  } catch (err) {
    $("#btnScan").disabled = false;
    toast(err.message, true);
  }
}

function pollScan() {
  clearInterval(state.poll);
  $("#progress").hidden = false;
  const tick = async () => {
    try {
      const { scan } = await api("/api/scan/status");
      renderScan(scan);
      if (!scan.running && scan.phase !== "idle") {
        clearInterval(state.poll);
        $("#btnScan").disabled = false;
        if (scan.phase === "done") {
          await loadResults();
          toast(`Скан завершён: ${scan.rows} позиций`);
        } else if (scan.phase === "error") {
          toast("Ошибка скана: " + scan.message, true);
        }
        setTimeout(() => ($("#progress").hidden = true), 2500);
      }
    } catch (err) {
      clearInterval(state.poll);
      $("#btnScan").disabled = false;
    }
  };
  tick();
  state.poll = setInterval(tick, 800);
}

function renderScan(scan) {
  if (!scan) return;
  const el = $("#scanmeta");
  let p = 0;
  if (scan.phase === "books") p = scan.pagesTotal ? (scan.pagesDone / scan.pagesTotal) * 70 : 2;
  else if (scan.phase === "history") p = 70 + (scan.typesTotal ? (scan.typesDone / scan.typesTotal) * 25 : 0);
  else if (scan.phase === "score") p = 92;
  else if (scan.phase === "names") p = 97;
  else if (scan.phase === "done") p = 100;
  $("#progressFill").style.width = Math.min(100, p) + "%";
  let text = scan.message || "";
  if (scan.phase === "books" && scan.pagesTotal) text += ` · ${scan.pagesDone}/${scan.pagesTotal} стр.`;
  if (scan.phase === "history" && scan.typesTotal) text += ` · ${scan.typesDone}/${scan.typesTotal}`;
  if (scan.running && scan.eta) text += ` · ~${scan.eta}s`;
  $("#progressText").textContent = text;
  if (!scan.running && scan.phase === "idle") $("#progress").hidden = true;
}

function renderMeta() {
  const m = state.meta;
  const el = $("#scanmeta");
  if (!m) {
    el.textContent = "";
    return;
  }
  const ago = Math.round((Date.now() - Date.parse(m.generatedAt)) / 60000);
  const parts = [
    `${m.rows ?? state.rows.length} позиций`,
    `${m.pages} стр.`,
    `${(m.durationMs / 1000).toFixed(0)} c`,
    ago < 1 ? "только что" : `${ago} мин назад`,
    m.feesSource === "character" ? "комиссии: персонаж" : "комиссии: оценка",
  ];
  el.innerHTML = parts.join(" · ") + (m.warnings?.length ? ` · <span class="badge warn">${m.warnings.length} предупр.</span>` : "");
  if (m.warnings?.length) el.title = m.warnings.join("\n");
}

// ------------------------------------------------------------------ table
function renderFilters() {
  const sel = $("#fLocation");
  const prev = sel.value;
  const locs = state.meta?.locations || [];
  sel.innerHTML = `<option value="">Все локации</option>` + locs.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join("");
  if (prev && locs.some((l) => String(l.id) === String(prev))) sel.value = prev;
}

function visibleRows() {
  const f = state.filters;
  const q = f.search.trim().toLowerCase();
  let rows = state.rows.filter((r) => {
    if (f.onlyGood && !(r.iskDay > 0)) return false;
    if (r.marginNet * 100 < f.margin) return false;
    if (r.volumeDay < f.volume) return false;
    if (r.ask > f.maxPrice) return false;
    if (f.location && String(r.locationId) !== f.location) return false;
    if (f.kind && r.kind !== f.kind) return false;
    if (q && !String(r.typeName || "").toLowerCase().includes(q) && !String(r.locationName).toLowerCase().includes(q)) return false;
    return true;
  });
  const { key, dir } = state.sort;
  const mul = dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === "string" || typeof bv === "string") return String(av ?? "").localeCompare(String(bv ?? ""), "ru") * mul;
    return ((av ?? 0) - (bv ?? 0)) * mul;
  });
  return rows;
}

function marginBadge(m) {
  const v = m * 100;
  const cls = v >= 8 ? "good" : v >= 3 ? "warn" : "bad";
  return `<span class="badge ${cls}">${v.toFixed(1)}%</span>`;
}

function renderTable() {
  const rows = visibleRows();
  const tbody = $("#tbody");
  $("#fCount").textContent = `${rows.length} из ${state.rows.length}`;
  $("#empty").hidden = rows.length > 0;
  $("#tbl").style.display = rows.length ? "" : "none";

  const slice = rows.slice(0, state.rowLimit);
  tbody.innerHTML = slice
    .map(
      (r) => `
    <tr data-key="${r.key}">
      <td class="left">
        <div class="item-name">${esc(r.typeName)}</div>
        <div class="item-cat">${esc(r.category || "")}</div>
      </td>
      <td class="left">
        <span class="loc-name">${esc(r.locationName)}</span>
        <span class="loc-kind ${r.kind}">${r.kind === "structure" ? "struct" : "hub"}</span>
      </td>
      <td class="num">${isk(r.bid)}</td>
      <td class="num">${isk(r.ask)}</td>
      <td class="num muted">${pct(r.spreadPct)}</td>
      <td class="num">${marginBadge(r.marginNet)}</td>
      <td class="num">${isk(r.profitUnit)}</td>
      <td class="num">${fmt(r.volumeDay, 0)}</td>
      <td class="num">${isk(r.iskDay)}</td>
      <td class="num muted">${pct(r.roiDay)}</td>
      <td class="num muted">${Number.isFinite(r.daysToSell) ? r.daysToSell.toFixed(1) + "д" : "—"}</td>
      <td class="num muted">${r.competition}</td>
      <td class="num">${isk(r.capital)}</td>
    </tr>`
    )
    .join("");

  $$("#tbl thead th").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === state.sort.key);
    th.classList.toggle("asc", th.dataset.sort === state.sort.key && state.sort.dir === "asc");
  });
}

// ------------------------------------------------------------------ drawer
async function openItem(key) {
  const row = state.rows.find((r) => r.key === key);
  if (!row) return;
  $("#drawer").hidden = false;
  $("#backdrop").hidden = false;
  $("#drawerBody").innerHTML = `<div class="muted">Загружаю стакан…</div>`;

  let detail = null;
  try {
    detail = await api(`/api/item?type=${row.typeId}&loc=${row.locationId}`);
  } catch (err) {
    $("#drawerBody").innerHTML = `<div class="muted">Не удалось загрузить детали: ${esc(err.message)}</div>`;
    return;
  }

  const d = detail;
  const qty = row.profitUnit > 0 ? Math.max(1, Math.round(row.capital / (row.bid * (1 + row.broker)))) : 0;
  const feeTotal = row.tax + row.broker;

  const ladder = (levels, side) => {
    const maxVol = Math.max(1, ...levels.map((l) => l.volume));
    return levels
      .slice(0, 8)
      .map(
        (l) => `<tr>
          <td>${isk(l.price, 4)}</td>
          <td class="num">${fmt(l.volume)}</td>
          <td class="num muted">${l.orders}</td>
          <td class="bar-cell"><div class="mini-bar"><i style="width:${Math.max(4, (l.volume / maxVol) * 100)}%"></i></div></td>
        </tr>`
      )
      .join("");
  };

  $("#drawerBody").innerHTML = `
    <h2>${esc(row.typeName)}</h2>
    <div class="sub">${esc(row.locationName)} · ${row.kind === "structure" ? "структура" : "NPC-хаб"} · type ${row.typeId}
      ${d.type?.volume ? ` · ${d.type.volume} м³` : ""}${d.type?.groupName ? ` · ${esc(d.type.groupName)}` : ""}</div>

    <div class="kv">
      <div class="k">Buy / Sell</div><div class="v">${isk(row.bid)} / ${isk(row.ask)}</div>
      <div class="k">Спред (грязный)</div><div class="v">${pct(row.spreadPct)}</div>
      <div class="k">Нетто (консервативно)</div><div class="v">${pct(row.marginNet)}</div>
      <div class="k">Нетто по стакану (оптимист.)</div><div class="v muted">${pct(row.marginBook)}</div>
      <div class="k">Расчётная цена выхода</div><div class="v">${isk(row.exitPrice, 4)}</div>
      <div class="k">Прибыль на единицу</div><div class="v">${isk(row.profitUnit)}</div>
      <div class="k">Порог безубыточности</div><div class="v">${isk(row.breakEvenAsk)}</div>
      <div class="k">Комиссии (налог + брокер)</div><div class="v">${pct(row.tax, 2)} + ${pct(row.broker, 2)}</div>
      <div class="k">Объём/день (регион)</div><div class="v">${fmt(row.volumeDay)} шт · ${isk(row.iskVolumeDay)} ISK</div>
      <div class="k">Глубина sell (5 уровней)</div><div class="v">${fmt(row.depthAsk)} шт</div>
      <div class="k">Конкуренция у лучшей цены</div><div class="v">${row.competition} орд.</div>
      <div class="k">Волатильность (30д)</div><div class="v">${pct(row.volatility)}</div>
      <div class="k">Средняя 30д (VWAP)</div><div class="v">${isk(row.fair, 4)}</div>
      <div class="k">Отклонение ask от VWAP</div><div class="v">${pct(row.discountPct)}</div>
    </div>

    <div class="ladder">
      <div class="buy"><h4>Buy-ордера</h4>
        <table>${ladder(d.book.buy, "buy")}</table></div>
      <div class="sell"><h4>Sell-ордера</h4>
        <table>${ladder(d.book.sell, "sell")}</table></div>
    </div>

    <div class="chart-box">
      <canvas id="chart"></canvas>
      <div class="chart-legend"><span><i style="background:#48c9f0"></i>средняя цена</span><span><i style="background:rgba(120,165,225,.35)"></i>объём</span></div>
    </div>

    <div class="note">
      <b>План:</b> buy-ордер на ${isk(row.bid)}, sell-ордер на ${isk(row.ask)} (расчёт выхода — ${isk(row.exitPrice)}).
      Примерно ${fmt(qty)} шт, вложение ${isk(row.capital)} ISK,
      ожидаемо ${isk(row.iskDay)} ISK/день при обороте ~${Number.isFinite(row.daysToSell) ? row.daysToSell.toFixed(1) : "—"} дн.
      <br>Чтобы просто выйти в ноль, средняя цена продажи должна быть не ниже ${isk(row.breakEvenAsk)}.
    </div>
  `;

  drawChart($("#chart"), d.history);
}

function closeDrawer() {
  $("#drawer").hidden = true;
  $("#backdrop").hidden = true;
}

function drawChart(canvas, history) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 500;
  const h = canvas.clientHeight || 200;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const data = (history || []).filter((d) => Number(d.average) > 0);
  if (data.length < 2) {
    ctx.fillStyle = "#7f90ab";
    ctx.font = "12px monospace";
    ctx.fillText("нет истории", 12, h / 2);
    return;
  }

  const pad = { l: 6, r: 6, t: 12, b: 16 };
  const prices = data.map((d) => Number(d.average));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || max * 0.01 || 1;
  const x = (i) => pad.l + (i / (data.length - 1)) * (w - pad.l - pad.r);
  const y = (p) => pad.t + (1 - (p - min) / span) * (h - pad.t - pad.b);

  const maxVol = Math.max(1, ...data.map((d) => Number(d.volume) || 0));
  ctx.fillStyle = "rgba(120,165,225,.12)";
  data.forEach((d, i) => {
    const bh = ((Number(d.volume) || 0) / maxVol) * (h * 0.16);
    ctx.fillRect(x(i) - 1, h - pad.b - bh, 2, bh);
  });

  const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, "rgba(72,201,240,.22)");
  grad.addColorStop(1, "rgba(72,201,240,0)");

  ctx.beginPath();
  data.forEach((d, i) => (i ? ctx.lineTo(x(i), y(Number(d.average))) : ctx.moveTo(x(i), y(Number(d.average)))));
  ctx.strokeStyle = "#48c9f0";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.lineTo(x(data.length - 1), h - pad.b);
  ctx.lineTo(x(0), h - pad.b);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.fillStyle = "#7f90ab";
  ctx.font = "10px monospace";
  ctx.fillText(isk(max, 2), pad.l, 10);
  ctx.fillText(isk(min, 2), pad.l, h - 4);
  ctx.textAlign = "right";
  ctx.fillText(isk(prices[prices.length - 1], 2), w - pad.r, 10);
  ctx.textAlign = "left";
}

// ------------------------------------------------------------------ character
const card = (label, value, sub = "") =>
  `<div class="card"><div class="card-label">${esc(label)}</div><div class="card-value mono">${value}</div>${
    sub ? `<div class="muted small">${sub}</div>` : ""
  }</div>`;

function renderCharacter() {
  const chars = state.characters || [];
  const primary = state.character;
  $("#charEmpty").hidden = chars.length > 0;
  $("#charContent").hidden = chars.length === 0;
  if (!chars.length) return;

  const totalWallet = chars.reduce((a, c) => a + (c.wallet || 0), 0);
  const totalColonies = chars.reduce((a, c) => a + (c.colonies || 0), 0);
  $("#charCards").innerHTML = [
    card("Персонажей", chars.length),
    card("Кошелёк", isk(totalWallet) + " ISK"),
    card("Колоний", totalColonies),
    card("Основной", esc(primary?.name || "—")),
  ].join("");

  $("#charList").innerHTML = chars
    .map(
      (c) => `<div class="struct-row">
        <span class="name">${esc(c.name)} ${
        primary && primary.characterId === c.characterId ? '<span class="badge dim">основной</span>' : ""
      }</span>
        <span class="meta">${isk(c.wallet)} ISK</span>
        <span class="meta">${c.colonies || 0} колоний</span>
        <button class="btn tiny" data-primary="${c.characterId}" ${
        primary && primary.characterId === c.characterId ? "disabled" : ""
      }>сделать основным</button>
        <button class="btn tiny" data-logout="${c.characterId}">выйти</button>
      </div>`
    )
    .join("");

  if (!primary) return;

  const lv = primary.skills.levels || {};
  const skillRows = [
    ["Accounting", lv.accounting, "налог"],
    ["Broker Relations", lv.brokerRelations, "брокер"],
    ["Advanced Broker Relations", lv.advancedBrokerRelations, "relist"],
    ["Trade", lv.trade, "+4 слота"],
    ["Retail", lv.retail, "+8 слотов"],
    ["Wholesale", lv.wholesale, "+16 слотов"],
    ["Tycoon", lv.tycoon, "+32 слота"],
    ["Marketing", lv.marketing, "удалённые sell"],
    ["Procurement", lv.procurement, "удалённые buy"],
    ["Daytrading", lv.daytrading, "управление"],
  ];
  $("#skillTable").innerHTML =
    `<tr><th>Навык</th><th>Уровень</th><th>Эффект</th></tr>` +
    skillRows
      .map(([n, v, e]) => `<tr><td>${esc(n)}</td><td class="num">${v ?? 0}</td><td class="muted">${esc(e)}</td></tr>`)
      .join("");

  const hubs = Object.entries(primary.fees.hubs || {});
  $("#hubFeeTable").innerHTML =
    `<tr><th>Хаб</th><th>Broker</th><th>Стендинги</th></tr>` +
    hubs
      .map(
        ([k, h]) =>
          `<tr><td>${esc(h.stationName || k)}</td><td class="num">${pct(h.broker, 2)}</td>
           <td class="muted">${(h.factionStanding ?? 0).toFixed(1)} / ${(h.corpStanding ?? 0).toFixed(1)}</td></tr>`
      )
      .join("");

  const structs = primary.structures || [];
  $("#structureList").innerHTML = structs.length
    ? structs
        .map((s) => {
          const enabled = (state.cfg.structures || []).some((x) => Number(x.id) === Number(s.id));
          return `<div class="struct-row">
            <span class="name">${esc(s.name)}</span>
            <span class="meta">${s.id}</span>
            <span class="meta">broker ${pct(s.broker, 2)}</span>
            <button class="btn tiny" data-add-struct="${s.id}" data-tax="${s.tax}" ${enabled ? "disabled" : ""}>
              ${enabled ? "в скане" : "добавить в скан"}</button>
          </div>`;
        })
        .join("")
    : `<div class="muted small">Структуры не найдены. Они появляются, если у персонажа есть там ордера или ассеты.</div>`;
}

// ------------------------------------------------------------------ планетарка
const PIN_COLORS = {
  extractor: "#ff9f43",
  factory: "#4cc9f0",
  storage: "#7c6cff",
  spaceport: "#38d68b",
  command: "#f2cd7c",
  other: "#8fa3bf",
};
const PIN_LABELS = {
  extractor: "экстрактор",
  factory: "фабрика",
  storage: "склад",
  spaceport: "космопорт",
  command: "командный центр",
  other: "другое",
};
const STATUS_LABELS = { expired: "остановлен", critical: "вот-вот", soon: "скоро", ok: "работает", unknown: "нет данных" };

function fmtLeft(ms) {
  if (ms === null || ms === undefined) return "—";
  if (ms <= 0) return "остановлен";
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${String(m).padStart(2, "0")}м`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function piDoneKey(e) {
  return `${e.characterId}:${e.planetId}:${e.pinId}`;
}
function piDoneSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem("eveflip.pi.done") || "[]"));
  } catch {
    return new Set();
  }
}
function piDoneSave(set) {
  localStorage.setItem("eveflip.pi.done", JSON.stringify([...set].slice(-2000)));
}

async function loadPi(force = false) {
  if (!(state.characters || []).length) {
    state.pi = null;
    renderPi();
    return;
  }
  $("#piMeta").textContent = "загружаю…";
  try {
    const data = await api(`/api/pi/overview${force ? "?refresh=1" : ""}`);
    state.pi = data;
    renderPi();
  } catch (e) {
    $("#piMeta").textContent = "";
    toast("Планетарка: " + e.message, true);
  }
}

function renderPi() {
  const pi = state.pi;
  const colonies = pi?.colonies || [];
  const has = colonies.length > 0;
  const warnings = pi?.warnings || [];
  $("#piEmpty").hidden = has;
  $("#piContent").hidden = !has;
  if (!has) {
    $("#piMeta").textContent = pi ? (warnings.length ? "нужен доступ" : "колоний нет") : "";
    $("#piEmpty").innerHTML = `
      <div class="empty-icon">◍</div>
      <div>${warnings.length ? esc(warnings[0]) : "Колоний не найдено."}</div>
      <div class="muted small">${
        warnings.length
          ? "Выдайте приложению доступ к планетарке: «+ персонаж» → вход тем же персонажем."
          : "Войдите через EVE и нажмите «Обновить»."
      }</div>
      <div style="margin-top:12px"><button class="btn" id="btnPiRelogin">Переавторизоваться</button></div>`;
    $("#btnPiRelogin").onclick = addCharacter;
    return;
  }
  renderPiChars();
  renderPiCards();
  renderPiTable();
  renderPiQueue();
  $("#piMeta").textContent = `${colonies.length} колоний · ${new Date(pi.generatedAt).toLocaleTimeString("ru-RU")}${
    warnings.length ? ` · ⚠ ${warnings.length}` : ""
  }`;
  $("#piMeta").title = warnings.join("\n");
  startPiTimer();
  notifyExpiring();
}

function notifyExpiring() {
  if (localStorage.getItem("eveflip.notify") !== "1") return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const queue = state.pi?.queue || [];
  let seen;
  try {
    seen = new Set(JSON.parse(localStorage.getItem("eveflip.pi.notified") || "[]"));
  } catch {
    seen = new Set();
  }
  let changed = false;
  for (const e of queue) {
    if (e.status !== "critical" && e.status !== "expired") continue;
    const id = `${e.characterId}:${e.planetId}:${e.pinId}:${e.expiresAt}`;
    if (seen.has(id)) continue;
    seen.add(id);
    changed = true;
    try {
      new Notification("Экстрактор остановился", {
        body: `${e.planetName || "планета"}: ${e.productName || "продукт"} (${e.characterName || ""})`,
      });
    } catch {
      /* ignore */
    }
  }
  if (changed) localStorage.setItem("eveflip.pi.notified", JSON.stringify([...seen].slice(-1000)));
}

function renderPiChars() {
  const colonies = state.pi?.colonies || [];
  const chars = state.pi?.characters || [];
  const counts = new Map();
  for (const c of colonies) counts.set(c.characterId, (counts.get(c.characterId) || 0) + 1);
  const all = `<button class="chip ${state.piFilter === "all" ? "active" : ""}" data-pichar="all">Все <span class="count">${colonies.length}</span></button>`;
  const items = chars
    .map(
      (c) =>
        `<button class="chip ${String(state.piFilter) === String(c.characterId) ? "active" : ""}" data-pichar="${c.characterId}">${esc(
          c.name
        )} <span class="count">${counts.get(c.characterId) || 0}</span></button>`
    )
    .join("");
  $("#piChars").innerHTML = all + items;
}

function renderPiCards() {
  const t = state.pi.totals;
  const attention = (t.expired || 0) + (t.critical || 0);
  $("#piCards").innerHTML = [
    card("Колонии", t.colonies, `${t.extractors} экстракторов`),
    card("Требуют внимания", attention, `остановлено: ${t.expired}, вот-вот: ${t.critical}`),
    card("ISK/час", isk(t.iskPerHour), `≈ ${isk(t.iskPerDay)} ISK/день`),
    card("На складах", isk(t.contentsValue) + " ISK", "оценка по текущим ценам"),
  ].join("");
}

function renderPiTable() {
  const colonies = (state.pi?.colonies || []).filter(
    (c) => state.piFilter === "all" || String(c.characterId) === String(state.piFilter)
  );
  colonies.sort((a, b) => (a.extractors[0]?.expiresAt || Infinity) - (b.extractors[0]?.expiresAt || Infinity));

  $("#piTableBody").innerHTML = colonies
    .map((c) => {
      const nearest = c.extractors[0]?.expiresAt || null;
      const qty = c.extractors.reduce((a, e) => a + (e.qtyPerHour || 0), 0);
      const worst = c.totals.expired ? "expired" : c.totals.critical ? "critical" : c.totals.soon ? "soon" : "ok";
      return `<tr data-colony="${c.characterId}:${c.planetId}">
        <td class="left"><div class="planet-name">${esc(c.planetName || "Планета " + c.planetId)}</div>
          <div class="planet-sub">${c.numPins} пинов · ур. ${c.upgradeLevel}</div></td>
        <td class="left muted">${esc(c.planetType)}</td>
        <td class="left">${esc(c.systemName || c.systemId)}</td>
        <td class="left">${esc(c.characterName || c.characterId)}</td>
        <td class="num">${c.totals.extractorCount}</td>
        <td class="num"><span class="countdown" data-expires="${nearest || ""}">${nearest ? fmtLeft(nearest - Date.now()) : "—"}</span></td>
        <td class="num">${fmt(qty, 0)}</td>
        <td class="num">${isk(c.totals.iskPerHour)}</td>
        <td class="left"><span class="status ${worst}">${STATUS_LABELS[worst]}</span></td>
      </tr>`;
    })
    .join("");
}

function renderPiQueue() {
  const queue = (state.pi?.queue || []).filter(
    (e) => state.piFilter === "all" || String(e.characterId) === String(state.piFilter)
  );
  const done = piDoneSet();
  const rows = queue.slice(0, 60);
  $("#piQueue").innerHTML = rows.length
    ? rows
        .map((e) => {
          const key = piDoneKey(e);
          const isDone = done.has(key);
          return `<div class="pi-row ${isDone ? "done" : ""}" data-row="${key}">
            <input type="checkbox" data-pidone="${key}" ${isDone ? "checked" : ""}>
            <div>
              <div class="name">${esc(e.productName || "продукт")} · ${esc(e.planetName || "планета")}</div>
              <div class="sub">${esc(e.characterName || "")} · ${esc(e.systemName || "")} · ${e.heads || 0} голов ·
                ${fmt(e.qtyPerHour, 0)} шт/ч · ${isk(e.iskPerHour)} ISK/ч</div>
            </div>
            <span class="status ${e.status}">${STATUS_LABELS[e.status] || e.status}</span>
            <span class="countdown" data-expires="${e.expiresAt}">${fmtLeft(e.msLeft)}</span>
            <button class="btn tiny" data-pimap="${e.characterId}:${e.planetId}">карта</button>
          </div>`;
        })
        .join("")
    : `<div class="muted small">Активных экстракторов нет.</div>`;
}

function startPiTimer() {
  clearInterval(state.piTimer);
  updateCountdowns();
  state.piTimer = setInterval(updateCountdowns, 1000);
}

function updateCountdowns() {
  for (const el of $$(".countdown[data-expires]")) {
    const ts = Number(el.dataset.expires);
    if (!ts) continue;
    el.textContent = fmtLeft(ts - Date.now());
  }
}

function openColony(characterId, planetId) {
  const c = (state.pi?.colonies || []).find(
    (x) => String(x.characterId) === String(characterId) && String(x.planetId) === String(planetId)
  );
  if (!c) return;

  $("#drawer").hidden = false;
  $("#backdrop").hidden = false;
  $("#drawerBody").innerHTML = `
    <h2>${esc(c.planetName || "Планета " + c.planetId)}</h2>
    <div class="sub">${esc(c.planetType)} · ${esc(c.systemName || c.systemId)} · ${esc(c.characterName || "")} ·
      ур. ${c.upgradeLevel} · ${c.numPins} пинов</div>

    <div class="cards" style="grid-template-columns:repeat(3,1fr)">
      ${card("Экстракторы", c.totals.extractorCount, `остановлено ${c.totals.expired}`)}
      ${card("ISK/час", isk(c.totals.iskPerHour), `≈ ${isk(c.totals.iskPerDay)}/день`)}
      ${card("На складах", isk(c.totals.contentsValue))}
    </div>

    <div class="planet-wrap">
      <canvas class="planet-canvas" id="planetCanvas"></canvas>
      <div class="pin-legend">
        ${Object.entries(PIN_LABELS)
          .map(([k, v]) => `<span><i style="background:${PIN_COLORS[k]}"></i>${v}</span>`)
          .join("")}
      </div>
    </div>

    <h3 style="margin:18px 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">Экстракторы</h3>
    <div class="pi-queue">
      ${
        c.extractors.length
          ? c.extractors
              .map(
                (e) => `<div class="pi-row">
                  <span class="status ${e.status}">${STATUS_LABELS[e.status] || e.status}</span>
                  <div><div class="name">${esc(e.productName || "продукт")}</div>
                    <div class="sub">${e.heads} голов · ${fmt(e.qtyPerHour, 0)} шт/ч · ${isk(e.iskPerHour)} ISK/ч</div></div>
                  <span class="countdown" data-expires="${e.expiresAt}">${fmtLeft(e.msLeft)}</span>
                  <span></span>
                </div>`
              )
              .join("")
          : `<div class="muted small">Экстракторов нет.</div>`
      }
    </div>

    ${
      c.factories.length
        ? `<h3 style="margin:18px 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">Фабрики</h3>
           <div class="pi-queue">${c.factories
             .map(
               (f) => `<div class="pi-row"><span class="status ok">схема</span>
                 <div><div class="name">${esc(f.schematicName || "Схема " + f.schematicId)}</div>
                 <div class="sub">цикл ${f.cycleTime ? Math.round(f.cycleTime / 60) + " мин" : "—"}</div></div><span></span><span></span></div>`
             )
             .join("")}</div>`
        : ""
    }

    <div class="note">
      <b>Перезапуск:</b> ESI не предоставляет операций записи для планетарки — перезапустить экстрактор из приложения нельзя.
      Откройте колонию в игре, выберите Extractor Control Unit и нажмите Restart. Таймеры здесь — чтобы не забыть.
    </div>
  `;

  drawPlanet($("#planetCanvas"), c);
  startPiTimer();
}

function projectPins(pins) {
  const vec = pins.map((p) => {
    const lat = ((p.lat || 0) * Math.PI) / 180;
    const lon = ((p.lon || 0) * Math.PI) / 180;
    return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  });
  let c = [0, 0, 0];
  for (const v of vec) {
    c[0] += v[0];
    c[1] += v[1];
    c[2] += v[2];
  }
  const len = Math.hypot(c[0], c[1], c[2]) || 1;
  c = [c[0] / len, c[1] / len, c[2] / len];

  let right = [c[1] * 1 - c[2] * 0, c[2] * 0 - c[0] * 1, c[0] * 0 - c[1] * 0];
  right = [c[1], -c[0], 0];
  const rl = Math.hypot(right[0], right[1], right[2]);
  if (rl < 1e-6) right = [1, 0, 0];
  else right = [right[0] / rl, right[1] / rl, right[2] / rl];
  const up = [c[1] * right[2] - c[2] * right[1], c[2] * right[0] - c[0] * right[2], c[0] * right[1] - c[1] * right[0]];

  return pins.map((p, i) => ({
    pin: p,
    x: vec[i][0] * right[0] + vec[i][1] * right[1] + vec[i][2] * right[2],
    y: vec[i][0] * up[0] + vec[i][1] * up[1] + vec[i][2] * up[2],
    z: vec[i][0] * c[0] + vec[i][1] * c[1] + vec[i][2] * c[2],
  }));
}

function drawPlanet(canvas, colony) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 460;
  const h = canvas.clientHeight || 360;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 16;

  const grad = ctx.createRadialGradient(cx - R * 0.4, cy - R * 0.4, R * 0.1, cx, cy, R);
  grad.addColorStop(0, "#1b3a52");
  grad.addColorStop(0.6, "#0d1b28");
  grad.addColorStop(1, "#050a10");
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = "rgba(120,165,225,.25)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // сетка
  ctx.strokeStyle = "rgba(120,165,225,.10)";
  for (let lat = -60; lat <= 60; lat += 30) {
    const rr = R * Math.cos((lat * Math.PI) / 180);
    const yy = cy - R * Math.sin((lat * Math.PI) / 180);
    ctx.beginPath();
    ctx.ellipse(cx, yy, Math.max(2, rr), Math.max(1, rr * 0.18), 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let lon = 0; lon < 180; lon += 45) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.abs(R * Math.cos((lon * Math.PI) / 180)) + 1, R, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  const pts = projectPins(colony.pins || []);
  const scale = (p) => ({ x: cx + p.x * R, y: cy - p.y * R, z: p.z });

  // связи
  ctx.lineWidth = 1;
  for (const l of colony.links || []) {
    const a = pts.find((p) => p.pin.id === l.source_pin_id);
    const b = pts.find((p) => p.pin.id === l.destination_pin_id);
    if (!a || !b || a.z < -0.2 || b.z < -0.2) continue;
    const pa = scale(a);
    const pb = scale(b);
    ctx.strokeStyle = "rgba(120,165,225,.22)";
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  // маршруты
  for (const r of colony.routes || []) {
    const a = pts.find((p) => p.pin.id === r.source_pin_id);
    const b = pts.find((p) => p.pin.id === r.destination_pin_id);
    if (!a || !b || a.z < -0.2 || b.z < -0.2) continue;
    const pa = scale(a);
    const pb = scale(b);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(72,201,240,.35)";
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // пины
  canvas._pinPoints = [];
  for (const p of pts) {
    const s = scale(p);
    const color = PIN_COLORS[p.pin.kind] || PIN_COLORS.other;
    const alpha = p.z >= 0 ? 1 : 0.25;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(s.x, s.y, p.pin.kind === "command" ? 7 : 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    if (p.z >= 0) {
      ctx.strokeStyle = "rgba(255,255,255,.35)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    canvas._pinPoints.push({ x: s.x, y: s.y, pin: p.pin });
  }

  if (!canvas._tipBound) {
    canvas._tipBound = true;
    const tip = document.createElement("div");
    tip.className = "colony-tooltip";
    tip.hidden = true;
    document.body.appendChild(tip);
    canvas.addEventListener("mousemove", (ev) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      let best = null;
      for (const p of canvas._pinPoints || []) {
        if (Math.hypot(p.x - mx, p.y - my) < 11) best = p;
      }
      if (!best) {
        tip.hidden = true;
        return;
      }
      const pin = best.pin;
      tip.innerHTML = `<div class="t">${esc(pin.typeName)}</div>
        <div class="m">${pin.kind === "extractor" ? esc(pin.productName || "") : ""}
        ${pin.qtyPerHour ? ` · ${fmt(pin.qtyPerHour, 0)} шт/ч` : ""}
        ${pin.schematicName ? ` · ${esc(pin.schematicName)}` : ""}</div>`;
      tip.style.left = `${ev.clientX + 14}px`;
      tip.style.top = `${ev.clientY + 12}px`;
      tip.hidden = false;
    });
    canvas.addEventListener("mouseleave", () => {
      tip.hidden = true;
    });
  }
}

// ------------------------------------------------------------------ settings
function renderSettings() {
  if (!state.cfg) return;
  const list = state.cfg.structures || [];
  $("#settingsStructList").innerHTML = list.length
    ? list
        .map(
          (s) => `<div class="struct-row">
            <span class="name">${esc(s.name || "Structure " + s.id)}</span>
            <span class="meta">${s.id}</span>
            <span class="meta">tax ${(Number(s.tax || 0) * 100).toFixed(1)}%</span>
            <button class="btn tiny" data-del-struct="${s.id}">удалить</button>
          </div>`
        )
        .join("")
    : `<div class="muted small">Список пуст. Структуры можно добавить вручную или они подтянутся из персонажа.</div>`;
}

function renderDiag(stats) {
  if (!stats) return;
  $("#diag").textContent = `запросов: ${stats.requests}, из кэша: ${stats.cacheHits}, 304: ${stats.notModified}, ошибок: ${stats.errors}, трафик: ${(stats.bytes / 1e6).toFixed(1)} МБ`;
}

// ------------------------------------------------------------------ events
function bindUI() {
  $("#btnScan").onclick = startScan;
  $("#capture").oninput = (e) => ($("#captureVal").textContent = Number(e.target.value).toFixed(2));
  $("#capture").onchange = async (e) => {
    state.cfg.capture = Number(e.target.value);
    await api("/api/config", { method: "POST", body: JSON.stringify({ capture: state.cfg.capture }) });
    toast("Консервативность сохранена — перезапустите скан");
  };

  $("#fSearch").oninput = (e) => { state.filters.search = e.target.value; renderTable(); };
  $("#fMargin").oninput = (e) => { state.filters.margin = Number(e.target.value) || 0; renderTable(); };
  $("#fVolume").oninput = (e) => { state.filters.volume = Number(e.target.value) || 0; renderTable(); };
  $("#fMaxPrice").oninput = (e) => { state.filters.maxPrice = Number(e.target.value) || Infinity; renderTable(); };
  $("#fLocation").onchange = (e) => { state.filters.location = e.target.value; renderTable(); };
  $("#fKind").onchange = (e) => { state.filters.kind = e.target.value; renderTable(); };
  $("#fOnlyGood").onchange = (e) => { state.filters.onlyGood = e.target.checked; renderTable(); };

  $("#tbl thead").onclick = (e) => {
    const th = e.target.closest("th[data-sort]");
    if (!th) return;
    const key = th.dataset.sort;
    if (state.sort.key === key) state.sort.dir = state.sort.dir === "desc" ? "asc" : "desc";
    else state.sort = { key, dir: key === "typeName" || key === "locationName" ? "asc" : "desc" };
    renderTable();
  };

  $("#tbody").onclick = (e) => {
    const tr = e.target.closest("tr[data-key]");
    if (tr) openItem(tr.dataset.key);
  };

  $("#drawerClose").onclick = closeDrawer;
  $("#backdrop").onclick = closeDrawer;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

  $("#btnLogin") && ($("#btnLogin").onclick = addCharacter);

  // --- планетарка ---
  $("#btnAddChar").onclick = addCharacter;
  $("#btnAddChar2").onclick = addCharacter;
  $("#btnPiRefresh").onclick = () => loadPi(true);
  $("#piNotify").checked = localStorage.getItem("eveflip.notify") === "1";
  $("#piNotify").onchange = async (e) => {
    if (e.target.checked && "Notification" in window && Notification.permission !== "granted") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        e.target.checked = false;
        toast("Браузер запретил уведомления", true);
        localStorage.setItem("eveflip.notify", "0");
        return;
      }
    }
    localStorage.setItem("eveflip.notify", e.target.checked ? "1" : "0");
  };

  $("#tab-pi").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-pichar]");
    if (chip) {
      state.piFilter = chip.dataset.pichar;
      renderPi();
      return;
    }
    const mapBtn = e.target.closest("[data-pimap]");
    if (mapBtn) {
      const [cid, pid] = mapBtn.dataset.pimap.split(":");
      openColony(cid, Number(pid));
      return;
    }
    const row = e.target.closest("tr[data-colony]");
    if (row) {
      const [cid, pid] = row.dataset.colony.split(":");
      openColony(cid, Number(pid));
    }
  });

  $("#tab-pi").addEventListener("change", (e) => {
    const cb = e.target.closest("[data-pidone]");
    if (!cb) return;
    const set = piDoneSet();
    if (cb.checked) set.add(cb.dataset.pidone);
    else set.delete(cb.dataset.pidone);
    piDoneSave(set);
    cb.closest(".pi-row")?.classList.toggle("done", cb.checked);
  });

  // --- персонажи ---
  document.body.addEventListener("click", async (e) => {
    const primaryBtn = e.target.closest("[data-primary]");
    if (primaryBtn) {
      await api("/api/config", { method: "POST", body: JSON.stringify({ primaryCharacterId: Number(primaryBtn.dataset.primary) }) });
      const cfg = await api("/api/config");
      applyConfig(cfg);
      renderAuth();
      renderCharacter();
      toast("Основной персонаж выбран");
      return;
    }
    const logoutBtn = e.target.closest("[data-logout]");
    if (logoutBtn) {
      await api("/api/auth/logout", { method: "POST", body: JSON.stringify({ characterId: Number(logoutBtn.dataset.logout) }) });
      const cfg = await api("/api/config");
      applyConfig(cfg);
      renderAuth();
      renderCharacter();
      state.pi = null;
      toast("Персонаж отключён");
    }
  });

  $("#btnSaveClient").onclick = async () => {
    const clientId = $("#clientId").value.trim();
    await api("/api/config", { method: "POST", body: JSON.stringify({ clientId }) });
    state.cfg.clientId = clientId;
    $("#clientStatus").textContent = clientId ? "Client ID сохранён" : "Client ID не задан";
    renderAuth();
    toast("Сохранено");
  };

  $("#btnCopyCallback").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("#callbackUrl").textContent);
      toast("Callback URL скопирован");
    } catch {
      toast("Не удалось скопировать", true);
    }
  };

  $("#btnAddStruct").onclick = async () => {
    const id = Number($("#structId").value.trim());
    if (!id) return toast("Введите ID структуры", true);
    const tax = (Number($("#structTax").value) || 0) / 100;
    try {
      const r = await api("/api/structures", { method: "POST", body: JSON.stringify({ id, tax }) });
      state.cfg.structures = [...(state.cfg.structures || []), r.structure];
      renderSettings();
      toast("Структура добавлена");
    } catch (err) {
      if (confirm(`${err.message}\n\nДобавить всё равно (без проверки доступа)?`)) {
        const r = await api("/api/structures", { method: "POST", body: JSON.stringify({ id, tax, force: true }) });
        state.cfg.structures = [...(state.cfg.structures || []), r.structure];
        renderSettings();
        toast("Структура добавлена без проверки");
      }
    }
  };

  document.body.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del-struct]");
    if (del) {
      const id = del.dataset.delStruct;
      await api(`/api/structures/${id}`, { method: "DELETE" });
      state.cfg.structures = state.cfg.structures.filter((s) => String(s.id) !== String(id));
      renderSettings();
      renderCharacter();
      toast("Удалено");
    }
    const add = e.target.closest("[data-add-struct]");
    if (add) {
      const id = Number(add.dataset.addStruct);
      const tax = Number(add.dataset.tax) || 0;
      await api("/api/structures", { method: "POST", body: JSON.stringify({ id, tax, force: true }) });
      state.cfg.structures = [...(state.cfg.structures || []), { id, tax }];
      renderCharacter();
      renderSettings();
      toast("Добавлено в скан");
    }
  });

  $("#btnRefreshChar").onclick = async () => {
    try {
      $("#btnRefreshChar").disabled = true;
      await api("/api/character/refresh", { method: "POST" });
      const cfg = await api("/api/config");
      applyConfig(cfg);
      renderAuth();
      renderCharacter();
      state.pi = null;
      toast("Данные персонажей обновлены");
    } catch (err) {
      toast(err.message, true);
    } finally {
      $("#btnRefreshChar").disabled = false;
    }
  };

  $("#btnSaveCalc").onclick = async () => {
    const body = {
      defaultStructureTax: (Number($("#defTax").value) || 0) / 100,
      filters: {
        minMargin: (Number($("#defMargin").value) || 0) / 100,
        minVolume: Number($("#defVolume").value) || 0,
      },
    };
    await api("/api/config", { method: "POST", body: JSON.stringify(body) });
    state.cfg.defaultStructureTax = body.defaultStructureTax;
    state.cfg.filters = { ...state.cfg.filters, ...body.filters };
    toast("Сохранено");
  };
}

boot();
