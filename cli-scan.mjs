import { initDirs, loadConfig, loadCharacter, saveResults, CACHE_DIR } from "./lib/store.mjs";
import { EsiClient } from "./lib/esi.mjs";
import { Auth } from "./lib/auth.mjs";
import { runScan } from "./lib/scan.mjs";

initDirs();
const config = loadConfig();
const auth = new Auth({ getConfig: () => config });
const esi = new EsiClient({ cacheDir: CACHE_DIR, getToken: () => auth.token() });
const character = loadCharacter();

const fmt = (n, d = 2) => {
  if (!Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(d) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(d) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return v.toFixed(0);
};

let lastPhase = "";
const res = await runScan({
  esi,
  config,
  character,
  onStatus: (s) => {
    if (s.phase !== lastPhase || s.phase === "books") {
      lastPhase = s.phase;
      const extra = s.phase === "books" ? ` ${s.pagesDone}/${s.pagesTotal}` : s.phase === "history" ? ` ${s.typesDone}/${s.typesTotal}` : "";
      process.stdout.write(`\r${s.message}${extra}                    `);
    }
  },
});
process.stdout.write("\n\n");

saveResults({ rows: res.rows, meta: res.meta });

console.log(`Позиций: ${res.rows.length} · страниц: ${res.meta.pages} · ${(res.meta.durationMs / 1000).toFixed(0)} c · комиссии: ${res.meta.feesSource}`);
if (res.meta.warnings?.length) console.log("Предупреждения:", res.meta.warnings.join(" | "));

const top = res.rows.slice(0, 25);
const head = ["Товар", "Локация", "Buy", "Sell", "Нетто", "ISK/день", "Объём", "Конк."];
console.log(head.map((h) => h.padEnd(12)).join(" "));
for (const r of top) {
  console.log(
    [
      String(r.typeName).slice(0, 30).padEnd(30),
      String(r.locationName).slice(0, 10).padEnd(10),
      fmt(r.bid).padStart(10),
      fmt(r.ask).padStart(10),
      ((r.marginNet * 100).toFixed(1) + "%").padStart(7),
      fmt(r.iskDay).padStart(10),
      fmt(r.volumeDay, 0).padStart(9),
      String(r.competition).padStart(5),
    ].join(" ")
  );
}
