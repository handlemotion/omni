import assert from "node:assert/strict";
import { test } from "node:test";
import { findBareListings } from "./check-realtime-audience.mjs";

test("a bare getWebSockets() in a realtime file fails", () => {
  const files = new Map([
    [
      "apps/worker/src/realtime.ts",
      "const all = this.ctx.getWebSockets();\nconst mine = ctx.getWebSockets(id);",
    ],
  ]);
  assert.deepEqual(findBareListings(files), ["apps/worker/src/realtime.ts:1"]);
});

test("insiders() itself and the outsiders' own listing pass", () => {
  const files = new Map([
    [
      "apps/worker/src/realtime-files.ts",
      "  const sockets = tag === undefined ? ctx.getWebSockets() : ctx.getWebSockets(tag);",
    ],
    [
      "apps/worker/src/realtime-outside.ts",
      "  ctx.getWebSockets().filter((socket) => isOutsider(ctx, socket));",
    ],
  ]);
  assert.deepEqual(findBareListings(files), []);
});
