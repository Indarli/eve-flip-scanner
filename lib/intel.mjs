// Интель: разбор локальных чат-логов EVE, сопоставление с ESI/zKillboard.
// Локацию чужих персонажей ESI не отдаёт — используем упоминания в чате + zKill.

import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./store.mjs";

const CHAT_DIR = path.join(process.env.USERPROFILE || process.env.HOME || ".", "Documents", "EVE", "logs", "Chatlogs");
const TAIL_BYTES = 32 * 1024;
const MAX_MESSAGE_AGE = 45 * 60_000;
const RECENT_MS = 20 * 60_000;
const CHANNEL_CONTEXT_MS = 5 * 60_000;

const STOPWORDS = new Set(
  `in on at the a an and or to from with for is are was were be been being this that these those
   gate gates jump jumps jumping dock docked undock undocking clear clr copy paste wtb wts wtt
   lol lmao gf o7 hi hello hey yes no not now here there they them we you i he she it
   все всё это что как где кто там тут уже еще ещё или но да нет привет пока
   гейт гейте гейта прыжок прыжки прыгает док дока доке копия паста
   + - -- ... ..`.split(/\s+/)
);

const normSystem = (s) =>
  String(s || "")
    .toUpperCase()
    .replace(/\*+$/g, "")
    .replace(/[.,!?;:]+$/g, "")
    .trim();

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parseLogName(file) {
  const base = file.replace(/\.txt$/i, "");
  const parts = base.split("_");
  if (parts.length < 4) return null;
  const charId = parts[parts.length - 1];
  const time = parts[parts.length - 2];
  const date = parts[parts.length - 3];
  if (!/^\d{8}$/.test(date) || !/^\d{6}$/.test(time) || !/^\d+$/.test(charId)) return null;
  return { channel: parts.slice(0, -3).join("_"), date, time, charId: Number(charId) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class IntelService {
  constructor({ esi, auth, getConfig, dataDir }) {
    this.esi = esi;
    this.auth = auth;
    this.getConfig = getConfig;
    this.dataDir = dataDir;
    this.systems = new Map();
    this.systemByName = new Map();
    this.systemByNameRaw = new Map();
    this.ready = false;
    this.resolveCache = new Map(); // lower name -> {characters, types, systems, ts}
    this.pilots = new Map(); // key nameLower -> pilot
    this.own = new Map(); // characterId -> {id, name, systemId, systemName, updatedAt}
    this.offsets = new Map();
    this.channelStats = new Map(); // channel -> {files, messages, lastAt}
    this.pending = []; // {msg, candidates}
    this.pendingNames = new Set();
    this.messageCount = 0;
    this.lastMessageAt = null;
    this.zkillQueue = new Set();
    this.zkillBusy = false;
    this.lastZkillAt = 0;
    this.zkillStats = { ok: 0, fail: 0, error: null, ticks: 0, targets: 0 };
    this.typeNames = new Set();
    this.routeCache = new Map();
    this.regions = new Map();
    this.regionPending = new Set();
    this.lastOwnPoll = 0;
    this.timer = null;
    this.resolving = false;
    this.soundFile = null;
  }

  get cfg() {
    return this.getConfig().intel || {};
  }

  get chatDir() {
    return this.cfg.chatDir || CHAT_DIR;
  }

  get selectedChannels() {
    return new Set(this.cfg.channels || []);
  }

  get threshold() {
    return Number(this.cfg.threshold) || 5;
  }

  get recentMs() {
    const minutes = Number(this.cfg.recentMinutes) || 30;
    return Math.min(24 * 60, Math.max(2, minutes)) * 60_000;
  }

  async init() {
    await this.loadSystems();
    this.loadSound();
    this.ready = true;
    this.scanFiles(true);
    this.timer = setInterval(() => {
      try {
        this.scanFiles(false);
        this.pollOwn();
        this.processZkill();
        this.prune();
      } catch (e) {
        console.log(`[intel] tick error: ${e.message}`);
      }
    }, 1500);
    this.pollOwn();
  }

  loadSound() {
    const p = path.join(this.dataDir, "intel-sound");
    for (const ext of [".mp3", ".wav", ".ogg", ".m4a"]) {
      if (fs.existsSync(p + ext)) {
        this.soundFile = p + ext;
        return;
      }
    }
  }

  saveSound(dataUrl) {
    const m = /^data:audio\/([a-z0-9.+-]+);base64,(.+)$/i.exec(String(dataUrl || ""));
    if (!m) throw new Error("Ожидается аудиофайл (data:audio/...;base64)");
    const ext = m[1].includes("mpeg") ? ".mp3" : `.${m[1].replace("x-", "")}`;
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 2_000_000) throw new Error("Файл больше 2 МБ");
    const file = path.join(this.dataDir, "intel-sound" + ext);
    for (const e of [".mp3", ".wav", ".ogg", ".m4a"]) {
      try {
        fs.unlinkSync(path.join(this.dataDir, "intel-sound" + e));
      } catch {}
    }
    fs.writeFileSync(file, buf);
    this.soundFile = file;
    return ext;
  }

  async loadSystems() {
    const file = path.join(this.dataDir, "intel-systems.json");
    const cache = readJson(file, null);
    if (cache?.systems?.length && Date.now() - cache.ts < 7 * 24 * 3600_000) {
      this.#applySystems(cache.systems);
      return;
    }
    const ids = await this.esi.get("/universe/systems/?datasource=tranquility");
    const systems = [];
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      const names = await this.esi.post("/universe/names/?datasource=tranquility", chunk);
      for (const n of names || []) {
        if (n.category === "solar_system") systems.push({ id: n.id, name: n.name });
      }
    }
    writeJson(file, { ts: Date.now(), systems });
    this.#applySystems(systems);
  }

  #applySystems(systems) {
    this.systems = new Map(systems.map((s) => [s.id, s]));
    this.systemByName = new Map();
    for (const s of systems) {
      const key = normSystem(s.name);
      this.systemByName.set(key, s.id);
      this.systemByNameRaw.set(s.name.toLowerCase(), s.id);
    }
  }

  encodingOf(file) {
    if (!this.encodings) this.encodings = new Map();
    if (this.encodings.has(file)) return this.encodings.get(file);
    let enc = "utf8";
    try {
      const fd = fs.openSync(file, "r");
      const b = Buffer.alloc(2);
      fs.readSync(fd, b, 0, 2, 0);
      fs.closeSync(fd);
      if (b[0] === 0xff && b[1] === 0xfe) enc = "utf16le";
      else if (b[0] === 0xfe && b[1] === 0xff) enc = "utf16be";
    } catch {
      /* оставим utf8 */
    }
    this.encodings.set(file, enc);
    return enc;
  }

  // ---------------------------------------------------------------- files

  scanFiles(initial = false) {
    const dir = this.chatDir;
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".txt"));
    } catch {
      return;
    }

    const selected = this.selectedChannels;
    if (!selected.size) return;

    for (const file of files) {
      const info = parseLogName(file);
      if (!info) continue;
      if (!selected.has(info.channel)) continue;

      const full = path.join(dir, file);
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }

      let offset = this.offsets.get(full);
      if (offset === undefined) {
        offset = initial ? Math.max(0, size - TAIL_BYTES) : size;
        this.offsets.set(full, offset);
        if (!initial) continue;
      }
      if (size < offset) offset = 0;
      if (size === offset) continue;

      let text = "";
      try {
        const fd = fs.openSync(full, "r");
        const len = size - offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        fs.closeSync(fd);
        const enc = this.encodingOf(full);
        if (enc === "utf16le") {
          const aligned = offset % 2 === 0 ? buf : buf.subarray(1);
          text = aligned.toString("utf16le");
        } else if (enc === "utf16be") {
          const aligned = offset % 2 === 0 ? buf : buf.subarray(1);
          const swapped = Buffer.from(aligned);
          swapped.swap16();
          text = swapped.toString("utf16le");
        } else {
          text = buf.toString("utf8");
        }
      } catch {
        continue;
      }
      this.offsets.set(full, size);

      let lines = text.split(/\r?\n/);
      if (offset > 0) lines = lines.slice(1); // первая строка может быть обрезана

      for (const raw of lines) {
        const line = stripBom(raw);
        const m = /^\[\s*(\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2})\s*\]\s*(.+?)\s*>\s?(.*)$/.exec(line);
        if (!m) continue;
        const sender = m[2].trim();
        if (/^(Система EVE|EVE System)$/i.test(sender)) continue;
        const ts = Date.parse(m[1].replace(/\./g, "-").replace(" ", "T") + "Z");
        if (!Number.isFinite(ts) || Date.now() - ts > this.recentMs) continue; // интель — только «сейчас»
        this.handleMessage({ ts, channel: info.channel, sender, text: m[3] });
      }

      const stat = this.channelStats.get(info.channel) || { files: 0, messages: 0, lastAt: 0 };
      stat.files += 0;
      this.channelStats.set(info.channel, stat);
    }
  }

  handleMessage(msg) {
    if (!msg.text || msg.text.length > 400) return;

    // служебные сообщения локального канала: «Канал изменен на Локальный: ABC-123*»
    if (/^(Канал изменен|Channel changed)/i.test(msg.text)) {
      const { systems } = this.parseText(msg.text);
      if (systems[0]) {
        if (!this.channelContext) this.channelContext = new Map();
        this.channelContext.set(msg.channel, { systemId: systems[0], ts: Date.now() });
      }
      return;
    }
    if (/(has joined|has left|joined the .*channel|left the .*channel)/i.test(msg.text)) return;

    this.messageCount += 1;
    this.lastMessageAt = msg.ts || Date.now();

    const stat = this.channelStats.get(msg.channel) || { files: 0, messages: 0, lastAt: 0 };
    stat.messages += 1;
    stat.lastAt = Math.max(stat.lastAt, msg.ts || Date.now());
    this.channelStats.set(msg.channel, stat);

    const { systems, candidates } = this.parseText(msg.text);

    let systemId = systems[0] || null;
    if (!systemId) {
      const ctx = this.channelContext?.get(msg.channel);
      if (ctx && Date.now() - ctx.ts < CHANNEL_CONTEXT_MS) systemId = ctx.systemId;
    } else {
      if (!this.channelContext) this.channelContext = new Map();
      this.channelContext.set(msg.channel, { systemId, ts: Date.now() });
    }

    if (!candidates.length) return;

    const pending = { msg, systemId, candidates };
    const unresolved = candidates.filter((c) => !this.resolveCache.has(c.toLowerCase()));
    if (!unresolved.length) {
      this.applyMessage(pending);
      return;
    }
    this.pending.push(pending);
    for (const c of unresolved) this.pendingNames.add(c);
    if (this.pending.length > 400) this.pending.splice(0, this.pending.length - 400);
    if (this.pendingNames.size > 8000) {
      let n = 0;
      for (const v of this.pendingNames) {
        this.pendingNames.delete(v);
        if (++n >= 2000) break;
      }
    }
    this.scheduleResolve();
  }

  parseText(text) {
    const tokens = text
      .replace(/[()[\]{}"”“]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    const systems = [];
    const used = new Set();

    for (let i = 0; i < tokens.length; i += 1) {
      if (used.has(i)) continue;
      for (let n = 3; n >= 1; n -= 1) {
        const phrase = tokens.slice(i, i + n).join(" ");
        const key = normSystem(phrase);
        const id = this.systemByName.get(key);
        if (id) {
          systems.push(id);
          for (let k = 0; k < n; k += 1) used.add(i + k);
          break;
        }
      }
    }

    const clean = [];
    for (let i = 0; i < tokens.length; i += 1) {
      if (used.has(i)) continue;
      const t = tokens[i].replace(/^[*]+|[*.,!?;:]+$/g, "");
      if (!t) continue;
      if (/^\d+[+x]?$/.test(t)) continue;
      if (t.length < 3 || t.length > 28) continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9'’.\- ]*$/.test(t)) continue; // имена в EVE латиницей
      if (!/[A-Za-z]/.test(t)) continue;
      if (STOPWORDS.has(t.toLowerCase())) continue;
      clean.push(t);
    }

    // кандидаты: 1–2 слова подряд
    const candidates = new Set();
    for (let i = 0; i < clean.length; i += 1) {
      for (let n = 1; n <= 2; n += 1) {
        const phrase = clean.slice(i, i + n).join(" ");
        if (phrase.length < 3 || phrase.length > 40) break;
        candidates.add(phrase);
      }
    }

    return { systems, candidates: [...candidates].slice(0, 40) };
  }

  scheduleResolve() {
    if (this.resolving) return;
    this.resolving = true;
    setTimeout(async () => {
      try {
        const names = [...this.pendingNames].slice(0, 2000);
        for (const n of names) this.pendingNames.delete(n);
        for (let i = 0; i < names.length; i += 500) {
          const chunk = names.slice(i, i + 500);
          try {
            const res = await this.esi.post("/universe/ids/?datasource=tranquility", chunk);
            const byName = new Map();
            for (const c of res?.characters || []) byName.set(c.name.toLowerCase(), { kind: "character", ...c });
            for (const t of res?.inventory_types || []) {
              const k = t.name.toLowerCase();
              if (!byName.has(k)) byName.set(k, { kind: "type", ...t });
              this.typeNames.add(k);
            }
            for (const s of res?.systems || []) byName.set(s.name.toLowerCase(), { kind: "system", ...s });
            for (const n of chunk) {
              const hit = byName.get(n.toLowerCase()) || null;
              this.resolveCache.set(n.toLowerCase(), { hit, ts: Date.now() });
            }
          } catch (e) {
            this.lastResolveError = e.message;
            for (const n of chunk) this.resolveCache.set(n.toLowerCase(), { hit: null, ts: Date.now() });
          }
          await sleep(120);
        }
        const still = [];
        for (const p of this.pending) {
          if (p.candidates.some((c) => !this.resolveCache.has(c.toLowerCase()))) still.push(p);
          else this.applyMessage(p);
        }
        this.pending = still;
      } finally {
        this.resolving = false;
        if (this.pending.length || this.pendingNames.size) this.scheduleResolve();
      }
    }, 150);
  }

  applyMessage({ msg, systemId, candidates }) {
    this.debug = this.debug || { applied: 0, charHits: 0, sample: [] };
    this.debug.applied += 1;
    if (this.debug.sample.length < 12) this.debug.sample.push({ text: msg.text.slice(0, 80), candidates: candidates.slice(0, 6) });

    const now = msg.ts || Date.now();
    let ship = null;
    for (const c of candidates) {
      const r = this.resolveCache.get(c.toLowerCase())?.hit;
      if (r?.kind === "type") ship = r.name;
    }

    // из одинаковых совпадений («Delias» и «Delias Salmetti») оставляем самое длинное имя
    const hits = [];
    for (const c of candidates) {
      const r = this.resolveCache.get(c.toLowerCase())?.hit;
      if (r?.kind === "character") hits.push(r);
    }
    const uniq = new Map(hits.map((h) => [h.name.toLowerCase(), h]));
    let bestHits = [...uniq.values()].filter((h) => !this.typeNames.has(h.name.toLowerCase()));
    if (!bestHits.length) bestHits = [...uniq.values()];
    bestHits = bestHits.filter(
      (h) =>
        ![...uniq.values()].some(
          (o) => o.name.length > h.name.length && o.name.toLowerCase().includes(h.name.toLowerCase())
        )
    );

    for (const r of bestHits) {
      this.debug = this.debug || { applied: 0, charHits: 0, sample: [] };
      this.debug.charHits += 1;
      const key = r.name.toLowerCase();
      const prev = this.pilots.get(key) || {};
      this.pilots.set(key, {
        id: r.id,
        name: prev.name || r.name,
        systemId: systemId || prev.systemId || null,
        ship: ship || prev.ship || null,
        source: "chat",
        channel: msg.channel,
        ts: now,
        zkb: `https://zkillboard.com/character/${r.id}/`,
        zkill: prev.zkill || null,
      });
    }
  }

  // ---------------------------------------------------------------- own position

  async pollOwn() {
    if (Date.now() - this.lastOwnPoll < 12_000) return;
    this.lastOwnPoll = Date.now();
    for (const a of this.auth.list()) {
      try {
        const loc = await this.esi.get(`/characters/${a.characterId}/location/`, { auth: a.characterId });
        const sys = this.systems.get(loc.solar_system_id);
        this.own.set(a.characterId, {
          id: a.characterId,
          name: a.name,
          systemId: loc.solar_system_id,
          systemName: sys?.name || null,
          updatedAt: Date.now(),
        });
      } catch {
        /* персонаж без scope/локации */
      }
    }
  }

  /** Мгновенный ответ из кэша; недостающие маршруты догружаются в фоне. */
  jumpsCached(from, to) {
    if (!from || !to) return null;
    if (Number(from) === Number(to)) return 0;
    const key = `${from}:${to}`;
    const hit = this.routeCache.get(key);
    if (hit && Date.now() - hit.ts < 30 * 60_000) return hit.jumps;

    if (!this.routePending) this.routePending = new Set();
    if (!this.routePending.has(key)) {
      this.routePending.add(key);
      this.esi
        .get(`/route/${from}/${to}/?datasource=tranquility&flag=shortest`)
        .then((route) => {
          const jumps = Array.isArray(route) ? route.length - 1 : null;
          this.routeCache.set(key, { jumps, ts: Date.now() });
        })
        .catch(() => {
          this.routeCache.set(key, { jumps: null, ts: Date.now() });
        })
        .finally(() => this.routePending.delete(key));
    }
    return null;
  }

  // ---------------------------------------------------------------- zKill

  async processZkill() {
    this.zkillStats.ticks += 1;
    if (this.zkillBusy || Date.now() - this.lastZkillAt < 1100) return;
    const now = Date.now();
    const zkillWindow = Math.min(this.recentMs, 3 * 3600_000);
    const target = [...this.pilots.values()].find(
      (p) =>
        p.id &&
        now - p.ts < zkillWindow &&
        (!p.zkillTs || now - p.zkillTs > 120_000) &&
        !this.zkillQueue.has(p.id)
    );
    if (!target) return;
    target.zkillTs = now;
    this.zkillStats.targets += 1;

    this.zkillBusy = true;
    this.zkillQueue.add(target.id);
    this.lastZkillAt = now;
    try {
      const res = await fetch(`https://zkillboard.com/api/characterID/${target.id}/`, {
        headers: { "User-Agent": "EVE-Flip-Intel/1.0", Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        this.zkillStats.fail += 1;
        return;
      }
      const arr = await res.json();
      if (!Array.isArray(arr) || !arr.length) return;
      const latest = arr
        .filter((k) => k.killmail_time)
        .sort((a, b) => Date.parse(b.killmail_time) - Date.parse(a.killmail_time))[0];
      if (!latest) return;

      let shipTypeId = null;
      if (Number(latest.victim?.character_id) === Number(target.id)) shipTypeId = latest.victim?.ship_type_id;
      else {
        const attacker = (latest.attackers || []).find((a) => Number(a.character_id) === Number(target.id));
        shipTypeId = attacker?.ship_type_id;
      }

      const pilot = this.pilots.get(target.name.toLowerCase());
      if (!pilot) return;
      let shipName = null;
      if (shipTypeId) {
        this.typeNameCache = this.typeNameCache || new Map();
        if (!this.typeNameCache.has(shipTypeId)) {
          try {
            const t = await this.esi.get(`/universe/types/${shipTypeId}/`);
            this.typeNameCache.set(shipTypeId, t?.name || null);
          } catch {
            this.typeNameCache.set(shipTypeId, null);
          }
        }
        shipName = this.typeNameCache.get(shipTypeId) || null;
      }
      pilot.zkill = {
        ts: Date.now(),
        time: latest.killmail_time,
        systemId: latest.solar_system_id,
        shipTypeId,
        shipName,
        link: latest.killmail_id ? `https://zkillboard.com/kill/${latest.killmail_id}/` : null,
      };
      this.zkillStats.ok += 1;

      // если чат молчит давно и килл свежий — подтягиваем позицию с киллборда
      const chatFresh = Date.now() - pilot.ts < 10 * 60_000;
      const killFresh = Date.now() - (Date.parse(latest.killmail_time) || 0) < 2 * 3600_000;
      if (!chatFresh && killFresh && latest.solar_system_id) {
        pilot.systemId = latest.solar_system_id;
        pilot.source = "zkill";
        pilot.ts = Math.max(pilot.ts, Date.parse(latest.killmail_time) || pilot.ts);
      }
    } catch (e) {
      this.zkillStats.fail += 1;
      this.zkillStats.error = e.message;
    } finally {
      this.zkillBusy = false;
      this.zkillQueue.delete(target.id);
    }
  }

  prune() {
    const now = Date.now();
    const maxAge = Math.max(MAX_MESSAGE_AGE, this.recentMs);
    for (const [key, p] of this.pilots) {
      if (now - p.ts > maxAge && !(p.zkill && now - p.zkill.ts < maxAge)) {
        this.pilots.delete(key);
      }
    }
    if (this.pilots.size > 800) {
      const sorted = [...this.pilots.entries()].sort((a, b) => b[1].ts - a[1].ts);
      this.pilots = new Map(sorted.slice(0, 800));
    }
  }

  // ---------------------------------------------------------------- channels

  listChannels() {
    const dir = this.chatDir;
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".txt"));
    } catch {
      return [];
    }
    const map = new Map();
    for (const f of files) {
      const info = parseLogName(f);
      if (!info) continue;
      const st = map.get(info.channel) || { name: info.channel, files: 0, lastAt: 0, chars: new Set() };
      st.files += 1;
      st.chars.add(info.charId);
      try {
        const stat = fs.statSync(path.join(dir, f));
        st.lastAt = Math.max(st.lastAt, stat.mtimeMs);
      } catch {}
      map.set(info.channel, st);
    }
    return [...map.values()]
      .map((s) => ({ name: s.name, files: s.files, chars: s.chars.size, lastAt: s.lastAt }))
      .sort((a, b) => b.lastAt - a.lastAt);
  }

  // ---------------------------------------------------------------- state

  /** Регион системы: из кэша, иначе догружается в фоне (эндпоинта «все системы» нет). */
  regionOf(systemId) {
    if (!systemId) return null;
    const hit = this.regions.get(systemId);
    if (hit) return hit;
    if (this.regionPending.has(systemId)) return null;
    this.regionPending.add(systemId);
    (async () => {
      try {
        const sys = await this.esi.get(`/universe/systems/${systemId}/`);
        let regionId = null;
        if (sys?.constellation_id) {
          const cons = await this.esi.get(`/universe/constellations/${sys.constellation_id}/`);
          regionId = cons?.region_id ?? null;
        }
        let regionName = null;
        if (regionId) {
          const region = await this.esi.get(`/universe/regions/${regionId}/`);
          regionName = region?.name || null;
        }
        this.regions.set(systemId, { regionId, regionName });
      } catch {
        this.regions.set(systemId, { regionId: null, regionName: null });
      } finally {
        this.regionPending.delete(systemId);
      }
    })();
    return null;
  }

  async snapshot() {
    const own = [...this.own.values()];
    const pilots = [];
    const recent = [...this.pilots.values()].sort((a, b) => b.ts - a.ts).slice(0, 150);
    for (const p of recent) {
      let best = null;
      for (const o of own) {
        if (!o.systemId) continue;
        const j = this.jumpsCached(o.systemId, p.systemId);
        if (j === null) continue;
        if (!best || j < best.jumps) best = { jumps: j, character: o.name, systemId: o.systemId, systemName: o.systemName };
      }
      const sys = p.systemId ? this.systems.get(p.systemId) : null;
      const region = this.regionOf(p.systemId);
      const zkShip = p.zkill?.shipName || (p.zkill?.shipTypeId ? `type ${p.zkill.shipTypeId}` : null);
      pilots.push({
        name: p.name,
        id: p.id,
        systemId: p.systemId,
        systemName: sys?.name || null,
        regionId: region?.regionId ?? null,
        regionName: region?.regionName || null,
        ship: p.ship || zkShip,
        source: p.source,
        channel: p.channel,
        ts: p.ts,
        ageSec: Math.round((Date.now() - p.ts) / 1000),
        zkb: p.zkb,
        zkill: p.zkill?.link || null,
        zkillTime: p.zkill?.time || null,
        jumps: best?.jumps ?? null,
        nearest: best?.character || null,
      });
    }
    pilots.sort((a, b) => (a.jumps ?? 999) - (b.jumps ?? 999));
    return {
      ready: this.ready,
      chatDir: this.chatDir,
      threshold: this.threshold,
      config: {
        channels: this.cfg.channels || [],
        threshold: this.threshold,
        sound: this.cfg.sound !== false,
        hasSound: Boolean(this.soundFile),
      },
      own,
      pilots,
      alerts: pilots.filter((p) => p.jumps !== null && p.jumps <= this.threshold),
      channels: this.listChannels(),
      stats: {
        messages: this.messageCount,
        pilots: this.pilots.size,
        lastMessageAt: this.lastMessageAt,
        pending: this.pending.length,
        pendingNames: this.pendingNames.size,
        resolved: this.resolveCache.size,
        resolveError: this.lastResolveError || null,
        routes: this.routeCache.size,
        zkill: { ...this.zkillStats, windowSec: Math.round(Math.min(this.recentMs, 3 * 3600_000) / 1000) },
      },
      thresholdValue: this.threshold,
    };
  }
}
