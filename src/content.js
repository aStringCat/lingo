(() => {
  const INJECTION_FLAG = "__lingoContentInjected";
  if (globalThis[INJECTION_FLAG]) return;
  globalThis[INJECTION_FLAG] = true;

  const BLOCK_SELECTOR = "p, li, blockquote, figcaption, h1, h2, h3, h4, h5, h6, td, th, dd, dt";
  const EXCLUDED_SELECTOR = [
    "nav", "header", "footer", "aside", "form", "dialog",
    "pre", "code", "kbd", "samp", "script", "style", "noscript",
    "textarea", "input", "select", "button", "[contenteditable]",
    "[aria-hidden='true']", ".lingo-managed", ".lingo-ui"
  ].join(",");
  const BATCH_SIZE = 8;
  const LAZY_LOAD_MARGIN = 800;
  const TRANSLATION_QUEUE_DELAY = 80;
  const DYNAMIC_SCAN_DELAY = 250;
  let toastTimer = null;

  class ElementQueue {
    constructor() {
      this.items = [];
      this.head = 0;
      this.members = new Set();
    }

    get size() {
      return this.members.size;
    }

    add(element) {
      if (this.members.has(element)) return false;
      this.members.add(element);
      this.items.push(element);
      return true;
    }

    take(limit) {
      const batch = [];
      while (this.head < this.items.length && batch.length < limit) {
        const element = this.items[this.head++];
        if (!this.members.delete(element)) continue;
        batch.push(element);
      }
      if (this.head > 512 && this.head * 2 > this.items.length) {
        this.items = this.items.slice(this.head);
        this.head = 0;
      }
      return batch;
    }

    clear() {
      this.items.length = 0;
      this.head = 0;
      this.members.clear();
    }
  }
  const state = {
    active: false,
    busy: false,
    settings: null,
    observer: null,
    visibilityObserver: null,
    translated: new Map(),
    linkHosts: new Map(),
    waiting: new Set(),
    queue: new ElementQueue(),
    queuePaused: false,
    queueTimer: null,
    scanQueue: new Set(),
    scanTimer: null,
    scanUsesIdleCallback: false,
    translationTask: null,
    sessionId: 0,
    sourceLanguage: "en",
    localTranslator: null
  };

  function normalizeText(text) {
    return text.replace(/\s+/gu, " ").trim();
  }

  function normalizeLanguageTag(tag, { forLocalApi = false } = {}) {
    const normalized = String(tag || "").trim().replaceAll("_", "-");
    if (!normalized) return "";
    const lower = normalized.toLowerCase();
    if (lower.startsWith("zh")) {
      const traditional = /(?:hant|tw|hk|mo)/iu.test(normalized);
      return forLocalApi ? (traditional ? "zh-Hant" : "zh") : (traditional ? "zh-TW" : "zh-CN");
    }
    return lower.split("-")[0];
  }

  function inferLanguage(text) {
    if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) return "ja";
    if (/\p{Script=Hangul}/u.test(text)) return "ko";
    if (/\p{Script=Han}/u.test(text)) return "zh-CN";
    if (/\p{Script=Arabic}/u.test(text)) return "ar";
    if (/\p{Script=Cyrillic}/u.test(text)) return "ru";
    return "en";
  }

  async function detectSourceLanguage(sample) {
    const declared = normalizeLanguageTag(document.documentElement.lang);
    if (declared) return declared;

    if ("LanguageDetector" in globalThis) {
      try {
        const availability = await LanguageDetector.availability();
        if (availability !== "unavailable") {
          const detector = await LanguageDetector.create();
          const [result] = await detector.detect(sample);
          detector.destroy();
          const detected = normalizeLanguageTag(result?.detectedLanguage);
          if (detected) return detected;
        }
      } catch {
        // Script-based detection below is immediate and network-free.
      }
    }

    return inferLanguage(sample);
  }

  async function prepareLocalTranslator(sourceLanguage, targetLanguage) {
    if (!("Translator" in globalThis)) return null;
    const source = normalizeLanguageTag(sourceLanguage, { forLocalApi: true });
    const target = normalizeLanguageTag(targetLanguage, { forLocalApi: true });
    if (!source || !target || source === target) return null;

    try {
      const availability = await Translator.availability({ sourceLanguage: source, targetLanguage: target });
      if (availability === "unavailable") return null;
      if (availability === "downloadable") showToast("正在准备浏览器本地语言包…");
      return await Translator.create({ sourceLanguage: source, targetLanguage: target });
    } catch {
      return null;
    }
  }

  function isTranslatable(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element.closest(EXCLUDED_SELECTOR)) return false;
    if (element.querySelector(BLOCK_SELECTOR)) return false;

    const text = normalizeText(element.textContent ?? "");
    if (text.length < 2 || text.length > 12000) return false;
    if (!/\p{L}{2}/u.test(text)) return false;
    if (/^(?:https?:\/\/|www\.)\S+$/iu.test(text)) return false;
    return true;
  }

  function collect(root = document.body) {
    if (!root) return [];
    const elements = [];
    if (root.matches?.(BLOCK_SELECTOR) && isTranslatable(root)) elements.push(root);
    for (const element of root.querySelectorAll?.(BLOCK_SELECTOR) ?? []) {
      if (isTranslatable(element)) elements.push(element);
    }
    return elements;
  }

  function createToast() {
    let host = document.querySelector(".lingo-ui");
    if (host) return host;
    host = document.createElement("div");
    host.className = "lingo-ui";
    host.setAttribute("aria-live", "polite");
    document.documentElement.append(host);
    return host;
  }

  function showToast(message, tone = "default", { duration = 2400 } = {}) {
    const toast = createToast();
    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.classList.add("lingo-ui-visible");
    clearTimeout(toastTimer);
    toastTimer = null;
    if (duration > 0) {
      toastTimer = setTimeout(() => toast.classList.remove("lingo-ui-visible"), duration);
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      const input = document.createElement("textarea");
      input.className = "lingo-copy-fallback";
      input.value = text;
      document.documentElement.append(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      if (!copied) throw new Error("复制失败，请手动选择译文复制");
    }
  }

  function createTranslation(translatedText) {
    const translation = document.createElement("span");
    translation.className = "lingo-translation";
    translation.lang = state.settings.targetLanguage;
    translation.dir = "auto";

    const text = document.createElement("span");
    text.className = "lingo-translation-text";
    text.textContent = translatedText;

    const copyButton = document.createElement("button");
    copyButton.className = "lingo-copy";
    copyButton.type = "button";
    copyButton.textContent = "复制";
    copyButton.setAttribute("aria-label", "复制这段译文");
    copyButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await copyText(translatedText);
        copyButton.textContent = "已复制";
        setTimeout(() => {
          if (copyButton.isConnected) copyButton.textContent = "复制";
        }, 1400);
      } catch (error) {
        showToast(error.message, "error");
      }
    });

    translation.append(text, copyButton);
    return translation;
  }

  function getLinkHost(anchor) {
    let host = state.linkHosts.get(anchor);
    if (host?.isConnected) return host;
    host = document.createElement("span");
    host.className = "lingo-detached-host lingo-managed";
    host.dataset.lingoDisplay = state.settings.displayMode;
    anchor.after(host);
    state.linkHosts.set(anchor, host);
    return host;
  }

  function renderTranslation(element, translatedText, sessionId) {
    if (!state.active || sessionId !== state.sessionId || !element.isConnected || state.translated.has(element)) return;
    const translation = createTranslation(translatedText);
    const enclosingLink = element.closest("a[href]");

    if (enclosingLink) {
      const host = getLinkHost(enclosingLink);
      host.append(translation);
      enclosingLink.classList.toggle("lingo-source-hidden", state.settings.displayMode === "translation");
      state.translated.set(element, { kind: "detached", translation });
      return;
    }

    const original = document.createElement("span");
    original.className = "lingo-original";
    element.classList.add("lingo-managed");
    element.dataset.lingoDisplay = state.settings.displayMode;
    while (element.firstChild) original.append(element.firstChild);
    element.append(original, translation);
    state.translated.set(element, { kind: "inline", original, translation });
  }

  async function translateBatch(batch, sessionId) {
    const texts = batch.map((element) => normalizeText(element.textContent ?? ""));
    let translations;
    const localTranslator = state.localTranslator;

    if (localTranslator) {
      try {
        translations = await Promise.all(texts.map((text) => localTranslator.translate(text)));
      } catch {
        localTranslator.destroy?.();
        if (state.localTranslator === localTranslator) state.localTranslator = null;
        if (!state.active || sessionId !== state.sessionId) return null;
        if (state.settings.onlineFallback) showToast("本地翻译不可用，已切换在线服务");
      }
    }

    if (!translations) {
      if (!state.settings.onlineFallback) {
        throw new Error("浏览器本地翻译不可用，请在扩展面板中开启在线翻译兜底");
      }
      if (!state.active || sessionId !== state.sessionId) return null;
      const response = await chrome.runtime.sendMessage({
        type: "LINGO_TRANSLATE_TEXTS",
        texts,
        sourceLanguage: state.sourceLanguage,
        targetLanguage: state.settings.targetLanguage,
        sessionId
      });
      if (!response?.ok) throw new Error(response?.error || "翻译失败");
      translations = response.translations;
    }

    return translations;
  }

  function completionMessage() {
    for (const element of state.waiting) {
      if (element.isConnected) continue;
      state.visibilityObserver?.unobserve(element);
      state.waiting.delete(element);
    }
    const suffix = state.waiting.size ? " · 向下滚动将继续翻译" : "";
    return `当前区域已完成 · ${state.translated.size} 个段落${suffix}`;
  }

  async function runTranslationQueue(sessionId) {
    state.busy = true;
    try {
      while (state.queue.size && state.active && sessionId === state.sessionId) {
        const batch = state.queue.take(BATCH_SIZE)
          .filter((element) => element.isConnected && !state.translated.has(element));
        if (!batch.length) continue;

        showToast(`正在翻译 · 已完成 ${state.translated.size} 个段落`, "loading", { duration: 0 });
        let translations;
        try {
          translations = await translateBatch(batch, sessionId);
        } catch (error) {
          batch.forEach((element) => state.queue.add(element));
          state.queuePaused = true;
          throw error;
        }
        if (!translations || !state.active || sessionId !== state.sessionId) return;
        batch.forEach((element, index) => renderTranslation(element, translations[index], sessionId));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      if (state.active && sessionId === state.sessionId) showToast(completionMessage(), "success");
    } finally {
      if (state.active && sessionId === state.sessionId) state.busy = false;
    }
  }

  async function drainTranslationQueue() {
    if (state.translationTask) return state.translationTask;
    const sessionId = state.sessionId;
    const task = runTranslationQueue(sessionId);
    state.translationTask = task;

    try {
      await task;
    } catch (error) {
      if (sessionId === state.sessionId && state.active) showToast(error.message, "error", { duration: 4200 });
    } finally {
      if (state.translationTask === task) state.translationTask = null;
      if (state.active && state.queue.size && !state.queuePaused) scheduleTranslation();
    }
  }

  function scheduleTranslation(delay = TRANSLATION_QUEUE_DELAY) {
    if (!state.active || state.queuePaused || !state.queue.size || state.queueTimer || state.translationTask) return;
    state.queueTimer = setTimeout(() => {
      state.queueTimer = null;
      void drainTranslationQueue();
    }, delay);
  }

  function enqueueForTranslation(element) {
    if (!element.isConnected || state.translated.has(element)) return;
    state.waiting.delete(element);
    state.visibilityObserver?.unobserve(element);
    if (state.queue.add(element)) scheduleTranslation();
  }

  function registerElements(elements) {
    for (const element of elements) {
      if (!element.isConnected || state.translated.has(element) || state.waiting.has(element)) continue;
      if (!state.visibilityObserver) enqueueForTranslation(element);
      else {
        state.waiting.add(element);
        state.visibilityObserver.observe(element);
      }
    }
  }

  function createVisibilityObserver() {
    state.visibilityObserver?.disconnect();
    state.visibilityObserver = null;
    if (!("IntersectionObserver" in globalThis)) return;

    state.visibilityObserver = new IntersectionObserver((entries) => {
      if (!state.active) return;
      for (const entry of entries) {
        if (entry.isIntersecting) enqueueForTranslation(entry.target);
      }
    }, {
      root: null,
      rootMargin: `${LAZY_LOAD_MARGIN}px 0px`,
      threshold: 0
    });
  }

  function cancelScheduledScan() {
    if (state.scanTimer === null) return;
    if (state.scanUsesIdleCallback) cancelIdleCallback(state.scanTimer);
    else clearTimeout(state.scanTimer);
    state.scanTimer = null;
    state.scanUsesIdleCallback = false;
  }

  function flushScanQueue() {
    state.scanTimer = null;
    state.scanUsesIdleCallback = false;
    if (!state.active) return;
    const roots = [...state.scanQueue];
    state.scanQueue.clear();
    registerElements(roots.flatMap((root) => collect(root)));
  }

  function scheduleScan(root) {
    for (const existing of state.scanQueue) {
      if (existing.contains(root)) return;
      if (root.contains(existing)) state.scanQueue.delete(existing);
    }
    state.scanQueue.add(root);
    if (state.scanTimer !== null) return;

    if ("requestIdleCallback" in globalThis) {
      state.scanUsesIdleCallback = true;
      state.scanTimer = requestIdleCallback(flushScanQueue, { timeout: 1000 });
    } else {
      state.scanTimer = setTimeout(flushScanQueue, DYNAMIC_SCAN_DELAY);
    }
  }

  function observePage() {
    state.observer?.disconnect();
    state.observer = new MutationObserver((mutations) => {
      if (!state.active) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement) || node.closest(".lingo-managed, .lingo-ui")) continue;
          scheduleScan(node);
        }
      }
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  async function start(settings) {
    if (state.active) return;
    state.busy = true;
    state.active = true;
    state.settings = settings;
    state.queuePaused = false;
    const sessionId = ++state.sessionId;
    showToast("正在分析网页…", "loading", { duration: 0 });

    try {
      const elements = collect();
      if (!elements.length) throw new Error("没有找到可翻译的正文");
      const sample = elements.slice(0, 8)
        .map((element) => normalizeText(element.textContent ?? ""))
        .join(" ")
        .slice(0, 4000);
      state.sourceLanguage = await detectSourceLanguage(sample);
      if (normalizeLanguageTag(state.sourceLanguage) === normalizeLanguageTag(settings.targetLanguage)) {
        throw new Error("页面已经是目标语言");
      }

      const localTranslator = await prepareLocalTranslator(state.sourceLanguage, settings.targetLanguage);
      if (!state.active || sessionId !== state.sessionId) {
        localTranslator?.destroy?.();
        return;
      }
      state.localTranslator = localTranslator;
      createVisibilityObserver();
      observePage();
      registerElements(elements);
      state.busy = state.queue.size > 0 || state.waiting.size > 0;
      if (state.queue.size) scheduleTranslation(0);
      else showToast("翻译已就绪 · 滚动时按需加载", "success");
    } catch (error) {
      if (sessionId !== state.sessionId) return;
      restore({ silent: true });
      showToast(error.message, "error", { duration: 4200 });
    }
  }

  function updateDisplayMode(displayMode) {
    if (!state.settings || !["bilingual", "translation"].includes(displayMode)) return;
    state.settings.displayMode = displayMode;
    for (const [element, record] of state.translated) {
      if (record.kind === "inline") element.dataset.lingoDisplay = displayMode;
    }
    for (const [link, host] of state.linkHosts) {
      host.dataset.lingoDisplay = displayMode;
      link.classList.toggle("lingo-source-hidden", displayMode === "translation");
    }
  }

  function restore({ silent = false } = {}) {
    const cancelledSessionId = state.sessionId;
    state.active = false;
    state.busy = false;
    state.sessionId += 1;
    state.observer?.disconnect();
    state.observer = null;
    state.visibilityObserver?.disconnect();
    state.visibilityObserver = null;
    clearTimeout(state.queueTimer);
    cancelScheduledScan();
    state.waiting.clear();
    state.queue.clear();
    state.queuePaused = false;
    state.queueTimer = null;
    state.scanQueue.clear();
    state.translationTask = null;
    state.localTranslator?.destroy?.();
    state.localTranslator = null;
    void chrome.runtime.sendMessage({
      type: "LINGO_CANCEL_TRANSLATIONS",
      sessionId: cancelledSessionId
    }).catch(() => {});

    for (const [element, record] of state.translated) {
      if (record.kind === "inline" && element.isConnected) {
        while (record.original.firstChild) element.insertBefore(record.original.firstChild, record.original);
        record.original.remove();
        record.translation.remove();
        element.classList.remove("lingo-managed");
        delete element.dataset.lingoDisplay;
      } else {
        record.translation.remove();
      }
    }
    for (const [link, host] of state.linkHosts) {
      host.remove();
      link.classList.remove("lingo-source-hidden");
    }

    state.translated.clear();
    state.linkHosts.clear();
    if (!silent) showToast("已还原原网页", "success");
  }

  async function getSettings() {
    return chrome.storage.sync.get({ targetLanguage: "zh-CN", displayMode: "bilingual", onlineFallback: false });
  }

  function beginStart(settings) {
    if (state.active) return;
    void start(settings);
  }

  async function toggle(settings) {
    if (state.active) restore();
    else beginStart(settings ?? await getSettings());
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "LINGO_PING") {
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "LINGO_GET_STATE") {
      sendResponse({
        active: state.active,
        busy: state.busy,
        count: state.translated.size
      });
      return false;
    }
    if (message?.type === "LINGO_RESTORE") {
      restore();
      sendResponse({ ok: true, active: false, count: 0 });
      return false;
    }
    if (message?.type === "LINGO_UPDATE_DISPLAY_MODE") {
      updateDisplayMode(message.displayMode);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "LINGO_UPDATE_ONLINE_FALLBACK") {
      if (state.settings) {
        state.settings.onlineFallback = Boolean(message.onlineFallback);
        if (!state.settings.onlineFallback) {
          void chrome.runtime.sendMessage({
            type: "LINGO_CANCEL_TRANSLATIONS",
            sessionId: state.sessionId
          }).catch(() => {});
        } else if (state.queuePaused) {
          state.queuePaused = false;
          scheduleTranslation(0);
        }
      }
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "LINGO_RESTART") {
      restore({ silent: true });
      beginStart(message.settings);
      sendResponse({ ok: true, active: true, count: 0 });
      return false;
    }
    if (message?.type === "LINGO_TRANSLATE_PAGE") {
      beginStart(message.settings);
      sendResponse({ ok: true, active: true, count: state.translated.size });
      return false;
    }
    if (message?.type === "LINGO_TOGGLE") {
      toggle(message.settings)
        .then(() => sendResponse({ ok: true, active: state.active, count: state.translated.size }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    return false;
  });

  if (globalThis.__LINGO_TEST__) {
    globalThis.__lingoTest = {
      ElementQueue,
      collect,
      isTranslatable,
      renderTranslation,
      restore,
      scheduleScan,
      state
    };
  }
})();
