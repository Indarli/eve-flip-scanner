import test from "node:test";
import assert from "node:assert/strict";
import { IntelService } from "../lib/intel.mjs";

function makeSvc() {
  const svc = new IntelService({
    esi: { get: async () => ({}), post: async () => ({}) },
    auth: { list: () => [], has: () => false },
    getConfig: () => ({ intel: { threshold: 5, recentMinutes: 60 } }),
    dataDir: "./data",
  });
  svc.systemByName = new Map([["JITA", 30000142]]);
  svc.systems = new Map([[30000142, { id: 30000142, name: "Jita" }]]);
  svc.own = new Map();
  return svc;
}

const msg = (text, channel = "test") => ({ ts: Date.now(), channel, sender: "Tester", text });

test("parseText находит систему", () => {
  const svc = makeSvc();
  const { systems } = svc.parseText("Jita* Pilot One");
  assert.deepEqual(systems, [30000142]);
});

test("clr очищает систему целиком", () => {
  const svc = makeSvc();
  svc.events.set("a", {
    key: "a",
    ts: Date.now(),
    channel: "test",
    systemId: 30000142,
    ship: null,
    extra: 0,
    names: new Map([["p", { name: "P", id: 1 }]]),
  });
  svc.pilots.set("p", { name: "P", id: 1, systemId: 30000142 });

  svc.handleMessage(msg("Jita clr"));

  assert.equal(svc.events.size, 0);
  assert.equal(svc.pilots.size, 0);
});

test("стоп-слова и словосочетания не становятся пилотами", () => {
  const svc = makeSvc();
  const { candidates } = svc.parseText(
    "Jita* ESS Sisters Combat Combat Scanner Scanner Probe SURE STATUS Pilot One"
  );
  const lower = candidates.map((c) => c.toLowerCase());
  for (const bad of ["ess", "sure", "status", "sisters combat", "combat scanner", "scanner probe"]) {
    assert.ok(!lower.includes(bad), `лишний кандидат: ${bad}`);
  }
  assert.ok(lower.includes("pilot one"));
});

test("ники, +N и корабль из текста; тип не становится пилотом", () => {
  const svc = makeSvc();
  svc.resolveCache.set("pilot one", {
    hit: { kind: "character", id: 1, name: "Pilot One" },
    type: null,
    ts: Date.now(),
  });
  svc.resolveCache.set("deluge", {
    hit: { kind: "character", id: 2, name: "Deluge" },
    type: { id: 81046, name: "Deluge" },
    ts: Date.now(),
  });
  svc.typeNames.add("deluge");
  svc.shipCache.set(81046, true);

  svc.handleMessage(msg("Jita* Pilot One +6 Deluge"));

  const ev = [...svc.events.values()][0];
  assert.ok(ev, "событие создано");
  assert.equal(ev.extra, 6);
  assert.equal(ev.ship, "Deluge");
  assert.deepEqual([...ev.names.keys()], ["pilot one"]);
  assert.equal(svc.pilots.has("deluge"), false);
});

test("ZKB рядом: только потери за последние 30 минут", async () => {
  const svc = makeSvc();
  svc.systems = new Map([
    [30000142, { id: 30000142, name: "Jita" }],
    [30002187, { id: 30002187, name: "Amarr" }],
  ]);
  svc.own = new Map([[1, { id: 1, name: "Me", systemId: 30000142, systemName: "Jita", online: true }]]);
  svc.routeCache.set("30000142:30002187", { jumps: 2, ts: Date.now() });

  const now = Date.now();
  const link = (n) => `https://zkillboard.com/kill/${n}/`;
  svc.pilots.set("loss pilot", {
    name: "Loss Pilot",
    id: 2,
    ts: now,
    zkill: { link: link(1), isLoss: true, time: new Date(now - 10 * 60000).toISOString(), systemId: 30002187, shipName: "Rifter" },
  });
  svc.pilots.set("kill pilot", {
    name: "Kill Pilot",
    id: 3,
    ts: now,
    zkill: { link: link(2), isLoss: false, time: new Date(now - 10 * 60000).toISOString(), systemId: 30002187, shipName: "Loki" },
  });
  svc.pilots.set("old loss", {
    name: "Old Loss",
    id: 4,
    ts: now,
    zkill: { link: link(3), isLoss: true, time: new Date(now - 40 * 60000).toISOString(), systemId: 30002187, shipName: "Hulk" },
  });

  const s = await svc.snapshot();
  assert.deepEqual(s.zkb.map((z) => z.name), ["Loss Pilot"]);
  assert.equal(s.zkb[0].isLoss, true);
});

test("корабль не подставляется, если его не было в тексте", () => {
  const svc = makeSvc();
  svc.resolveCache.set("pilot one", {
    hit: { kind: "character", id: 1, name: "Pilot One" },
    type: null,
    ts: Date.now(),
  });
  svc.pilots.set("pilot one", {
    name: "Pilot One",
    id: 1,
    systemId: 30000142,
    zkill: { shipName: "Rifter", time: new Date().toISOString() },
  });

  svc.handleMessage(msg("Jita* Pilot One"));

  const ev = [...svc.events.values()][0];
  assert.equal(ev.ship, null);
});
