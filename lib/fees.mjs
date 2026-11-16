// Налоги и комиссии EVE Online (актуально на 11.2026).
// Источники: support.eveonline.com/hc/en-us/articles/203218962, wiki.eveuniversity.org/Trading
//
//   Sales tax   = 7.5% * (1 - 0.11 * Accounting)
//   Broker fee  = 3% - 0.3% * BrokerRelations - 0.03% * factionStanding - 0.02% * corpStanding
//                 (минимум 1%; в структурах скиллы не работают: 0.5% SCC + ставка владельца)

export const SALES_TAX_BASE = 0.075;
export const BROKER_BASE = 0.03;
export const BROKER_MIN = 0.01;

export function salesTax(accountingLevel = 5) {
  const lvl = clamp(Number(accountingLevel) || 0, 0, 5);
  return SALES_TAX_BASE * (1 - 0.11 * lvl);
}

export function npcBrokerFee({ brokerRelations = 5, factionStanding = 0, corpStanding = 0 } = {}) {
  const br = clamp(Number(brokerRelations) || 0, 0, 5);
  const fs = clamp(Number(factionStanding) || 0, -10, 10);
  const cs = clamp(Number(corpStanding) || 0, -10, 10);
  const raw = BROKER_BASE - 0.003 * br - 0.0003 * fs - 0.0002 * cs;
  return clamp(raw, BROKER_MIN, 0.10);
}

export function structureBrokerFee(ownerTax = 0.01) {
  return 0.005 + clamp(Number(ownerTax) || 0, 0, 0.1);
}

/** Полная стоимость кругового оборота через два ордера (buy + sell) при одной и той же цене. */
export function roundTripFee({ tax, broker }) {
  return 1 - (1 - tax - broker) / (1 + broker);
}

/**
 * Экономика флипа: покупаем по bid (своим buy-ордером), продаём по ask (своим sell-ордером).
 * Возвращает нетто-прибыль на единицу и порог безубыточности.
 */
export function flipQuote({ bid, ask, tax, broker }) {
  const buyCost = bid * (1 + broker);
  const sellNet = ask * (1 - tax - broker);
  const profit = sellNet - buyCost;
  const margin = buyCost > 0 ? profit / buyCost : 0;
  const breakEvenAsk = buyCost / (1 - tax - broker);
  return {
    buyCost,
    sellNet,
    profit,
    margin,
    breakEvenAsk,
    grossSpreadPct: bid > 0 ? (ask - bid) / bid : 0,
  };
}

/** Покупка с готового sell-ордера (taker) и перепродажа своим sell-ордером. */
export function takerQuote({ ask, target, tax, broker }) {
  const sellNet = target * (1 - tax - broker);
  const profit = sellNet - ask;
  return { profit, margin: ask > 0 ? profit / ask : 0 };
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
