import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ESI_BASE = "https://esi.evetech.net/latest";
const UA = "EVE-Flip-Scanner/1.0 (local personal tool)";

export class EsiError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = "EsiError";
    this.status = info.status ?? 0;
    this.url = info.url ?? "";
    this.retryAfter = info.retryAfter ?? 0;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withPage(url, page) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}page=${page}`;
}

export { withPage };

export function buildQuery(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export class EsiClient {
  constructor({ cacheDir, getToken = async () => null, ua = UA, maxConcurrent = 6 } = {}) {
    this.cacheDir = cacheDir;
    this.getToken = getToken;
    this.ua = ua;
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
    this.minGap = 60;
    this.lastStart = 0;
    this.penaltyUntil = 0;
    this.stats = { requests: 0, cacheHits: 0, notModified: 0, errors: 0, bytes: 0 };
    if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });
  }

  resetStats() {
    this.stats = { requests: 0, cacheHits: 0, notModified: 0, errors: 0, bytes: 0 };
  }

  async #acquire() {
    for (;;) {
      const now = Date.now();
      if (now < this.penaltyUntil) {
        await sleep(Math.min(this.penaltyUntil - now, 3000));
        continue;
      }
      if (this.active < this.maxConcurrent && now - this.lastStart >= this.minGap) {
        this.active += 1;
        this.lastStart = now;
        return;
      }
      await sleep(10 + Math.random() * 20);
    }
  }

  #release() {
    this.active = Math.max(0, this.active - 1);
  }

  #observe(headers) {
    const rem = Number(headers.get("x-ratelimit-remaining"));
    if (Number.isFinite(rem)) {
      if (rem < 100) this.minGap = 1500;
      else if (rem < 500) this.minGap = 400;
      else if (rem < 2000) this.minGap = 150;
      else this.minGap = 60;
    }
    if (headers.get("x-ratelimit-limit")) {
      this.lastLimit = headers.get("x-ratelimit-limit");
    }
  }

  #expiresAt(headers, fallbackMs = 60_000) {
    const raw = headers.get("expires");
    const t = raw ? Date.parse(raw) : NaN;
    if (Number.isFinite(t) && t > Date.now()) return t;
    return Date.now() + fallbackMs;
  }

  #cacheFile(key) {
    return this.cacheDir ? path.join(this.cacheDir, `${key}.json`) : null;
  }

  #readCache(file) {
    if (!file) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  #writeCache(file, entry) {
    if (!file) return;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry));
      fs.renameSync(tmp, file);
    } catch {
      /* кэш не критичен */
    }
  }

  async #parse(res) {
    const ct = res.headers.get("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());
    this.stats.bytes += buf.length;
    if (ct.includes("json")) {
      return buf.length ? JSON.parse(buf.toString("utf8")) : null;
    }
    return buf.toString("utf8");
  }

  /**
   * GET с кэшем и ретраями.
   * @returns {Promise<{body:any, headers:Headers, status:number, cached?:boolean}>}
   */
  async request(pathOrUrl, opts = {}) {
    const {
      auth = false,
      cache = true,
      method = "GET",
      body = null,
      headers = {},
      retries = 3,
      timeout = 60_000,
    } = opts;

    const url = pathOrUrl.startsWith("http") ? pathOrUrl : ESI_BASE + pathOrUrl;
    const authId = auth ? Number(auth) : null;
    const token = authId ? await this.getToken(authId) : null;
    if (authId && !token) throw new EsiError("Требуется авторизация EVE SSO", { status: 401, url });

    const tokenTag = authId ? `char${authId}` : "pub";
    const key = crypto.createHash("sha1").update(`${method} ${url} ${tokenTag}`).digest("hex");
    const file = method === "GET" && cache ? this.#cacheFile(key) : null;
    const entry = this.#readCache(file);

    if (entry && entry.expiresAt > Date.now()) {
      this.stats.cacheHits += 1;
      return { body: entry.body, headers: new Headers(entry.headers || {}), status: 200, cached: true };
    }

    let lastError = null;

    for (let attempt = 0; attempt < retries; attempt += 1) {
      const h = {
        "User-Agent": this.ua,
        Accept: "application/json",
        ...headers,
      };
      if (token) h.Authorization = `Bearer ${token}`;
      if (entry?.etag) h["If-None-Match"] = entry.etag;

      await this.#acquire();
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: h,
          body,
          signal: AbortSignal.timeout(timeout),
        });
        this.stats.requests += 1;
        this.#observe(res.headers);
      } catch (err) {
        this.#release();
        this.stats.errors += 1;
        lastError = new EsiError(`Сетевая ошибка: ${err.message}`, { url });
        await sleep(800 * (attempt + 1));
        continue;
      }
      this.#release();

      if (res.status === 304 && entry) {
        this.stats.notModified += 1;
        const headersObj = Object.fromEntries(res.headers);
        entry.expiresAt = this.#expiresAt(res.headers, 300_000);
        entry.headers = headersObj;
        this.#writeCache(file, entry);
        return { body: entry.body, headers: res.headers, status: 200, cached: true };
      }

      if (res.status === 420) {
        // Превышен error-limit: ESI блокирует все запросы примерно на минуту.
        this.penaltyUntil = Date.now() + 61_000;
        lastError = new EsiError("ESI error limit (420), пауза 60 c", { status: 420, url });
        await sleep(2000);
        continue;
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 5;
        this.penaltyUntil = Date.now() + retryAfter * 1000;
        lastError = new EsiError(`Rate limit (429), пауза ${retryAfter} c`, { status: 429, url, retryAfter });
        continue;
      }

      if (res.status >= 500) {
        this.stats.errors += 1;
        lastError = new EsiError(`Сервер ESI ${res.status}`, { status: res.status, url });
        await sleep(700 * (attempt + 1));
        continue;
      }

      if (!res.ok) {
        let detail = "";
        try {
          const j = await res.json();
          detail = j?.error || "";
        } catch {}
        const err = new EsiError(`ESI ${res.status}${detail ? `: ${detail}` : ""}`, { status: res.status, url });
        if (res.status === 401 || res.status === 403 || res.status === 404) throw err;
        this.stats.errors += 1;
        lastError = err;
        await sleep(500);
        continue;
      }

      const parsed = await this.#parse(res);
      if (file) {
        this.#writeCache(file, {
          etag: res.headers.get("etag") || null,
          expiresAt: this.#expiresAt(res.headers),
          headers: Object.fromEntries(res.headers),
          body: parsed,
        });
      }
      return { body: parsed, headers: res.headers, status: res.status };
    }

    throw lastError || new EsiError("Не удалось выполнить запрос", { url });
  }

  async get(path, opts) {
    return (await this.request(path, opts)).body;
  }

  async post(path, payload, opts = {}) {
    return (
      await this.request(path, {
        ...opts,
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      })
    ).body;
  }

  /**
   * Пагинация ESI: отдаёт страницы по мере загрузки (по 6 параллельно).
   */
  async *pages(path, opts = {}) {
    const { maxPages = 2000, batch = 6, ...rest } = opts;
    const first = await this.request(withPage(path, 1), rest);
    const total = Math.min(Number(first.headers.get("x-pages") || 1) || 1, maxPages);
    yield { page: 1, total, body: first.body };
    for (let start = 2; start <= total; start += batch) {
      const upTo = Math.min(start + batch, total + 1);
      const reqs = [];
      for (let p = start; p < upTo; p += 1) reqs.push(this.request(withPage(path, p), rest));
      const results = await Promise.all(reqs);
      for (let i = 0; i < results.length; i += 1) {
        yield { page: start + i, total, body: results[i].body };
      }
    }
  }

  /** Все страницы одним массивом (для небольших списков). */
  async pagesAll(path, opts = {}) {
    const out = [];
    for await (const { body } of this.pages(path, opts)) {
      if (Array.isArray(body)) out.push(...body);
    }
    return out;
  }
}

export { ESI_BASE };
