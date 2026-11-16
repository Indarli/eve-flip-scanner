import { HUBS, DEFAULT_CONFIG } from "./store.mjs";
import { salesTax, npcBrokerFee, structureBrokerFee } from "./fees.mjs";

const SKILL_NAMES = {
  accounting: "Accounting",
  brokerRelations: "Broker Relations",
  advancedBrokerRelations: "Advanced Broker Relations",
  trade: "Trade",
  retail: "Retail",
  wholesale: "Wholesale",
  tycoon: "Tycoon",
  marketing: "Marketing",
  procurement: "Procurement",
  daytrading: "Daytrading",
  visibility: "Visibility",
};

export function defaultFees() {
  return {
    source: "default",
    tax: salesTax(5),
    broker: npcBrokerFee({ brokerRelations: 5, factionStanding: 0, corpStanding: 0 }),
    accounting: 5,
    brokerRelations: 5,
    factionStanding: 0,
    corpStanding: 0,
  };
}

async function safe(fn, fallback = null) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export async function loadCharacter({ esi, auth, config, characterId }) {
  const id = Number(characterId) || Number(auth.list()[0]?.characterId);
  if (!id) throw new Error("Нет активной авторизации");

  const [wallet, skillsRaw, standingsRaw, location, orders, assets] = await Promise.all([
    safe(() => esi.get(`/characters/${id}/wallet/`, { auth: id }), 0),
    safe(() => esi.get(`/characters/${id}/skills/`, { auth: id }), { skills: [] }),
    safe(() => esi.get(`/characters/${id}/standings/`, { auth: id }), []),
    safe(() => esi.get(`/characters/${id}/location/`, { auth: id }), null),
    safe(() => esi.pagesAll(`/characters/${id}/orders/?datasource=tranquility`, { auth: id, maxPages: 20 }), []),
    safe(() => esi.pagesAll(`/characters/${id}/assets/?datasource=tranquility`, { auth: id, maxPages: 40 }), []),
  ]);

  let colonies = [];
  let coloniesError = null;
  try {
    colonies = await esi.get(`/characters/${id}/planets/?datasource=tranquility`, { auth: id });
  } catch (e) {
    coloniesError =
      e.status === 403
        ? "нет доступа к планетарке — нужен повторный вход (scope esi-planets.manage_planets.v1)"
        : e.message;
  }

  // --- навыки: имена через /universe/names/, чтобы не хардкодить id ---
  const skillsArr = skillsRaw?.skills || [];
  const ids = skillsArr.map((s) => s.skill_id).slice(0, 1000);
  const names = [];
  if (ids.length) {
    for (let i = 0; i < ids.length; i += 900) {
      const chunk = ids.slice(i, i + 900);
      const part = await safe(() => esi.post("/universe/names/?datasource=tranquility", chunk), []);
      if (Array.isArray(part)) names.push(...part);
    }
  }
  const nameById = new Map(names.map((n) => [n.id, n.name]));
  const levelByName = new Map();
  for (const s of skillsArr) {
    const n = nameById.get(s.skill_id);
    if (n) levelByName.set(n, s.trained_skill_level ?? s.active_skill_level ?? 0);
  }
  const levels = {};
  for (const [key, name] of Object.entries(SKILL_NAMES)) {
    levels[key] = levelByName.get(name) ?? 0;
  }
  // если скиллы недоступны (не выдан scope), не занижаем комиссии до нуля — берём оценку
  if (!skillsArr.length) {
    levels.accounting = 5;
    levels.brokerRelations = 5;
  }
  const maxOrders = 5 + 4 * levels.trade + 8 * levels.retail + 16 * levels.wholesale + 32 * levels.tycoon;

  // --- стендинги ---
  const standings = new Map();
  if (Array.isArray(standingsRaw)) {
    for (const s of standingsRaw) standings.set(s.from_id, s.standing);
  }

  // --- владельцы NPC-станций (для брокерской комиссии) ---
  const hubFees = {};
  await Promise.all(
    HUBS.map(async (hub) => {
      const station = await safe(() => esi.get(`/universe/stations/${hub.stationId}/`), null);
      const ownerId = station?.owner ?? null;
      let factionId = null;
      if (ownerId) {
        const corp = await safe(() => esi.get(`/universe/corporations/${ownerId}/`), null);
        factionId = corp?.faction_id ?? null;
      }
      const factionStanding = factionId ? standings.get(factionId) ?? 0 : 0;
      const corpStanding = ownerId ? standings.get(ownerId) ?? 0 : 0;
      hubFees[hub.key] = {
        stationId: hub.stationId,
        stationName: station?.name || hub.name,
        ownerId,
        factionId,
        factionStanding,
        corpStanding,
        broker: npcBrokerFee({
          brokerRelations: levels.brokerRelations,
          factionStanding,
          corpStanding,
        }),
      };
    })
  );

  // --- структуры: из ордеров, ассетов, локации и конфига ---
  const structureIds = new Set();
  for (const o of orders) if (o.location_id >= 1e12) structureIds.add(o.location_id);
  for (const a of assets) if (a.location_id >= 1e12) structureIds.add(a.location_id);
  if (location?.structure_id) structureIds.add(location.structure_id);
  for (const s of config.structures || []) if (s.id) structureIds.add(Number(s.id));

  const knownStructures = [];
  await Promise.all(
    [...structureIds].map(async (structureId) => {
      const info = await safe(() => esi.get(`/universe/structures/${structureId}/`, { auth: id }), null);
      if (!info) return;
      const system = await safe(() => esi.get(`/universe/systems/${info.solar_system_id}/`), null);
      const cfgStruct = (config.structures || []).find((s) => Number(s.id) === Number(structureId));
      const ownerTax = Number(cfgStruct?.tax ?? config.defaultStructureTax ?? 0.01);
      knownStructures.push({
        id: Number(structureId),
        name: info.name,
        systemId: info.solar_system_id,
        regionId: system?.region_id ?? null,
        ownerId: info.owner_id ?? null,
        tax: ownerTax,
        broker: structureBrokerFee(ownerTax),
        source: cfgStruct ? "config" : "discovered",
      });
    })
  );
  knownStructures.sort((a, b) => a.name.localeCompare(b.name));

  const tax = salesTax(levels.accounting);
  const fees = {
    source: "character",
    tax,
    hubs: hubFees,
    structure: { tax: config.defaultStructureTax ?? 0.01, broker: structureBrokerFee(config.defaultStructureTax ?? 0.01) },
  };

  const buyCount = orders.filter((o) => o.is_buy_order).length;
  const escrow = orders.reduce((acc, o) => acc + (o.is_buy_order ? Number(o.escrow || 0) : 0), 0);

  const authEntry = auth.list().find((c) => Number(c.characterId) === id);

  return {
    characterId: id,
    name: authEntry?.name || null,
    wallet: Number(wallet) || 0,
    skills: { levels, maxOrders },
    orders: {
      count: orders.length,
      buyCount,
      sellCount: orders.length - buyCount,
      escrow,
      slotsFree: Math.max(0, maxOrders - orders.length),
    },
    standingsCount: standings.size,
    location: location
      ? {
          systemId: location.solar_system_id,
          stationId: location.station_id ?? null,
          structureId: location.structure_id ?? null,
        }
      : null,
    structures: knownStructures,
    colonies: Array.isArray(colonies) ? colonies : [],
    coloniesError,
    fees,
    updatedAt: new Date().toISOString(),
  };
}

/** Комиссии для станции/структуры по данным персонажа (или дефолт). */
export function feesForLocation(character, location) {
  const base = character?.fees || defaultFees();
  if (location.kind === "structure") {
    const st = (character?.structures || []).find((s) => Number(s.id) === Number(location.id));
    const ownerTax = st?.tax ?? location.tax ?? DEFAULT_CONFIG.defaultStructureTax;
    return {
      tax: base.tax ?? salesTax(5),
      broker: structureBrokerFee(ownerTax),
      kind: "structure",
      ownerTax,
    };
  }
  const hub = Object.values(base.hubs || {}).find((h) => h.stationId === location.id);
  return {
    tax: base.tax ?? salesTax(5),
    broker: hub?.broker ?? npcBrokerFee({ brokerRelations: 5 }),
    kind: "npc",
    factionStanding: hub?.factionStanding ?? 0,
    corpStanding: hub?.corpStanding ?? 0,
  };
}

export function emptyCharacterSummary() {
  const f = defaultFees();
  return {
    characterId: null,
    name: null,
    wallet: 0,
    skills: { levels: {}, maxOrders: 0 },
    orders: { count: 0, buyCount: 0, sellCount: 0, escrow: 0, slotsFree: 0 },
    structures: [],
    colonies: [],
    fees: { source: "default", tax: f.tax, hubs: {}, structure: { tax: 0.01, broker: structureBrokerFee(0.01) } },
    updatedAt: null,
  };
}
