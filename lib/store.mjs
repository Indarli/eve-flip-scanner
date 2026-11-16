import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT, "data");
export const CACHE_DIR = path.join(DATA_DIR, "cache");
export const PUBLIC_DIR = path.join(ROOT, "public");

/** Пять NPC-хабов: станция, регион, система. ID проверены по ESI/фузворку. */
export const HUBS = [
  { key: "jita", name: "Jita 4-4", stationId: 60003760, regionId: 10000002, systemId: 30000142 },
  { key: "amarr", name: "Amarr VIII", stationId: 60008494, regionId: 10000043, systemId: 30002187 },
  { key: "dodixie", name: "Dodixie IX-20", stationId: 60011866, regionId: 10000032, systemId: 30002659 },
  { key: "rens", name: "Rens VI-8", stationId: 60004588, regionId: 10000030, systemId: 30002510 },
  { key: "hek", name: "Hek VIII-12", stationId: 60005686, regionId: 10000042, systemId: 30002053 },
];

export const DEFAULT_CONFIG = {
  clientId: "",
  callbackUrl: "http://127.0.0.1:8787/callback",
  hubs: { jita: true, amarr: true, dodixie: true, rens: true, hek: true },
  /** @type {{id:number,name?:string,tax?:number}[]} */
  structures: [],
  /** доля дневного объёма, которую считаем реалистично «своей» (консервативность) */
  capture: 0.5,
  /** сколько пар (тип, регион) максимум обогащать историей за один скан */
  historyBudget: 250,
  /** предполагаемая ставка владельца структуры, если неизвестна */
  defaultStructureTax: 0.01,
  filters: {
    minMargin: 0.02,
    minVolume: 10,
    minPrice: 100,
    maxPrice: 2_000_000_000,
  },
  intel: {
    chatDir: "",
    channels: [],
    threshold: 5,
    sound: true,
    recentMinutes: 30,
  },
  server: { port: 8787, host: "127.0.0.1" },
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function initDirs() {
  ensureDir(DATA_DIR);
  ensureDir(CACHE_DIR);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

const CONFIG_FILE = () => path.join(DATA_DIR, "config.json");
const TOKENS_FILE = () => path.join(DATA_DIR, "tokens.json");
const CHARACTER_FILE = () => path.join(DATA_DIR, "character.json");
const CHARACTERS_FILE = () => path.join(DATA_DIR, "characters.json");
const RESULTS_FILE = () => path.join(DATA_DIR, "results.json");
const SCAN_META_FILE = () => path.join(DATA_DIR, "scan-meta.json");
const PI_CACHE_FILE = () => path.join(DATA_DIR, "pi-cache.json");
const NAMES_FILE = () => path.join(DATA_DIR, "names.json");

export function loadConfig() {
  const saved = readJson(CONFIG_FILE(), {}) || {};
  return {
    ...DEFAULT_CONFIG,
    ...saved,
    hubs: { ...DEFAULT_CONFIG.hubs, ...(saved.hubs || {}) },
    filters: { ...DEFAULT_CONFIG.filters, ...(saved.filters || {}) },
    intel: { ...DEFAULT_CONFIG.intel, ...(saved.intel || {}) },
    server: { ...DEFAULT_CONFIG.server, ...(saved.server || {}) },
    structures: Array.isArray(saved.structures) ? saved.structures : [],
  };
}

export function saveConfig(cfg) {
  writeJson(CONFIG_FILE(), cfg);
}

export function loadTokens() {
  const raw = readJson(TOKENS_FILE(), null);
  if (!raw) return { characters: {} };
  if (raw.characters && typeof raw.characters === "object") return raw;
  // миграция со старого формата (один персонаж)
  if (raw.access_token && raw.character_id) {
    return { characters: { [raw.character_id]: raw } };
  }
  return { characters: {} };
}
export function saveTokens(tokens) {
  const value = tokens && Object.keys(tokens.characters || {}).length ? tokens : null;
  if (!value) {
    try {
      fs.unlinkSync(TOKENS_FILE());
    } catch {}
    return;
  }
  writeJson(TOKENS_FILE(), value);
}

export function loadCharacters() {
  const raw = readJson(CHARACTERS_FILE(), null);
  if (raw && typeof raw === "object") return raw;
  const single = readJson(CHARACTER_FILE(), null);
  if (single?.characterId) return { [single.characterId]: single };
  return {};
}
export function saveCharacters(map) {
  writeJson(CHARACTERS_FILE(), map || {});
}

export function loadPiCache() {
  return readJson(PI_CACHE_FILE(), null);
}
export function savePiCache(value) {
  writeJson(PI_CACHE_FILE(), value);
}

export function loadNames() {
  return readJson(NAMES_FILE(), null) || {};
}
export function saveNames(map) {
  writeJson(NAMES_FILE(), map);
}

export function loadCharacter() {
  return readJson(CHARACTER_FILE(), null);
}
export function saveCharacter(c) {
  writeJson(CHARACTER_FILE(), c);
}

export function loadResults() {
  return readJson(RESULTS_FILE(), null);
}
export function saveResults(r) {
  writeJson(RESULTS_FILE(), r);
}

export function loadScanMeta() {
  return readJson(SCAN_META_FILE(), null);
}
export function saveScanMeta(m) {
  writeJson(SCAN_META_FILE(), m);
}
