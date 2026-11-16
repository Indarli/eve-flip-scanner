// Планетарка (Planetary Interaction): сбор и анализ колоний.
// ESI отдаёт только чтение: список колоний, раскладку пинов, маршруты.
// Рецепты (что во что) в ESI отсутствуют — только названия схем и cycle_time.

const HOUR = 3_600_000;

export function classifyPin(typeName = "") {
  const n = typeName.toLowerCase();
  if (n.includes("command center")) return "command";
  if (n.includes("extractor")) return "extractor";
  if (n.includes("storage")) return "storage";
  if (n.includes("spaceport") || n.includes("launchpad")) return "spaceport";
  if (n.includes("basic industry")) return "factory";
  if (n.includes("advanced industry")) return "factory";
  if (n.includes("high-tech")) return "factory";
  if (n.includes("factory") || n.includes("plant")) return "factory";
  return "other";
}

export function extractorStatus(expiresAt, now = Date.now()) {
  if (!expiresAt) return "unknown";
  const left = expiresAt - now;
  if (left <= 0) return "expired";
  if (left <= 6 * HOUR) return "critical";
  if (left <= 24 * HOUR) return "soon";
  return "ok";
}

function normalizeCoords(pins) {
  const maxAbs = Math.max(0, ...pins.map((p) => Math.max(Math.abs(Number(p.latitude) || 0), Math.abs(Number(p.longitude) || 0))));
  const radians = maxAbs <= Math.PI + 0.01;
  return (v) => (radians ? (Number(v) || 0) * (180 / Math.PI) : Number(v) || 0);
}

/**
 * @param {object} args
 * @param {object} args.colony  — запись из /characters/{id}/planets
 * @param {object} args.layout  — ответ /characters/{id}/planets/{planet_id}
 * @param {Map} args.names      — id -> {name}
 * @param {Map} args.schematics — schematic_id -> {schematic_name, cycle_time}
 * @param {Map} args.prices     — type_id -> {bid, ask}
 */
export function analyzeColony({ colony, layout, names, schematics, prices, characterId, characterName, now = Date.now() }) {
  const pins = [];
  const links = layout?.links || [];
  const routes = layout?.routes || [];
  const pinById = new Map();

  const rawPins = layout?.pins || [];
  const norm = normalizeCoords(rawPins);

  for (const p of rawPins) {
    const typeName = names.get(Number(p.type_id))?.name || `Type ${p.type_id}`;
    let kind = classifyPin(typeName);
    // надёжнее определять по деталям пина, а не только по имени
    if (p.extractor_details) kind = "extractor";
    else if (p.factory_details || p.schematic_id) kind = "factory";
    const lat = norm(p.latitude);
    const lon = norm(p.longitude);

    const pin = {
      id: p.pin_id,
      typeId: p.type_id,
      typeName,
      kind,
      lat,
      lon,
      contents: p.contents || [],
      contentsValue: 0,
      schematicId: p.schematic_id ?? p.factory_details?.schematic_id ?? null,
      schematicName: null,
      productTypeId: null,
      productName: null,
      qtyPerCycle: null,
      cycleTime: null,
      qtyPerHour: null,
      heads: null,
      expiresAt: p.expiry_time ? Date.parse(p.expiry_time) : null,
      lastCycleStart: p.last_cycle_start ? Date.parse(p.last_cycle_start) : null,
      installTime: p.install_time ? Date.parse(p.install_time) : null,
    };

    if (p.extractor_details) {
      const d = p.extractor_details;
      const qty = Number(d.qty_per_cycle) || 0;
      const cycle = Number(d.cycle_time) || 3600;
      pin.productTypeId = d.product_type_id ?? null;
      pin.productName = d.product_type_id ? names.get(Number(d.product_type_id))?.name || null : null;
      pin.qtyPerCycle = qty;
      pin.cycleTime = cycle;
      pin.qtyPerHour = cycle > 0 ? (qty * 3600) / cycle : 0;
      pin.heads = Array.isArray(d.heads) ? d.heads.length : 0;
      const price = pin.productTypeId ? prices.get(Number(pin.productTypeId)) : null;
      pin.iskPerHour = pin.qtyPerHour * (price?.bid || 0);
    }

    if (pin.schematicId) {
      const s = schematics.get(Number(pin.schematicId));
      if (s) {
        pin.schematicName = s.schematic_name;
        pin.cycleTime = s.cycle_time;
      }
    }

    pin.contentsValue = (pin.contents || []).reduce((acc, c) => {
      const price = prices.get(Number(c.type_id));
      return acc + (Number(c.amount) || 0) * (price?.bid || 0);
    }, 0);

    pins.push(pin);
    pinById.set(pin.id, pin);
  }

  const extractors = pins.filter((p) => p.kind === "extractor");
  const factories = pins.filter((p) => p.kind === "factory");

  let iskPerHour = 0;
  for (const e of extractors) iskPerHour += e.iskPerHour || 0;

  const expiring = extractors
    .filter((e) => e.expiresAt)
    .map((e) => ({ ...e, status: extractorStatus(e.expiresAt, now), msLeft: e.expiresAt - now }))
    .sort((a, b) => (a.expiresAt || 0) - (b.expiresAt || 0));

  return {
    characterId,
    characterName,
    planetId: colony.planet_id,
    planetType: colony.planet_type,
    systemId: colony.solar_system_id,
    planetName: names.get(Number(colony.planet_id))?.name || null,
    systemName: names.get(Number(colony.solar_system_id))?.name || null,
    upgradeLevel: colony.upgrade_level,
    numPins: colony.num_pins,
    lastUpdate: colony.last_update,
    pins,
    links: links.map((l) => ({
      ...l,
      source: pinById.get(l.source_pin_id),
      target: pinById.get(l.destination_pin_id),
    })),
    routes: routes.map((r) => ({
      ...r,
      source: pinById.get(r.source_pin_id),
      target: pinById.get(r.destination_pin_id),
      sourceName: pinById.get(r.source_pin_id)?.typeName,
      targetName: pinById.get(r.destination_pin_id)?.typeName,
    })),
    extractors: expiring,
    factories: factories.map((f) => ({
      pinId: f.id,
      schematicId: f.schematicId,
      schematicName: f.schematicName,
      cycleTime: f.cycleTime,
    })),
    totals: {
      extractorCount: extractors.length,
      factoryCount: factories.length,
      expired: expiring.filter((e) => e.status === "expired").length,
      critical: expiring.filter((e) => e.status === "critical").length,
      soon: expiring.filter((e) => e.status === "soon").length,
      iskPerHour,
      iskPerDay: iskPerHour * 24,
      contentsValue: pins.reduce((a, p) => a + (p.contentsValue || 0), 0),
    },
  };
}

export function summarizePi(colonies, now = Date.now()) {
  const totals = {
    colonies: colonies.length,
    extractors: 0,
    expired: 0,
    critical: 0,
    soon: 0,
    iskPerHour: 0,
    contentsValue: 0,
  };
  const queue = [];
  for (const c of colonies) {
    totals.extractors += c.totals.extractorCount;
    totals.expired += c.totals.expired;
    totals.critical += c.totals.critical;
    totals.soon += c.totals.soon;
    totals.iskPerHour += c.totals.iskPerHour;
    totals.contentsValue += c.totals.contentsValue;
    for (const e of c.extractors) {
      queue.push({
        characterId: c.characterId,
        characterName: c.characterName,
        planetId: c.planetId,
        planetName: c.planetName,
        planetType: c.planetType,
        systemName: c.systemName,
        pinId: e.id,
        productName: e.productName,
        qtyPerHour: e.qtyPerHour,
        heads: e.heads,
        expiresAt: e.expiresAt,
        msLeft: e.msLeft,
        status: extractorStatus(e.expiresAt, now),
        iskPerHour: e.iskPerHour,
      });
    }
  }
  queue.sort((a, b) => (a.expiresAt || 0) - (b.expiresAt || 0));
  totals.iskPerDay = totals.iskPerHour * 24;
  return { totals, queue };
}
