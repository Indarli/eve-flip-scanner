import test from "node:test";
import assert from "node:assert/strict";
import { salesTax, npcBrokerFee, structureBrokerFee, flipQuote, roundTripFee } from "../lib/fees.mjs";

const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("sales tax: 7.5% с учётом Accounting", () => {
  close(salesTax(5), 0.03375);
  close(salesTax(0), 0.075);
  close(salesTax(3), 0.075 * (1 - 0.11 * 3));
});

test("broker NPC: база 3% и скидки", () => {
  close(npcBrokerFee({ brokerRelations: 5, factionStanding: 0, corpStanding: 0 }), 0.015);
  close(npcBrokerFee({ brokerRelations: 0, factionStanding: 10, corpStanding: 10 }), 0.025);
  close(npcBrokerFee({ brokerRelations: 5, factionStanding: 10, corpStanding: 10 }), 0.01); // минимум 1%
});

test("broker структуры: 0.5% + ставка владельца", () => {
  close(structureBrokerFee(0.01), 0.015);
  close(structureBrokerFee(0.05), 0.055);
});

test("flipQuote: прибыль, маржа и порог безубыточности", () => {
  const q = flipQuote({ bid: 100, ask: 120, tax: 0.03375, broker: 0.015 });
  close(q.buyCost, 101.5);
  close(q.sellNet, 120 * (1 - 0.03375 - 0.015));
  close(q.profit, q.sellNet - q.buyCost);
  close(q.margin, q.profit / q.buyCost);
  close(q.breakEvenAsk, q.buyCost / (1 - 0.03375 - 0.015));
  close(q.grossSpreadPct, 0.2);
});

test("roundTripFee: полная стоимость круга", () => {
  const tax = 0.03375;
  const broker = 0.015;
  close(roundTripFee({ tax, broker }), 1 - (1 - tax - broker) / (1 + broker));
});
