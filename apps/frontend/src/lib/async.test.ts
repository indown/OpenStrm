/**
 *   pnpm --filter @openstrm/frontend test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mapLimit } from "./async";

test("mapLimit：同时在跑的不超过上限，结果按输入顺序回来", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([30, 5, 20, 1, 10, 2], 3, async (ms, i) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, ms));
    running--;
    return `${i}:${ms}`;
  });
  assert.deepEqual(out, ["0:30", "1:5", "2:20", "3:1", "4:10", "5:2"]);
  assert.equal(peak, 3);
});

test("mapLimit：空的直接回空数组；上限比条数大也只开条数那么多", async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  let calls = 0;
  assert.deepEqual(await mapLimit(["a"], 8, async (s) => (calls++, s.toUpperCase())), ["A"]);
  assert.equal(calls, 1);
});
