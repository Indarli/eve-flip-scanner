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
