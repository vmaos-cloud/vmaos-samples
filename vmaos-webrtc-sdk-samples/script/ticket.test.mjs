import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTicket } from "./ticket.js";
const now = Date.parse("2026-10-12T00:00:00Z");
const data = { signalServerUrl: "wss://signal.example.com", roomId: "room", token: "short-token", turnServerUris: ["turn:relay.example.com:3478"], expiresAt: new Date(now + 25000).toISOString() };
const response = (value = data, extra = {}) => JSON.stringify({ code: 200000000, data: value, ...extra });
test("maps a fresh successful response without forwarding arbitrary fields", () => {
  const config = parseTicket(response({ ...data, extra: "not-forwarded" }), now);
  assert.equal(config.signAgain, false); assert.equal(config.enableLogger, false);
  assert.deepEqual(config.hostTurn, data.turnServerUris); assert.equal(config.extra, undefined);
});
test("rejects expired tickets and unsuccessful envelopes", () => {
  assert.throws(() => parseTicket(response(), now + 25000), /过期/);
  assert.throws(() => parseTicket(response(data, { code: 409604001 }), now), /成功响应/);
  assert.throws(() => parseTicket(JSON.stringify(data), now), /成功响应/);
});
test("rejects malformed configuration and AK/SK at any nesting level", () => {
  for (const patch of [{ token: "" }, { turnServerUris: [] }, { signalServerUrl: "https://example.com" }, { expiresAt: "invalid" }, { nested: { SK: "secret" } }]) {
    assert.throws(() => parseTicket(response({ ...data, ...patch }), now));
  }
  assert.throws(() => parseTicket(response(data, { "X-AK": "secret" }), now), /AK\/SK/);
});
