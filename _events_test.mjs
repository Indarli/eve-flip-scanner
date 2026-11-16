const base = "http://127.0.0.1:8787";
await fetch(base + "/api/intel/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channels: ["Pilot BetaAlts"], chatDir: "", recentMinutes: 1440 }) });
await new Promise(r => setTimeout(r, 12000));
const s = await (await fetch(base + "/api/intel/state")).json();
console.log("events", s.stats.events, "rows", s.pilots.length);
for (const r of s.pilots.slice(0, 8)) {
  console.log(`[${r.systemName||"-"} ${r.regionName||""}] names(${r.names.length}): ${r.names.map(n=>n.name).join(", ")}${r.extra?` +${r.extra}`:""} | jumps=${r.jumps}`);
}
await fetch(base + "/api/intel/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channels: ["southeast.imperium", "Gank-Intel"], recentMinutes: 30 }) });
