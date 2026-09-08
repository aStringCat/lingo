import { createMyMemoryTranslator } from "./translator.js";
import { isInjectableUrl, ONLINE_ORIGIN } from "./shared.js";

const CACHE_LIMIT = 500;
const CONCURRENCY = 4;
const MAX_BATCH_SIZE = 32;
const MAX_TEXT_LENGTH = 12000;
const translate = createMyMemoryTranslator();
const cache = new Map();
const activeRequests = new Map();

function cacheKey(text, sourceLanguage, targetLanguage) {
  return `${sourceLanguage}\u0000${targetLanguage}\u0000${text}`;
}

function readCached(key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function writeCached(key, value) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

async function translateCached(text, sourceLanguage, targetLanguage, signal) {
  const key = cacheKey(text, sourceLanguage, targetLanguage);
  const cached = readCached(key);
  if (cached !== undefined) return cached;

  const result = await translate(text, sourceLanguage, targetLanguage, { signal });
  writeCached(key, result);
  return result;
}

async function mapConcurrent(items, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  }

  const workerCount = Math.min(CONCURRENCY, items.length);
  await Promise.all(Array.from({ length: workerCount }, run));
  return results;
}

function requestKey(tabId, sessionId) {
  return `${tabId}:${sessionId}`;
}

function cancelRequests(tabId, sessionId) {
  const key = requestKey(tabId, sessionId);
  for (const controller of activeRequests.get(key) ?? []) controller.abort();
  activeRequests.delete(key);
}

function validateTranslationMessage(message) {
  if (!Array.isArray(message.texts) || message.texts.length === 0 || message.texts.length > MAX_BATCH_SIZE) {
    throw new Error("翻译批次无效");
  }
  if (message.texts.some((text) => typeof text !== "string" || text.length > MAX_TEXT_LENGTH)) {
    throw new Error("翻译文本无效");
  }
  if (typeof message.sourceLanguage !== "string" || typeof message.targetLanguage !== "string") {
    throw new Error("翻译语言无效");
  }
  if (!Number.isInteger(message.sessionId) || message.sessionId < 1) {
    throw new Error("翻译会话无效");
  }
}

export async function ensureContentScript(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("标签页无效");
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "LINGO_PING" });
    if (response?.ok) return;
  } catch {
    // No receiver means the user has not requested injection on this page yet.
  }

  await chrome.scripting.insertCSS({ target: { tabId }, files: ["src/content.css"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content.js"] });
}

async function handleTranslation(message, sender) {
  validateTranslationMessage(message);
  if (!sender.tab?.id) throw new Error("无法确认翻译页面");
  const allowed = await chrome.permissions.contains({ origins: [ONLINE_ORIGIN] });
  if (!allowed) throw new Error("在线翻译未授权，请在扩展面板中开启在线翻译兜底");

  const key = requestKey(sender.tab.id, message.sessionId);
  const controller = new AbortController();
  const controllers = activeRequests.get(key) ?? new Set();
  controllers.add(controller);
  activeRequests.set(key, controllers);

  try {
    return await mapConcurrent(message.texts, (text) => (
      translateCached(text, message.sourceLanguage, message.targetLanguage, controller.signal)
    ));
  } finally {
    controllers.delete(controller);
    if (!controllers.size) activeRequests.delete(key);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "LINGO_ENSURE_TAB") {
    ensureContentScript(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "LINGO_CANCEL_TRANSLATIONS") {
    if (sender.tab?.id) cancelRequests(sender.tab.id, message.sessionId);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type !== "LINGO_TRANSLATE_TEXTS") return false;
  handleTranslation(message, sender)
    .then((translations) => sendResponse({ ok: true, translations }))
    .catch((error) => {
      const cancelled = error?.name === "AbortError";
      sendResponse({ ok: false, cancelled, error: cancelled ? "翻译已取消" : error.message });
    });
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-translation") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isInjectableUrl(tab.url)) return;

  try {
    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "LINGO_TOGGLE" });
  } catch {
    // Browser-internal pages and unapproved file URLs intentionally reject injection.
  }
});
