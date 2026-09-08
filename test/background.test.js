import test from "node:test";
import assert from "node:assert/strict";

const calls = [];
let pingSucceeds = true;
globalThis.chrome = {
  tabs: {
    sendMessage: async (_tabId, message) => {
      calls.push(["message", message.type]);
      if (!pingSucceeds) throw new Error("no receiver");
      return { ok: true };
    },
    query: async () => []
  },
  scripting: {
    insertCSS: async (details) => calls.push(["css", details.files[0]]),
    executeScript: async (details) => calls.push(["script", details.files[0]])
  },
  permissions: { contains: async () => false },
  runtime: { onMessage: { addListener() {} } },
  commands: { onCommand: { addListener() {} } }
};

const { ensureContentScript, isInjectableUrl } = await import("../src/background.js");

test("injection accepts ordinary web and file pages only", () => {
  assert.equal(isInjectableUrl("https://example.com"), true);
  assert.equal(isInjectableUrl("http://example.com"), true);
  assert.equal(isInjectableUrl("file:///tmp/example.html"), true);
  assert.equal(isInjectableUrl("chrome://extensions"), false);
  assert.equal(isInjectableUrl("https://chromewebstore.google.com/detail/example"), false);
});

test("existing content script is reused without reinjection", async () => {
  calls.length = 0;
  pingSucceeds = true;
  await ensureContentScript(7);
  assert.deepEqual(calls, [["message", "LINGO_PING"]]);
});

test("missing content script receives CSS before JavaScript", async () => {
  calls.length = 0;
  pingSucceeds = false;
  await ensureContentScript(7);
  assert.deepEqual(calls, [
    ["message", "LINGO_PING"],
    ["css", "src/content.css"],
    ["script", "src/content.js"]
  ]);
});
