import test from "node:test";
import assert from "node:assert/strict";
import { extractorStatus } from "../lib/pi.mjs";

const HOUR = 3600_000;
const NOW = 1_800_000_000_000;

test("extractorStatus: пороги expired/critical/soon/ok", () => {
  assert.equal(extractorStatus(NOW - 1, NOW), "expired");
  assert.equal(extractorStatus(NOW + 5 * HOUR, NOW), "critical");
  assert.equal(extractorStatus(NOW + 6 * HOUR, NOW), "critical");
  assert.equal(extractorStatus(NOW + 10 * HOUR, NOW), "soon");
  assert.equal(extractorStatus(NOW + 24 * HOUR, NOW), "soon");
  assert.equal(extractorStatus(NOW + 48 * HOUR, NOW), "ok");
});
