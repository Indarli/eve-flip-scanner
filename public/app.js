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
  filters: { search: "", margin: 2, volume: 10, maxPrice: 2e9, location: "", kind: "", onlyGood: true, hideSk: false },
  poll: null,
  rowLimit: 400,
  chartDays: 90,
  sse: false,
  es: null,
  scanDoneKey: null,
  scanRunning: false,
  autoTimer: null,
  autoSeen: new Set(),
  autoSeeded: false,
  esiTimer: null,
  pi: null,
  piFilter: "all",
  piTimer: null,
  intel: null,
  intelTimer: null,
  intelSeen: new Set(),
  intelLoaded: false,
  zkbSeen: new Set(),
  zkbLoaded: false,
  portfolio: null,
  pfTimer: null,
  pfRetryTimer: null,
  pfSeen: new Set(),
  pfLoaded: false,
  pfChar: localStorage.getItem("eveflip.pf.char") || "",
  intelSort: { key: "ageSec", dir: "asc" }, // «Когда»: сверху самое новое
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
  if (name === "portfolio") {
    loadPortfolio();
    startPfPoll();
  } else {
    clearInterval(state.pfTimer);
    state.pfTimer = null;
  }
  if (name === "intel") {
    loadIntel();
    if (!state.sse) startIntelPoll();
  } else {
    clearInterval(state.intelTimer);
    state.intelTimer = null;
  }
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
    const sseOk = startSSE();
    const initialTab = location.hash.replace("#", "");
    if (["scan", "portfolio", "intel", "pi", "character", "settings"].includes(initialTab)) setTab(initialTab, false);
    if (!sseOk && state.cfg.scan?.running) pollScan();
    if (!sseOk) startEsiPoll();
    scheduleAutoScan();

    const params = new URLSearchParams(location.search);
    if (params.get("auth") === "ok") {
      toast("Авторизация успешна");
      history.replaceState({}, "", "/#pi");
      setTab("pi");
      // профиль догружается в фоне — обновим карточки через пару секунд
      setTimeout(async () => {
        try {
          const cfg2 = await api("/api/config");
          applyConfig(cfg2);
          renderAuth();
          renderCharacter();
          await loadPi(true);
        } catch {
          /* ignore */
        }
      }, 2500);
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
  if (cfg.esiStatus) updateEsiBanner(cfg.esiStatus);
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
  state.scanRunning = true;
  try {
    await api("/api/scan", { method: "POST" });
    $("#progress").hidden = false;
    if (!state.sse) pollScan();
  } catch (err) {
    $("#btnScan").disabled = false;
    state.scanRunning = false;
    toast(err.message, true);
  }
}

function handleScanUpdate(scan) {
  renderScan(scan);
  state.scanRunning = Boolean(scan.running);
  if (scan.running || scan.phase === "idle") return;

  const key = `${scan.phase}:${scan.finishedAt || ""}`;
  if (state.scanDoneKey === key) return;
  state.scanDoneKey = key;

  $("#btnScan").disabled = false;
  if (scan.phase === "done") {
    loadResults().then(checkNewOpportunities);
    toast(`Скан завершён: ${scan.rows} позиций`);
  } else if (scan.phase === "error") {
    toast("Ошибка скана: " + scan.message, true);
  }
  setTimeout(() => ($("#progress").hidden = true), 2500);
}

function autoCfg() {
  return {
    enabled: localStorage.getItem("eveflip.auto.enabled") === "1",
    minutes: Math.max(5, Number(localStorage.getItem("eveflip.auto.minutes")) || 10),
    margin: Math.max(1, Number(localStorage.getItem("eveflip.auto.margin")) || 8),
  };
}

function scheduleAutoScan() {
  clearInterval(state.autoTimer);
  state.autoTimer = null;
  const cfg = autoCfg();
  if (!cfg.enabled) return;
  state.autoTimer = setInterval(() => {
    if (!state.scanRunning) startScan();
  }, cfg.minutes * 60_000);
}

function checkNewOpportunities() {
  const cfg = autoCfg();
  if (!cfg.enabled) return;
  const rows = (state.rows || []).filter(
    (r) => (Number(r.marginNet) || 0) * 100 >= cfg.margin && Number(r.profitUnit) > 0
  );
  const keys = new Set(rows.map((r) => `${r.typeId}:${r.locationId}`));
  if (!state.autoSeeded) {
    state.autoSeen = keys;
    state.autoSeeded = true;
    return;
  }
  const fresh = rows.filter((r) => !state.autoSeen.has(`${r.typeId}:${r.locationId}`));
  state.autoSeen = keys;
  if (!fresh.length) return;

  playIntelSound(true);
  showSimplePopup(
    `Новые возможности: ${fresh.length}`,
    fresh
      .slice(0, 3)
      .map(
        (r) =>
          `<b>${esc(r.typeName)}</b> — ${esc(r.locationName)} · ${pct(r.marginNet)} · ${isk(r.profitUnit)}/шт`
      ),
    "scan"
  );
  toast(`Новые возможности: ${fresh.length}`);
}

function updateEsiBanner(st) {
  const el = $("#esiBanner");
  if (!el) return;
  if (!st || !st.down) {
    el.hidden = true;
    return;
  }
  const ago = st.lastOkAt ? Math.round((Date.now() - st.lastOkAt) / 1000) : null;
  const tail =
    ago === null ? "успешных ответов ещё не было" : `последний успешный ответ ${fmtAge(ago)} назад`;
  $("#esiBannerText").textContent = `ESI недоступен${st.lastError ? `: ${st.lastError}` : ""} · ${tail} · повторяю автоматически…`;
  el.hidden = false;
}

function startEsiPoll() {
  clearInterval(state.esiTimer);
  state.esiTimer = setInterval(async () => {
    try {
      updateEsiBanner(await api("/api/esi/status"));
    } catch {
      /* ignore */
    }
  }, 5000);
}

function pollScan() {
  clearInterval(state.poll);
  $("#progress").hidden = false;
  const tick = async () => {
    try {
      const { scan } = await api("/api/scan/status");
      handleScanUpdate(scan);
      if (!scan.running && scan.phase !== "idle") clearInterval(state.poll);
    } catch (err) {
      clearInterval(state.poll);
      $("#btnScan").disabled = false;
    }
  };
  tick();
  state.poll = setInterval(tick, 800);
}

function startSSE() {
  if (!("EventSource" in window)) return false;
  try {
    const es = new EventSource("/api/events");
    state.es = es;
    state.sse = true;

    es.addEventListener("intel", (e) => {
      try {
        state.intel = JSON.parse(e.data);
      } catch {
        return;
      }
      renderIntel();
    });

    es.addEventListener("scan", (e) => {
      try {
        handleScanUpdate(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    });

    es.addEventListener("esi", (e) => {
      try {
        updateEsiBanner(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    });

    es.onerror = () => {
      es.close();
      state.es = null;
      state.sse = false;
      startEsiPoll();
      if ($("#tab-intel")?.classList.contains("active")) startIntelPoll();
      if (!$("#progress").hidden) pollScan();
    };
    return true;
  } catch {
    state.sse = false;
    return false;
  }
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
    if (f.hideSk && /skin|blueprint|чертеж/i.test(String(r.typeName || ""))) return false;
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

function readPresets() {
  try {
    return JSON.parse(localStorage.getItem("eveflip.presets") || "{}");
  } catch {
    return {};
  }
}

function renderPresets() {
  const sel = $("#fPreset");
  if (!sel) return;
  const presets = readPresets();
  sel.innerHTML =
    `<option value="">Пресеты…</option>` +
    Object.keys(presets)
      .map((n) => `<option value="${esc(n)}">${esc(n)}</option>`)
      .join("");
}

function savePreset() {
  const name = prompt("Название пресета");
  if (!name) return;
  const presets = readPresets();
  presets[name] = { filters: { ...state.filters }, sort: { ...state.sort } };
  localStorage.setItem("eveflip.presets", JSON.stringify(presets));
  renderPresets();
  toast(`Пресет «${name}» сохранён`);
}

function applyPreset(name) {
  const p = readPresets()[name];
  if (!p) return;
  state.filters = { ...state.filters, ...p.filters };
  if (p.sort) state.sort = { ...state.sort, ...p.sort };
  $("#fSearch").value = state.filters.search;
  $("#fMargin").value = state.filters.margin;
  $("#fVolume").value = state.filters.volume;
  $("#fMaxPrice").value = state.filters.maxPrice;
  $("#fLocation").value = state.filters.location;
  $("#fKind").value = state.filters.kind;
  $("#fOnlyGood").checked = Boolean(state.filters.onlyGood);
  $("#fHideSk").checked = Boolean(state.filters.hideSk);
  renderTable();
  toast(`Пресет «${name}» применён`);
}

function exportCsv() {
  const rows = visibleRows();
  const cols = [
    "typeId",
    "typeName",
    "locationName",
    "kind",
    "bid",
    "ask",
    "spreadPct",
    "marginNet",
    "profitUnit",
    "volumeDay",
    "iskDay",
    "roiDay",
    "daysToSell",
    "competition",
    "capital",
  ];
  const head = cols.join(";");
  const body = rows.map((r) =>
    cols
      .map((c) => {
        const v = r[c];
        if (typeof v === "number") return String(Number(v.toFixed(6))).replace(".", ",");
        return `"${String(v ?? "").replace(/"/g, '""')}"`;
      })
      .join(";")
  );
  const blob = new Blob(["\uFEFF" + [head, ...body].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `eve-flip-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Экспортировано строк: ${rows.length}`);
}

async function loadCompare(typeId) {
  const box = $("#cmpBox");
  if (!box) return;
  try {
    const d = await api(`/api/compare?type=${encodeURIComponent(typeId)}`);
    box.innerHTML = `<table class="intel-table"><thead><tr>
      <th>Хаб</th><th class="num">Buy</th><th class="num">Sell</th><th class="num">Спред</th>
    </tr></thead><tbody>${(d.rows || [])
      .map((r) => {
        const spread = r.bid > 0 && r.ask > 0 ? (r.ask - r.bid) / r.ask : null;
        return `<tr><td>${esc(r.hub)}</td><td class="num">${r.bid ? isk(r.bid) : "—"}</td>
          <td class="num">${r.ask ? isk(r.ask) : "—"}</td>
          <td class="num">${spread === null ? "—" : pct(spread)}</td></tr>`;
      })
      .join("")}</tbody></table>`;
  } catch (e) {
    box.textContent = e.message;
  }
}

function marginBadge(m) {  const v = m * 100;
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

    <div class="panel" style="margin: 12px 0">
      <h3>Сравнение хабов</h3>
      <div id="cmpBox" class="muted small">Загружаю цены по хабам…</div>
    </div>

    <div class="ladder">
      <div class="buy"><h4>Buy-ордера</h4>
        <table>${ladder(d.book.buy, "buy")}</table></div>
      <div class="sell"><h4>Sell-ордера</h4>
        <table>${ladder(d.book.sell, "sell")}</table></div>
    </div>

    <div class="chart-box">
      <div class="chart-range">
        <button data-days="7">7д</button>
        <button data-days="30">30д</button>
        <button data-days="90" class="active">90д</button>
        <button data-days="365">365д</button>
      </div>
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

  const chartCanvas = $("#chart");
  const applyRange = (days) => {
    state.chartDays = days;
    $$(".chart-range button").forEach((b) => b.classList.toggle("active", Number(b.dataset.days) === days));
    drawChart(chartCanvas, d.history, days);
  };
  $$(".chart-range button").forEach((b) => (b.onclick = () => applyRange(Number(b.dataset.days))));
  applyRange(state.chartDays || 90);
  loadCompare(row.typeId);
}

function closeDrawer() {
  $("#drawer").hidden = true;
  $("#backdrop").hidden = true;
}

function drawChart(canvas, history, days = 90) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 500;
  const h = canvas.clientHeight || 200;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cutoff = Date.now() - days * 86400_000;
  const data = (history || []).filter((d) => Number(d.average) > 0 && (!d.date || Date.parse(d.date) >= cutoff));
  if (data.length < 2) {
    ctx.fillStyle = "#7f90ab";
    ctx.font = "12px monospace";
    ctx.fillText(`нет истории за ${days} дн.`, 12, h / 2);
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
        <span class="meta">${c.pending ? "загружается…" : `${c.colonies || 0} колоний`}</span>
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

// ------------------------------------------------------------------ портфель
async function loadPortfolio(force = false) {
  try {
    const q = state.pfChar ? `?char=${encodeURIComponent(state.pfChar)}` : "";
    const d = force
      ? await api("/api/portfolio/refresh", {
          method: "POST",
          body: JSON.stringify({ characterId: state.pfChar || undefined }),
        })
      : await api("/api/portfolio" + q);

    if (d.pending) {
      state.portfolio = null;
      clearTimeout(state.pfRetryTimer);
      state.pfRetryTimer = setTimeout(() => loadPortfolio(), 5000);
      $("#pfWho").textContent = "Профиль загружается…";
      $("#pfCards").innerHTML = card(
        "Портфель",
        "…",
        "Загружаю профиль персонажа (ордера, транзакции, склад). Обычно это занимает до минуты — страница обновится сама."
      );
      $("#pfOrders").innerHTML = `<div class="intel-empty">Жду профиль…</div>`;
      $("#pfPnl").innerHTML = `<div class="intel-empty">Жду профиль…</div>`;
      $("#pfInv").innerHTML = `<div class="intel-empty">Жду профиль…</div>`;
      return;
    }
    clearTimeout(state.pfRetryTimer);
    state.portfolio = d;
    renderPortfolio();
  } catch (e) {
    if (String(e.message).toLowerCase().includes("авториз")) {
      $("#pfWho").textContent = "Нужен вход через EVE";
      $("#pfCards").innerHTML = `<div class="card"><div class="card-label">Портфель</div><div class="muted small">Войдите через EVE, чтобы видеть ордера, P&L и склад.</div></div>`;
    } else {
      toast("Портфель: " + e.message, true);
    }
  }
}

function startPfPoll() {
  clearInterval(state.pfTimer);
  state.pfTimer = setInterval(() => {
    if (document.querySelector("#tab-portfolio")?.classList.contains("active")) loadPortfolio();
  }, 30_000);
}

function checkUndercuts(orders) {
  const under = orders.filter((o) => o.undercut);
  const current = new Set(under.map((o) => o.orderId));
  if (!state.pfLoaded) {
    state.pfSeen = current;
    state.pfLoaded = true;
    return;
  }
  const fresh = under.filter((o) => !state.pfSeen.has(o.orderId));
  state.pfSeen = current;
  if (!fresh.length) return;
  playIntelSound();
  showSimplePopup(
    `Подрезали: ${fresh.length}`,
    fresh
      .slice(0, 3)
      .map(
        (o) =>
          `<b>${esc(o.typeName)}</b> — ${o.isBuy ? "buy" : "sell"} ${isk(o.price)} · лучшая ${isk(
            o.isBuy ? o.bestBid : o.bestAsk
          )}`
      ),
    "portfolio"
  );
  toast(`Подрезали ордеров: ${fresh.length}`, true);
}

function renderPortfolio() {
  const d = state.portfolio;
  if (!d) return;

  const chars = state.characters || [];
  if (!state.pfChar && chars[0]) state.pfChar = String(chars[0].characterId || chars[0].id || "");
  const chips = $("#pfChars");
  if (chips) {
    chips.innerHTML = chars
      .map((c) => {
        const id = String(c.characterId || c.id || "");
        return `<button class="chip ${id === String(state.pfChar) ? "active" : ""}" data-pfchar="${id}">${esc(
          c.name || id
        )}</button>`;
      })
      .join("");
  }

  $("#pfWho").textContent = `${d.character.name} · ${isk(d.summary.wallet)} ISK`;
  $("#pfMeta").textContent = new Date(d.generatedAt).toLocaleTimeString("ru-RU");

  const s = d.summary;
  $("#pfCards").innerHTML = [
    card("Кошелёк", isk(s.wallet) + " ISK"),
    card("В ордерах", isk(s.ordersValue) + " ISK", `эскроу ${isk(s.escrow)}`),
    card("Склад", isk(s.inventoryValue) + " ISK"),
    card("Реализовано", isk(s.realized) + " ISK", `куплено ${isk(s.boughtIsk)} · продано ${isk(s.soldIsk)}`),
    card("Подрезано", String(s.undercut), "ордеров хуже рынка"),
  ].join("");

  const orders = [...(d.orders || [])].sort(
    (a, b) => Number(b.undercut) - Number(a.undercut) || b.value - a.value
  );
  $("#pfOrdersCount").textContent = `${orders.length}`;
  $("#pfOrders").innerHTML = orders.length
    ? `<table class="intel-table"><thead><tr>
        <th>Тип</th><th>Локация</th><th>Ордер</th><th class="num">Цена</th><th class="num">Лучшая</th>
        <th class="num">Δ</th><th class="num">Остаток</th><th class="num">Стоимость</th><th>Статус</th>
      </tr></thead><tbody>${orders
        .map((o) => {
          const best = o.isBuy ? o.bestBid : o.bestAsk;
          const status = o.undercut
            ? `<span class="badge bad">подрезан</span>`
            : best
            ? `<span class="badge good">первый</span>`
            : `<span class="badge dim">нет данных</span>`;
          return `<tr>
            <td>${esc(o.typeName)}</td>
            <td class="age">${esc(o.locationName)}</td>
            <td>${o.isBuy ? "buy" : "sell"}</td>
            <td class="num">${isk(o.price)}</td>
            <td class="num">${best ? isk(best) : "—"}</td>
            <td class="num">${best ? pct(o.deltaPct) : "—"}</td>
            <td class="num">${fmt(o.volumeRemain)} / ${fmt(o.volumeTotal)}</td>
            <td class="num">${isk(o.value)}</td>
            <td>${status}</td>
          </tr>`;
        })
        .join("")}</tbody></table>`
    : `<div class="intel-empty">Активных ордеров нет.</div>`;

  const pnl = (d.pnl || []).slice(0, 40);
  $("#pfPnl").innerHTML = pnl.length
    ? `<table class="intel-table"><thead><tr>
        <th>Тип</th><th class="num">Куплено</th><th class="num">Продано</th><th class="num">Ср. покупка</th>
        <th class="num">Ср. продажа</th><th class="num">P&L</th><th class="num">Остаток</th>
      </tr></thead><tbody>${pnl
        .map(
          (r) => `<tr>
            <td>${esc(r.typeName)}</td>
            <td class="num">${fmt(r.boughtQty)}</td>
            <td class="num">${fmt(r.soldQty)}</td>
            <td class="num">${isk(r.avgBuy)}</td>
            <td class="num">${isk(r.avgSell)}</td>
            <td class="num">${isk(r.realized)}</td>
            <td class="num">${fmt(r.costQty)}</td>
          </tr>`
        )
        .join("")}</tbody></table>`
    : `<div class="intel-empty">Транзакций нет.</div>`;

  const inv = (d.inventory || []).slice(0, 30);
  $("#pfInv").innerHTML = inv.length
    ? `<table class="intel-table"><thead><tr>
        <th>Тип</th><th>Местонахождение</th><th class="num">Кол-во</th><th class="num">Цена (buy)</th><th class="num">Стоимость</th>
      </tr></thead><tbody>${inv
        .map((r) => {
          const place = r.locationName
            ? `${esc(r.locationName)}${r.systemName ? ` · ${esc(r.systemName)}` : ""}`
            : r.locationId
            ? `<span class="muted">структура #${r.locationId}</span>`
            : `<span class="muted">—</span>`;
          return `<tr>
            <td>${esc(r.typeName)}</td>
            <td class="age">${place}</td>
            <td class="num">${fmt(r.qty)}</td>
            <td class="num">${isk(r.price)}</td>
            <td class="num">${isk(r.value)}</td>
          </tr>`;
        })
        .join("")}</tbody></table>`
    : `<div class="intel-empty">Склад пуст или нет цен.</div>`;

  checkUndercuts(orders);
}

// ------------------------------------------------------------------ интел
function fmtAge(sec) {
  if (sec === null || sec === undefined) return "—";
  if (sec < 60) return `${Math.max(0, Math.round(sec))}с`;
  if (sec < 3600) return `${Math.floor(sec / 60)}м`;
  return `${Math.floor(sec / 3600)}ч ${Math.floor((sec % 3600) / 60)}м`;
}

function alertKey(a) {
  if (a.key) return a.key;
  const names = (a.names || []).map((n) => n.name).join(",");
  return `${names}|${a.systemId}|${Math.floor((a.ts || 0) / 60000)}`;
}

function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.3);
    setTimeout(() => ctx.close().catch(() => {}), 600);
  } catch {
    /* без звука */
  }
}

function playIntelSound(force = false) {
  const d = state.intel;
  if (!force && d?.config?.sound === false) return;
  if (d?.config?.hasSound) {
    const a = new Audio(`/api/intel/sound?ts=${Date.now()}`);
    a.play().catch(() => beep());
  } else {
    beep();
  }
}

function intelAlertLine(a) {
  const names = (a.names || []).map((n) => n.name).join(", ");
  const extra = a.extra ? ` <span class="ip-extra">+${a.extra}</span>` : "";
  const sys = a.systemName || "—";
  const region = a.regionName ? ` (${a.regionName})` : "";
  return `<div class="ip-item"><b>${esc(names || "?")}</b>${extra} — <span class="ip-sys">${esc(sys)}</span>${esc(
    region
  )} · <span class="ip-jumps">${a.jumps} пр.</span>${a.ship ? ` · ${esc(a.ship)}` : ""}${
    a.trend === "toward" ? " · к вам" : a.trend === "away" ? " · от вас" : ""
  }</div>`;
}

function showIntelPopup(rows) {
  const el = $("#intelPopup");
  if (!el || !rows.length) return;
  el.innerHTML = `
    <div class="ip-head">
      <span class="ip-title">ИНТЕЛ · ${rows.length} новых</span>
      <button class="ip-close" id="ipClose" title="закрыть">×</button>
    </div>
    ${rows.slice(0, 3).map(intelAlertLine).join("")}
    <div class="ip-foot">нажмите, чтобы открыть вкладку «Интел»</div>`;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), 10000);
  el.onclick = (e) => {
    if (e.target.closest("#ipClose")) {
      el.hidden = true;
      return;
    }
    el.hidden = true;
    setTab("intel");
  };
}

function showSimplePopup(title, lines, tab = "intel") {
  const el = $("#intelPopup");
  if (!el) return;
  el.innerHTML = `
    <div class="ip-head">
      <span class="ip-title">${esc(title)}</span>
      <button class="ip-close" id="ipClose" title="закрыть">×</button>
    </div>
    ${lines.map((l) => `<div class="ip-item">${l}</div>`).join("")}
    <div class="ip-foot">нажмите, чтобы открыть вкладку</div>`;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), 10000);
  el.onclick = (e) => {
    if (e.target.closest("#ipClose")) {
      el.hidden = true;
      return;
    }
    el.hidden = true;
    setTab(tab);
  };
}

function notifyIntel(rows) {
  if (localStorage.getItem("eveflip.intel.notify") !== "1") return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const first = rows[0];
  const names = (first.names || []).map((n) => n.name).join(", ");
  const extra = first.extra ? ` +${first.extra}` : "";
  const where = `${first.systemName || "?"}${first.regionName ? ` (${first.regionName})` : ""}`;
  const body = `${names}${extra} — ${where}, ${first.jumps} пр.${first.ship ? ` · ${first.ship}` : ""}${
    rows.length > 1 ? ` (и ещё ${rows.length - 1})` : ""
  }`;
  try {
    const n = new Notification(`Интел: ${first.jumps === 0 ? "у вас в системе" : `${first.jumps} прыжк.`}`, {
      body,
      tag: "eve-intel",
      renotify: true,
    });
    n.onclick = () => {
      window.focus();
      setTab("intel");
      n.close();
    };
  } catch {
    /* уведомления недоступны */
  }
}

function checkIntelAlerts(alerts) {
  if (!state.intelLoaded) {
    for (const a of alerts) state.intelSeen.add(alertKey(a));
    state.intelLoaded = true;
    return;
  }
  const fresh = [];
  for (const a of alerts) {
    const k = alertKey(a);
    if (!state.intelSeen.has(k)) {
      state.intelSeen.add(k);
      fresh.push(a);
    }
  }
  if (state.intelSeen.size > 800) state.intelSeen = new Set([...state.intelSeen].slice(-400));
  if (!fresh.length) return;
  playIntelSound();
  showIntelPopup(fresh);
  notifyIntel(fresh);
}

function intelRow(p) {
  const j = p.jumps;
  const cls = j === null || j === undefined ? "jx" : j === 0 ? "j0" : j === 1 ? "j1" : j === 2 ? "j2" : "j3";
  const list = p.names && p.names.length ? p.names : [{ name: p.name, zkb: p.zkb }];
  const names = list
    .map((n) => (n.zkb ? `<a href="${n.zkb}" target="_blank" rel="noreferrer">${esc(n.name)}</a>` : esc(n.name)))
    .join(", ");
  const extra = p.extra ? `<div class="intel-extra">+${p.extra}</div>` : "";
  const sys = p.systemName
    ? `<a href="https://evemaps.dotlan.net/system/${encodeURIComponent(p.systemName)}" target="_blank" rel="noreferrer">${esc(
        p.systemName
      )}</a>`
    : `<span class="muted">—</span>`;
  const ship = p.ship ? esc(p.ship) : `<span class="muted">—</span>`;
  const trend =
    p.trend === "toward"
      ? `<span class="trend toward">→ к вам</span>`
      : p.trend === "away"
      ? `<span class="trend away">← от вас</span>`
      : "";
  return `<tr data-ikey="${esc(p.key || "")}">
    <td><div class="intel-names">${names}</div>${extra}</td>
    <td class="ship">${ship}</td>
    <td>${sys}${trend}</td>
    <td class="age">${p.regionName ? esc(p.regionName) : "—"}</td>
    <td class="num"><span class="jumps ${cls}" title="${j === null || j === undefined ? "считаю маршрут…" : ""}">${
      j === null || j === undefined ? "…" : j
    }</span></td>
    <td class="age">${p.nearest ? esc(p.nearest) : "—"}</td>
    <td class="age">${fmtAge(p.ageSec)}</td>
  </tr>`;
}

const INTEL_COLS = [
  { key: "name", label: "Пилот" },
  { key: "ship", label: "Корабль" },
  { key: "systemName", label: "Система" },
  { key: "regionName", label: "Регион" },
  { key: "jumps", label: "Прыжков", num: true },
  { key: "nearest", label: "Мой чар" },
  { key: "ageSec", label: "Когда" },
];

function cmpIntel(a, b) {
  const { key, dir } = state.intelSort;
  const mul = dir === "asc" ? 1 : -1;
  let av = a[key];
  let bv = b[key];
  if (key === "name") {
    av = a.names?.[0]?.name || "";
    bv = b.names?.[0]?.name || "";
  }
  if (key === "jumps") {
    av = av ?? 9999;
    bv = bv ?? 9999;
  }
  if (key === "ageSec") {
    av = av ?? 1e9;
    bv = bv ?? 1e9;
  }
  if (typeof av === "string" || typeof bv === "string") {
    return String(av ?? "").localeCompare(String(bv ?? ""), "ru") * mul;
  }
  return ((av ?? 0) - (bv ?? 0)) * mul;
}

function intelTable(list) {
  const sorted = [...list].sort(cmpIntel);
  return `<table class="intel-table"><thead><tr>${INTEL_COLS.map((c) => {
    const active = state.intelSort.key === c.key;
    const arrow = active ? (state.intelSort.dir === "asc" ? " asc" : "") : "";
    return `<th data-isort="${c.key}" class="${c.num ? "num" : ""}${active ? " sorted" : ""}${arrow}">${c.label}</th>`;
  }).join("")}</tr></thead><tbody>${sorted
    .slice(0, 200)
    .map(intelRow)
    .join("")}</tbody></table>`;
}

function zkbRowHtml(z) {
  const cls = z.jumps === 0 ? "j0" : z.jumps === 1 ? "j1" : z.jumps === 2 ? "j2" : "j3";
  const name = `<a href="${z.zkb}" target="_blank" rel="noreferrer">${esc(z.name)}</a>`;
  const sys = z.systemName
    ? `<a href="https://evemaps.dotlan.net/system/${encodeURIComponent(z.systemName)}" target="_blank" rel="noreferrer">${esc(
        z.systemName
      )}</a>`
    : `<span class="muted">—</span>`;
  return `<tr>
    <td>${name} <span class="badge ${z.isLoss ? "bad" : "good"}">${z.isLoss ? "убит" : "убил"}</span></td>
    <td class="ship">${z.ship ? esc(z.ship) : `<span class="muted">—</span>`}</td>
    <td>${sys}</td>
    <td class="age">${z.regionName ? esc(z.regionName) : "—"}</td>
    <td class="num"><span class="jumps ${cls}">${z.jumps}</span></td>
    <td class="age">${fmtAge(z.ageSec)}</td>
    <td><a href="${z.key}" target="_blank" rel="noreferrer">zkb</a></td>
  </tr>`;
}

function zkbTable(list) {
  return `<table class="intel-table"><thead><tr>
      <th>Пилот</th><th>Корабль</th><th>Система</th><th>Регион</th><th class="num">Прыжков</th><th>Когда</th><th></th>
    </tr></thead><tbody>${list.slice(0, 100).map(zkbRowHtml).join("")}</tbody></table>`;
}

function zkbAlertLine(z) {
  return `<div class="ip-item"><b>${esc(z.name)}</b> <span class="badge ${z.isLoss ? "bad" : "good"}">${
    z.isLoss ? "убит" : "убил"
  }</span> — <span class="ip-sys">${esc(z.systemName || "?")}</span>${
    z.regionName ? ` (${esc(z.regionName)})` : ""
  } · <span class="ip-jumps">${z.jumps} пр.</span>${z.ship ? ` · ${esc(z.ship)}` : ""}</div>`;
}

function showZkbPopup(rows) {
  const el = $("#intelPopup");
  if (!el || !rows.length) return;
  el.innerHTML = `
    <div class="ip-head">
      <span class="ip-title">ZKB · ${rows.length} новых</span>
      <button class="ip-close" id="ipClose" title="закрыть">×</button>
    </div>
    ${rows.slice(0, 3).map(zkbAlertLine).join("")}
    <div class="ip-foot">нажмите, чтобы открыть вкладку «Интел»</div>`;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), 10000);
  el.onclick = (e) => {
    if (e.target.closest("#ipClose")) {
      el.hidden = true;
      return;
    }
    el.hidden = true;
    setTab("intel");
  };
}

function notifyZkb(rows) {
  if (localStorage.getItem("eveflip.intel.notify") !== "1") return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const z = rows[0];
  const body = `${z.name} ${z.isLoss ? "убит" : "убил"} — ${z.ship || "корабль"} · ${z.systemName || "?"}${
    z.regionName ? ` (${z.regionName})` : ""
  }, ${z.jumps} пр.`;
  try {
    const n = new Notification(`ZKB: ${z.isLoss ? "потеря" : "килл"}`, { body, tag: "eve-zkb", renotify: true });
    n.onclick = () => {
      window.focus();
      setTab("intel");
      n.close();
    };
  } catch {
    /* ignore */
  }
}

function checkZkbAlerts(rows) {
  if (!state.zkbLoaded) {
    for (const z of rows) state.zkbSeen.add(z.key);
    state.zkbLoaded = true;
    return;
  }
  const fresh = rows.filter((z) => z.key && !state.zkbSeen.has(z.key));
  for (const z of fresh) state.zkbSeen.add(z.key);
  if (state.zkbSeen.size > 500) state.zkbSeen = new Set([...state.zkbSeen].slice(-300));
  if (!fresh.length) return;
  playIntelSound();
  showZkbPopup(fresh);
  notifyZkb(fresh);
}

function openIntelRow(key) {
  const d = state.intel;
  if (!d) return;
  const row = [...(d.alerts || []), ...(d.pilots || [])].find((r) => r.key === key);
  if (!row) return;

  const names = (row.names || []).map((n) => n.name).join(", ");
  const sys = row.systemName || "—";
  const region = row.regionName ? ` (${row.regionName})` : "";
  const trend =
    row.trend === "toward" ? " · движется к вам" : row.trend === "away" ? " · уходит от вас" : "";
  const dotlan = `https://evemaps.dotlan.net/system/${encodeURIComponent(row.systemName || "")}`;

  $("#drawer").hidden = false;
  $("#backdrop").hidden = false;
  $("#drawerBody").innerHTML = `
    <h2>${esc(names || "?")}</h2>
    <div class="sub">${esc(sys)}${esc(region)} · ${row.jumps === null || row.jumps === undefined ? "…" : row.jumps} пр.${trend}</div>

    <div class="kv">
      <div class="k">Корабль</div><div class="v">${esc(row.ship || "—")}</div>
      <div class="k">Канал</div><div class="v">${esc(row.channel || "—")}</div>
      <div class="k">Когда</div><div class="v">${fmtAge(row.ageSec)} назад</div>
      <div class="k">Дополнительно</div><div class="v">${row.extra ? `+${row.extra}` : "—"}</div>
      <div class="k">Мой персонаж</div><div class="v">${esc(row.nearest || "—")}</div>
    </div>

    <div class="formrow">
      <a class="btn" href="${dotlan}" target="_blank" rel="noreferrer">Система на dotlan</a>
      ${
        row.zkill
          ? `<a class="btn" href="${row.zkill}" target="_blank" rel="noreferrer">Последний килл</a>`
          : ""
      }
      <button class="btn" id="intelCopyNames">Копировать ники</button>
    </div>

    <div class="structures">
      ${(row.names || [])
        .map(
          (n) => `<div class="struct-row">
            <span class="name">${esc(n.name)}</span>
            <a class="meta" href="${n.zkb}" target="_blank" rel="noreferrer">zkillboard</a>
          </div>`
        )
        .join("")}
    </div>
  `;

  const copyBtn = $("#intelCopyNames");
  if (copyBtn) {
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(names);
        toast("Ники скопированы");
      } catch {
        toast("Не удалось скопировать", true);
      }
    };
  }
}

function setHtmlCached(sel, html) {
  const el = $(sel);
  if (!el) return;
  if (el._lastHtml === html) return;
  el._lastHtml = html;
  el.innerHTML = html;
}

function renderIntel() {
  const d = state.intel;
  if (!d) return;
  $("#intelChatDir").textContent = d.chatDir || "";
  $("#intelMeta").textContent = `${d.stats.messages} сообщений · ${d.stats.pilots} пилотов${
    d.stats.lastMessageAt ? ` · ${fmtAge(Math.round((Date.now() - d.stats.lastMessageAt) / 1000))} назад` : ""
  }${(d.warnings || []).length ? ` · ⚠ ${d.warnings.length}` : ""}`;
  $("#intelMeta").title = (d.warnings || []).join("\n");

  const warnBox = $("#intelWarn");
  if (warnBox) {
    const warnings = d.warnings || [];
    warnBox.hidden = !warnings.length;
    if (warnings.length) {
      $("#intelWarnText").textContent =
        "Проверка онлайна недоступна: " + warnings.join("; ") + ". Пока персонаж не подтверждён онлайн, расстояние по нему не считается.";
    }
  }

  const ownHtml = d.own.length
    ? d.own
        .map((o) => {
          const label =
            o.online === true ? o.systemName || "нет позиции" : o.online === false ? "оффлайн" : "нужен вход";
          const cls = o.online === true ? "chip active" : "chip";
          return `<span class="${cls}" title="${esc(o.error || "")}">${esc(o.name)} · ${esc(label)}</span>`;
        })
        .join("")
    : `<span class="muted small">нет авторизованных персонажей — позиция неизвестна</span>`;
  setHtmlCached("#intelOwn", ownHtml);

  $("#intelThreshold").value = d.threshold;
  $("#intelThresholdVal").textContent = d.threshold;
  $("#intelSound").checked = d.config.sound !== false;

  const selected = new Set(d.config.channels || []);
  const chans = d.channels || [];
  const channelsHtml = chans.length
    ? chans
        .map(
          (c) => `<label class="chkrow">
            <input type="checkbox" data-ch="${esc(c.name)}" ${selected.has(c.name) ? "checked" : ""}>
            <span class="nm" title="${esc(c.name)}">${esc(c.name)}</span>
            <span class="mt">${c.files}</span>
          </label>`
        )
        .join("")
    : `<div class="intel-empty">Логи не найдены. Проверьте папку Chatlogs.</div>`;
  setHtmlCached("#intelChannels", channelsHtml);

  const alerts = d.alerts || [];
  const countNames = (list) => list.reduce((a, r) => a + (r.names?.length || 1) + (r.extra || 0), 0);
  $("#intelAlertCount").textContent = `${alerts.length} событий · ${countNames(alerts)} пилотов · радиус ${d.threshold}`;
  setHtmlCached(
    "#intelAlerts",
    alerts.length
      ? intelTable(alerts)
      : `<div class="intel-empty">Пока никого рядом. Выберите чаты слева и дождитесь сообщений.</div>`
  );

  const pilots = d.pilots || [];
  $("#intelPilotCount").textContent = `${pilots.length} событий`;
  setHtmlCached("#intelPilots", pilots.length ? intelTable(pilots) : `<div class="intel-empty">Нет упоминаний.</div>`);

  const zkb = d.zkb || [];
  $("#intelZkbCount").textContent = `${zkb.length}`;
  setHtmlCached(
    "#intelZkb",
    zkb.length ? zkbTable(zkb) : `<div class="intel-empty">Подтверждённых записей zKill в радиусе нет.</div>`
  );

  checkIntelAlerts(alerts);
  checkZkbAlerts(zkb);
}

async function loadIntel() {
  try {
    state.intel = await api("/api/intel/state");
    renderIntel();
  } catch (e) {
    toast("Интел: " + e.message, true);
  }
}

function startIntelPoll() {
  clearInterval(state.intelTimer);
  state.intelTimer = setInterval(async () => {
    if (!document.querySelector("#tab-intel")?.classList.contains("active")) return;
    try {
      state.intel = await api("/api/intel/state");
      renderIntel();
    } catch {
      /* ignore */
    }
  }, 2000);
}

async function saveIntelChannels() {
  const checks = [...document.querySelectorAll("#intelChannels input[data-ch]")];
  const channels = checks.filter((c) => c.checked).map((c) => c.dataset.ch);
  try {
    await api("/api/intel/config", { method: "POST", body: JSON.stringify({ channels }) });
    await loadIntel();
    toast("Чаты сохранены");
  } catch (e) {
    toast(e.message, true);
  }
}

// ------------------------------------------------------------------ settings
async function loadBackups() {
  try {
    const r = await api("/api/backup/list");
    const list = r.backups || [];
    const status = $("#backupStatus");
    if (status) status.textContent = list.length ? `файлов: ${list.length}` : "копий пока нет";
    const box = $("#backupList");
    if (box) {
      box.innerHTML = list
        .slice(0, 12)
        .map(
          (b) =>
            `<div class="struct-row">
              <span class="name">${esc(b.name)}</span>
              <span class="meta">${(b.size / 1024).toFixed(1)} КБ</span>
              <span class="meta">${new Date(b.mtime).toLocaleString("ru-RU")}</span>
            </div>`
        )
        .join("");
    }
  } catch {
    /* ignore */
  }
}

function renderSettings() {
  if (!state.cfg) return;
  if ($("#aboutBox")) {
    const v = esc(state.cfg.version || "—");
    const ai = state.cfg.ai || { agent: "DeepSeek Harness", model: "deepseek-flash" };
    $("#aboutBox").innerHTML = `EVE Flip Scanner <b>v${v}</b> · создано с ИИ: ${esc(ai.agent)} / ${esc(
      ai.model
    )} · <a href="https://github.com/Indarli/eve-flip-scanner" target="_blank" rel="noreferrer">GitHub</a>`;
  }
  if ($("#setHistoryBudget")) {
    $("#setHistoryBudget").value = state.cfg.historyBudget ?? 250;
    $("#setCapture").value = state.cfg.capture ?? 0.5;
    $("#setRecentMinutes").value = state.cfg.intel?.recentMinutes ?? 30;
  }

  const ac = autoCfg();
  if ($("#autoScanEnabled")) {
    $("#autoScanEnabled").checked = ac.enabled;
    $("#autoScanMinutes").value = ac.minutes;
    $("#autoScanMargin").value = ac.margin;
  }
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
  loadBackups();
}

function renderDiag(stats) {
  if (!stats) return;
  $("#diag").textContent = `запросов: ${stats.requests}, из кэша: ${stats.cacheHits}, 304: ${stats.notModified}, ошибок: ${stats.errors}, трафик: ${(stats.bytes / 1e6).toFixed(1)} МБ`;
}

// ------------------------------------------------------------------ events
function bindUI() {
  $("#setScannerSave").onclick = async () => {
    try {
      const body = {
        historyBudget: Number($("#setHistoryBudget").value) || 250,
        capture: Number($("#setCapture").value) || 0.5,
        intel: { recentMinutes: Number($("#setRecentMinutes").value) || 30 },
      };
      await api("/api/config", { method: "POST", body: JSON.stringify(body) });
      state.cfg.historyBudget = body.historyBudget;
      state.cfg.capture = body.capture;
      state.cfg.intel = { ...(state.cfg.intel || {}), recentMinutes: body.intel.recentMinutes };
      toast("Сохранено");
    } catch (e) {
      toast(e.message, true);
    }
  };

  $("#autoScanSave").onclick = () => {
    localStorage.setItem("eveflip.auto.enabled", $("#autoScanEnabled").checked ? "1" : "0");
    localStorage.setItem("eveflip.auto.minutes", String(Math.max(5, Number($("#autoScanMinutes").value) || 10)));
    localStorage.setItem("eveflip.auto.margin", String(Math.max(1, Number($("#autoScanMargin").value) || 8)));
    state.autoSeeded = false;
    state.autoSeen = new Set();
    scheduleAutoScan();
    toast("Автоскан сохранён");
  };

  $("#pfRefresh").onclick = () => loadPortfolio(true);
  $("#pfChars").onclick = (e) => {
    const b = e.target.closest("[data-pfchar]");
    if (!b) return;
    state.pfChar = b.dataset.pfchar;
    localStorage.setItem("eveflip.pf.char", state.pfChar);
    state.pfLoaded = false;
    state.pfSeen = new Set();
    loadPortfolio(true);
  };

  $("#btnScan").onclick = startScan;
  $("#esiRetry").onclick = async () => {
    try {
      const st = await api("/api/esi/retry", { method: "POST", body: "{}" });
      updateEsiBanner(st);
      toast(st.down ? "ESI всё ещё недоступен" : "ESI снова доступен", st.down);
    } catch (e) {
      toast(e.message, true);
    }
  };
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
  $("#fHideSk").onchange = (e) => { state.filters.hideSk = e.target.checked; renderTable(); };
  $("#btnCsv").onclick = exportCsv;
  $("#btnPresetSave").onclick = savePreset;
  $("#fPreset").onchange = (e) => { if (e.target.value) applyPreset(e.target.value); };
  renderPresets();
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

  // --- интел ---
  $("#intelThreshold").oninput = (e) => {
    $("#intelThresholdVal").textContent = e.target.value;
  };
  $("#intelThreshold").onchange = async (e) => {
    await api("/api/intel/config", { method: "POST", body: JSON.stringify({ threshold: Number(e.target.value) }) });
    await loadIntel();
  };
  $("#intelSound").onchange = async (e) => {
    await api("/api/intel/config", { method: "POST", body: JSON.stringify({ sound: e.target.checked }) });
  };
  $("#intelSoundPick").onclick = () => $("#intelSoundFile").click();
  $("#intelSoundFile").onchange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2_000_000) {
      toast("Файл больше 2 МБ", true);
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await api("/api/intel/sound", { method: "POST", body: JSON.stringify({ dataUrl: reader.result }) });
        toast("Звук загружен");
        await loadIntel();
      } catch (err) {
        toast(err.message, true);
      }
    };
    reader.readAsDataURL(file);
  };
  $("#intelTestSound").onclick = () => playIntelSound(true);
  $("#intelNotify").checked = localStorage.getItem("eveflip.intel.notify") === "1";
  $("#intelNotify").onchange = async (e) => {
    if (e.target.checked && "Notification" in window && Notification.permission !== "granted") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        e.target.checked = false;
        localStorage.setItem("eveflip.intel.notify", "0");
        toast("Браузер запретил уведомления", true);
        return;
      }
    }
    localStorage.setItem("eveflip.intel.notify", e.target.checked ? "1" : "0");
  };
  $("#intelRefresh").onclick = async () => {
    await api("/api/intel/refresh", { method: "POST", body: "{}" });
    await loadIntel();
    toast("Логи перечитаны");
  };
  $("#intelRescanChannels").onclick = () => loadIntel();
  $("#intelRecalc").onclick = async () => {
    await api("/api/intel/recalc", { method: "POST", body: "{}" });
    await loadIntel();
    toast("Расстояния пересчитаны от текущих систем");
  };
  $("#btnIntelRelogin") && ($("#btnIntelRelogin").onclick = addCharacter);
  $("#intelChannels").addEventListener("change", (e) => {
    if (e.target.matches("input[data-ch]")) saveIntelChannels();
  });
  $("#tab-intel").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-isort]");
    if (th) {
      const key = th.dataset.isort;
      if (state.intelSort.key === key) {
        state.intelSort.dir = state.intelSort.dir === "asc" ? "desc" : "asc";
      } else {
        state.intelSort = { key, dir: "asc" };
      }
      renderIntel();
      return;
    }

    if (e.target.closest("a")) return;
    const tr = e.target.closest("tr[data-ikey]");
    if (tr && tr.dataset.ikey) openIntelRow(tr.dataset.ikey);
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

  $("#btnManualLogin").onclick = async () => {
    const url = $("#manualUrl").value.trim();
    if (!url) return toast("Вставьте адрес обратного вызова", true);
    try {
      await api("/api/auth/manual", { method: "POST", body: JSON.stringify({ url }) });
      const cfg = await api("/api/config");
      applyConfig(cfg);
      renderAuth();
      renderCharacter();
      setTab("pi");
      await loadPi(true);
      toast("Вход выполнен");
    } catch (e) {
      toast("Не удалось: " + e.message, true);
    }
  };

  $("#btnDiagnose").onclick = async () => {
    const out = $("#diagOut");
    out.textContent = "проверяю…";
    try {
      const d = await api("/api/auth/diagnose");
      out.textContent = JSON.stringify(d, null, 2);
    } catch (e) {
      out.textContent = "Ошибка: " + e.message;
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
    $("#btnRefreshChar").disabled = true;
    try {
      await api("/api/character/refresh", { method: "POST", body: "{}" });
      toast("Обновляю данные в фоне…");
      await new Promise((r) => setTimeout(r, 4000));
      const cfg = await api("/api/config");
      applyConfig(cfg);
      renderAuth();
      renderCharacter();
      await loadPi(true);
      toast("Данные обновлены");
    } catch (err) {
      toast(err.message, true);
    } finally {
      $("#btnRefreshChar").disabled = false;
    }
  };

  $("#btnBackupNow").onclick = async () => {
    try {
      const r = await api("/api/backup/now", { method: "POST", body: "{}" });
      toast(`Создано файлов: ${r.files.length}`);
      loadBackups();
    } catch (e) {
      toast(e.message, true);
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
