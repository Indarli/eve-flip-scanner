import fs from "node:fs";
const j = JSON.parse(fs.readFileSync("data/tokens.json", "utf8"));
const t = j.characters["12345678"];
console.log("expires", new Date(t.expires_at).toISOString(), "now", new Date().toISOString());
const tok = t.access_token;
const get = async (p) => {
  const r = await fetch("https://esi.evetech.net/latest" + p, { headers: { Authorization: "Bearer " + tok } });
  return { status: r.status, headers: r.headers, body: r.status === 200 ? await r.json() : await r.text() };
};
let r = await get("/characters/12345678/orders/?datasource=tranquility");
console.log("orders status", r.status, "count", Array.isArray(r.body) ? r.body.length : r.body);
if (Array.isArray(r.body)) console.log(r.body.slice(0, 5).map(o => `${o.is_buy_order ? "buy" : "sell"} ${o.type_id} @${o.price} rem ${o.volume_remain}/${o.volume_total} loc ${o.location_id}`));
r = await get("/characters/12345678/wallet/?datasource=tranquility");
console.log("wallet", r.status, r.body);
