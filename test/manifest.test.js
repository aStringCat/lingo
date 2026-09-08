import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

test("manifest only injects after a user gesture", () => {
  assert.equal(manifest.content_scripts, undefined);
  assert.deepEqual(manifest.permissions.sort(), ["activeTab", "scripting", "storage"]);
});

test("online translation access is optional", () => {
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ["https://api.mymemory.translated.net/*"]);
});
