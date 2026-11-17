// Портфель: реализованный P&L по транзакциям, склад, проверка ордеров на «подрезали».

export function txStats(transactions) {
  const byType = new Map();
  const sorted = [...(transactions || [])].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const total = { realized: 0, boughtIsk: 0, soldIsk: 0, feesEstimate: 0 };

  for (const t of sorted) {
    const qty = Number(t.quantity) || 0;
    const price = Number(t.unit_price) || 0;
    const typeId = Number(t.type_id);
    let st = byType.get(typeId);
    if (!st) {
      st = {
        typeId,
        boughtQty: 0,
        boughtIsk: 0,
        soldQty: 0,
        soldIsk: 0,
        costQty: 0,
        costIsk: 0,
        realized: 0,
      };
      byType.set(typeId, st);
    }
    if (t.is_buy) {
      st.boughtQty += qty;
      st.boughtIsk += qty * price;
      st.costQty += qty;
      st.costIsk += qty * price;
      total.boughtIsk += qty * price;
    } else {
      st.soldQty += qty;
      st.soldIsk += qty * price;
      total.soldIsk += qty * price;
      const avg = st.costQty > 0 ? st.costIsk / st.costQty : 0;
      const used = Math.min(qty, st.costQty);
      st.realized += qty * price - used * avg;
      st.costQty -= used;
      st.costIsk -= used * avg;
      total.realized += qty * price - used * avg;
    }
  }

  const rows = [...byType.values()].map((s) => ({
    ...s,
    avgBuy: s.costQty > 0 ? s.costIsk / s.costQty : s.boughtQty ? s.boughtIsk / s.boughtQty : 0,
    avgSell: s.soldQty ? s.soldIsk / s.soldQty : 0,
  }));

  return { rows, total };
}

export function assetTotals(assets) {
  const map = new Map();
  for (const a of assets || []) {
    const id = Number(a.type_id);
    map.set(id, (map.get(id) || 0) + (Number(a.quantity) || 0));
  }
  return [...map.entries()].map(([typeId, qty]) => ({ typeId, qty })).filter((x) => x.qty > 0);
}

const CHUNK = 90;

/** Имена типов напрямую через ESI, с таймаутом и без общей очереди. */
export async function fetchTypeNames(ids) {
  const out = new Map();
  const list = [...new Set((ids || []).map(Number).filter(Boolean))];
  for (let i = 0; i < list.length; i += 900) {
    const chunk = list.slice(i, i + 900);
    try {
      const res = await fetch("https://esi.evetech.net/latest/universe/names/?datasource=tranquility", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "EVE-Flip-Scanner/1.0" },
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      for (const e of await res.json()) out.set(Number(e.id), e.name);
    } catch {
      /* пропускаем */
    }
  }
  return out;
}

/** Агрегаты Fuzzwork: station (если NPC) или регион. */
export async function fetchQuotes({ stationId, regionId, typeIds }) {
  const out = new Map();
  const ids = [...new Set(typeIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const param = stationId && Number(stationId) < 1e12 ? `station=${stationId}` : `region=${regionId}`;
    const url = `https://market.fuzzwork.co.uk/aggregates/?${param}&types=${chunk.join(",")}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "EVE-Flip-Scanner/1.0" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const [id, v] of Object.entries(data || {})) {
        out.set(Number(id), {
          bid: Number(v?.buy?.max) || 0,
          ask: Number(v?.sell?.min) || 0,
        });
      }
    } catch {
      /* пропускаем чанк */
    }
  }
  return out;
}

export function markOrders(orders, quoteFor) {
  return (orders || []).map((o) => {
    const q = quoteFor(o) || { bid: 0, ask: 0 };
    const price = Number(o.price);
    const isBuy = Boolean(o.is_buy_order);
    const best = isBuy ? q.bid : q.ask;
    const undercut = best > 0 && (isBuy ? best > price : best < price);
    const deltaPct = best > 0 ? (price - best) / best : 0;
    return {
      orderId: o.order_id,
      typeId: o.type_id,
      locationId: o.location_id,
      isBuy,
      price,
      volumeRemain: Number(o.volume_remain),
      volumeTotal: Number(o.volume_total),
      minVolume: Number(o.min_volume) || 1,
      issued: o.issued,
      duration: o.duration,
      escrow: Number(o.escrow) || 0,
      bestBid: q.bid,
      bestAsk: q.ask,
      undercut,
      deltaPct,
      value: price * Number(o.volume_remain),
    };
  });
}
