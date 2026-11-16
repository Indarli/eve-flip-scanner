const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  cfg: null,
  hubs: [],
  auth: null,
  character: null,
  rows: [],
  meta: null,
  sort: { key: "iskDay", dir: "desc" },
  filters: { search: "", margin: 2, volume: 10, maxPrice: 2e9, location: "", kind: "", onlyGood: true },
  poll: null,
  rowLimit: 400,
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
    if (["scan", "character", "settings"].includes(initialTab)) setTab(initialTab, false);
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
  if (state.auth?.loggedIn) {
    const c = state.character;
    box.innerHTML = `
      <div class="char"><span class="dot"></span>
        <span>${esc(c?.name || state.auth.characterName || "пилот")}</span>
        ${c ? `<span class="muted mono">${isk(c.wallet)} ISK</span>` : ""}
      </div>
      <button class="btn small" id="btnLogout">Выйти</button>`;
    $("#btnLogout").onclick = async () => {
      await api("/api/auth/logout", { method: "POST" });
      state.auth.loggedIn = false;
      state.character = null;
      renderAuth();
      renderCharacter();
      toast("Вы вышли");
    };
  } else {
    box.innerHTML = `<span class="muted">не авторизован</span><button class="btn small" id="btnLogin">Войти через EVE</button>`;
    $("#btnLogin").onclick = () => {
      if (!state.cfg.clientId) {
        setTab("settings");
        toast("Сначала укажите Client ID в настройках", true);
        return;
      }
      location.href = "/api/auth/login";
    };
  }
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
function renderCharacter() {
  const c = state.character;
  $("#charEmpty").hidden = Boolean(c);
  $("#charContent").hidden = !c;
  if (!c) return;

  $("#cName").textContent = c.name || "—";
  $("#cId").textContent = c.characterId ? `ID ${c.characterId}` : "";
  $("#cWallet").textContent = isk(c.wallet) + " ISK";
  $("#cSlots").textContent = `${c.orders.count} / ${c.skills.maxOrders}`;
  $("#cSlotsSub").textContent = `свободно ${c.orders.slotsFree}, в эскроу ${isk(c.orders.escrow)}`;
  $("#cFees").textContent = `${pct(c.fees.tax, 2)} / ${pct(Object.values(c.fees.hubs || {})[0]?.broker ?? 0, 2)}`;

  const lv = c.skills.levels || {};
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

  const hubs = Object.entries(c.fees.hubs || {});
  $("#hubFeeTable").innerHTML =
    `<tr><th>Хаб</th><th>Broker</th><th>Стендинги</th></tr>` +
    hubs
      .map(
        ([k, h]) =>
          `<tr><td>${esc(h.stationName || k)}</td><td class="num">${pct(h.broker, 2)}</td>
           <td class="muted">${(h.factionStanding ?? 0).toFixed(1)} / ${(h.corpStanding ?? 0).toFixed(1)}</td></tr>`
      )
      .join("");

  const structs = c.structures || [];
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

  $("#btnLogin") && ($("#btnLogin").onclick = () => (location.href = "/api/auth/login"));

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
      const r = await api("/api/character/refresh", { method: "POST" });
      state.character = r.character;
      renderCharacter();
      renderAuth();
      toast("Данные персонажа обновлены");
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
