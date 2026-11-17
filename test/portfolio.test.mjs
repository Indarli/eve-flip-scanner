import test from "node:test";
import assert from "node:assert/strict";
import { txStats, assetTotals, markOrders } from "../lib/portfolio.mjs";

const tx = (isBuy, qty, price, date, typeId = 34) => ({
  is_buy: isBuy,
  quantity: qty,
  unit_price: price,
  date,
  type_id: typeId,
});

test("txStats: средняя стоимость и реализованная прибыль", () => {
  const stats = txStats([
    tx(true, 10, 100, "2026-01-01T00:00:00Z"),
    tx(false, 5, 150, "2026-01-02T00:00:00Z"),
    tx(true, 5, 200, "2026-01-03T00:00:00Z"),
  ]);
  const row = stats.rows[0];
  assert.equal(row.boughtQty, 15);
  assert.equal(row.soldQty, 5);
  assert.equal(row.boughtIsk, 2000);
  assert.equal(row.soldIsk, 750);
  assert.equal(row.realized, 250);
  assert.equal(row.costQty, 10);
  assert.equal(row.avgBuy, 150); // (1000 - 500 + 1000) / 10
  assert.equal(stats.total.realized, 250);
});

test("txStats: продажа больше остатка не ломает расчёт", () => {
  const stats = txStats([
    tx(true, 2, 100, "2026-01-01T00:00:00Z"),
    tx(false, 5, 150, "2026-01-02T00:00:00Z"),
  ]);
  const row = stats.rows[0];
  assert.equal(row.realized, 5 * 150 - 2 * 100);
  assert.equal(row.costQty, 0);
  assert.ok(row.avgBuy > 0);
});

test("assetTotals: суммирует одинаковые типы", () => {
  const totals = assetTotals([
    { type_id: 34, quantity: 10 },
    { type_id: 34, quantity: 5 },
    { type_id: 35, quantity: 7 },
  ]);
  const map = new Map(totals.map((t) => [t.typeId, t.qty]));
  assert.equal(map.get(34), 15);
  assert.equal(map.get(35), 7);
});

test("markOrders: sell подрезан, если есть аск ниже; buy — если бид выше", () => {
  const sell = markOrders(
    [{ order_id: 1, type_id: 34, location_id: 60003760, is_buy_order: false, price: 120, volume_remain: 5, volume_total: 10 }],
    () => ({ bid: 100, ask: 110 })
  )[0];
  assert.equal(sell.undercut, true);

  const buy = markOrders(
    [{ order_id: 2, type_id: 34, location_id: 60003760, is_buy_order: true, price: 100, volume_remain: 5, volume_total: 10 }],
    () => ({ bid: 110, ask: 120 })
  )[0];
  assert.equal(buy.undercut, true);

  const first = markOrders(
    [{ order_id: 3, type_id: 34, location_id: 60003760, is_buy_order: false, price: 110, volume_remain: 1, volume_total: 1 }],
    () => ({ bid: 100, ask: 110 })
  )[0];
  assert.equal(first.undercut, false);
});
