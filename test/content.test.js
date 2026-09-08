import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";

const contentScript = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");

function createPage(html = "") {
  const dom = new JSDOM(`<!doctype html><html lang="en"><body>${html}</body></html>`, {
    runScripts: "outside-only",
    url: "https://example.com/article"
  });
  const listeners = [];
  dom.window.__LINGO_TEST__ = true;
  dom.window.chrome = {
    runtime: {
      onMessage: { addListener: (listener) => listeners.push(listener) },
      sendMessage: async () => ({ ok: true })
    },
    storage: { sync: { get: async (defaults) => defaults } }
  };
  dom.window.eval(contentScript);
  return { dom, listeners, api: dom.window.__lingoTest };
}

function prepareRender(api) {
  api.state.active = true;
  api.state.sessionId = 1;
  api.state.settings = {
    targetLanguage: "zh-CN",
    displayMode: "bilingual",
    onlineFallback: false
  };
}

test("content script injection is idempotent", () => {
  const { dom, listeners } = createPage("<p>Hello world</p>");
  dom.window.eval(contentScript);
  assert.equal(listeners.length, 1);
  dom.window.close();
});

test("translation is plain selectable text and preserves original nodes", () => {
  const { dom, api } = createPage('<p id="source">Read <a id="link" href="/more">more</a></p>');
  prepareRender(api);
  const source = dom.window.document.querySelector("#source");
  const originalLink = dom.window.document.querySelector("#link");

  api.renderTranslation(source, "阅读 https://example.com", 1);
  const translation = source.querySelector(":scope > .lingo-translation");
  assert.equal(translation.querySelector(".lingo-translation-text").textContent, "阅读 https://example.com");
  assert.equal(translation.querySelector("a"), null);
  assert.equal(source.querySelector("#link"), originalLink);

  api.restore({ silent: true });
  assert.equal(source.textContent, "Read more");
  assert.equal(source.querySelector("#link"), originalLink);
  assert.equal(source.querySelector(".lingo-translation"), null);
  dom.window.close();
});

test("a block enclosed by a link renders its translation outside the link", () => {
  const { dom, api } = createPage('<a id="card" href="/story"><p id="source">Open story</p></a>');
  prepareRender(api);
  const source = dom.window.document.querySelector("#source");
  const link = dom.window.document.querySelector("#card");

  api.renderTranslation(source, "打开文章", 1);
  const translation = dom.window.document.querySelector(".lingo-translation");
  assert.equal(translation.closest("a"), null);
  assert.equal(link.nextElementSibling.classList.contains("lingo-detached-host"), true);
  assert.equal(source.textContent, "Open story");

  api.restore({ silent: true });
  assert.equal(link.nextElementSibling, null);
  assert.equal(link.classList.contains("lingo-linked-source"), false);
  dom.window.close();
});

test("collection performs no synchronous layout reads", () => {
  const paragraphs = Array.from({ length: 2000 }, (_, index) => `<p>Paragraph number ${index}</p>`).join("");
  const { dom, api } = createPage(paragraphs);
  dom.window.HTMLElement.prototype.getClientRects = () => {
    throw new Error("unexpected layout read");
  };
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => {
    throw new Error("unexpected layout read");
  };
  assert.equal(api.collect().length, 2000);
  dom.window.close();
});

test("performance: queue drains 100,000 unique elements in linear time", () => {
  const { dom, api } = createPage();
  const queue = new api.ElementQueue();
  const elements = Array.from({ length: 100000 }, () => ({}));
  const started = performance.now();
  for (const element of elements) {
    assert.equal(queue.add(element), true);
    assert.equal(queue.add(element), false);
  }
  let drained = 0;
  while (queue.size) drained += queue.take(8).length;
  const elapsed = performance.now() - started;

  assert.equal(drained, elements.length);
  assert.ok(elapsed < 2000, `queue took ${elapsed.toFixed(1)} ms`);
  dom.window.close();
});
