const ONLINE_ORIGIN = "https://api.mymemory.translated.net/*";
const DEFAULT_SETTINGS = {
  targetLanguage: "zh-CN",
  displayMode: "bilingual",
  onlineFallback: false
};
const toggleButton = document.querySelector("#toggle");
const toggleLabel = document.querySelector("#toggle-label");
const targetLanguage = document.querySelector("#target-language");
const onlineFallback = document.querySelector("#online-fallback");
const status = document.querySelector("#status");
const modeInputs = [...document.querySelectorAll("[name='display-mode']")];
let pageState = { active: false, busy: false, count: 0, waiting: 0, error: "" };
let refreshTimer = null;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isSupportedPage(tab) {
  const url = tab?.url ?? "";
  return Boolean(
    tab?.id
    && /^(?:https?|file):/iu.test(url)
    && !/^https:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)(?:\/|$)/iu.test(url)
  );
}

async function sendToPage(message, { inject = false } = {}) {
  const tab = await activeTab();
  if (!isSupportedPage(tab)) throw new Error("浏览器限制访问此页面");
  if (inject) {
    const response = await chrome.runtime.sendMessage({ type: "CLEARLINGO_ENSURE_TAB", tabId: tab.id });
    if (!response?.ok) throw new Error(response?.error || "无法载入翻译工具");
  }
  return chrome.tabs.sendMessage(tab.id, message);
}

function renderState() {
  if (pageState.error) status.textContent = "此页面不可用";
  else if (pageState.active && pageState.busy) status.textContent = `翻译中 ${pageState.count}`;
  else if (pageState.active) status.textContent = `已翻译 ${pageState.count}`;
  else status.textContent = "就绪";

  status.dataset.active = pageState.active;
  toggleLabel.textContent = pageState.error
    || (pageState.active ? "停止并还原" : "翻译当前网页");
  toggleButton.disabled = Boolean(pageState.error);
}

function scheduleStateRefresh() {
  clearTimeout(refreshTimer);
  if (!pageState.active) return;
  refreshTimer = setTimeout(async () => {
    try {
      pageState = {
        ...pageState,
        ...await sendToPage({ type: "CLEARLINGO_GET_STATE" }),
        error: ""
      };
      renderState();
    } catch {
      // Navigation can remove the injected script; the next click will inject again.
      pageState = { active: false, busy: false, count: 0, waiting: 0, error: "" };
      renderState();
    }
    scheduleStateRefresh();
  }, 500);
}

function currentSettings() {
  return {
    targetLanguage: targetLanguage.value,
    displayMode: modeInputs.find((input) => input.checked)?.value ?? "bilingual",
    onlineFallback: onlineFallback.checked
  };
}

async function saveSettings() {
  const settings = currentSettings();
  await chrome.storage.sync.set(settings);
  return settings;
}

toggleButton.addEventListener("click", async () => {
  toggleButton.disabled = true;
  try {
    if (pageState.active) {
      await sendToPage({ type: "CLEARLINGO_RESTORE" });
      pageState = { active: false, busy: false, count: 0, waiting: 0, error: "" };
    } else {
      const settings = await saveSettings();
      const response = await sendToPage(
        { type: "CLEARLINGO_TRANSLATE_PAGE", settings },
        { inject: true }
      );
      if (!response?.ok) throw new Error(response?.error || "翻译失败");
      pageState = { active: true, busy: true, count: response.count ?? 0, waiting: 0, error: "" };
    }
  } catch (error) {
    pageState = { ...pageState, busy: false, error: error.message };
  } finally {
    toggleButton.disabled = false;
    renderState();
    scheduleStateRefresh();
  }
});

targetLanguage.addEventListener("change", async () => {
  try {
    const settings = await saveSettings();
    if (!pageState.active) return;
    await sendToPage({ type: "CLEARLINGO_RESTART", settings });
    pageState = { ...pageState, busy: true, count: 0, error: "" };
    renderState();
  } catch (error) {
    status.textContent = error.message;
  }
});

for (const input of modeInputs) {
  input.addEventListener("change", async () => {
    if (!input.checked) return;
    const settings = await saveSettings();
    if (pageState.active) {
      await sendToPage({ type: "CLEARLINGO_UPDATE_DISPLAY_MODE", displayMode: settings.displayMode });
    }
  });
}

onlineFallback.addEventListener("change", async () => {
  if (onlineFallback.checked) {
    const granted = await chrome.permissions.request({ origins: [ONLINE_ORIGIN] });
    if (!granted) {
      onlineFallback.checked = false;
      status.textContent = "未获得授权";
    }
  } else {
    await chrome.permissions.remove({ origins: [ONLINE_ORIGIN] });
  }
  const settings = await saveSettings();
  if (pageState.active) {
    await sendToPage({
      type: "CLEARLINGO_UPDATE_ONLINE_FALLBACK",
      onlineFallback: settings.onlineFallback
    });
  }
});

async function init() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  targetLanguage.value = settings.targetLanguage;
  const selectedMode = modeInputs.find((input) => input.value === settings.displayMode);
  if (selectedMode) selectedMode.checked = true;

  const hasOnlinePermission = await chrome.permissions.contains({ origins: [ONLINE_ORIGIN] });
  onlineFallback.checked = Boolean(settings.onlineFallback && hasOnlinePermission);
  if (settings.onlineFallback !== onlineFallback.checked) await saveSettings();

  const tab = await activeTab();
  if (!isSupportedPage(tab)) {
    pageState = { ...pageState, error: "浏览器限制访问此页面" };
  } else {
    try {
      pageState = { ...pageState, ...await chrome.tabs.sendMessage(tab.id, { type: "CLEARLINGO_GET_STATE" }) };
    } catch {
      // Opening the popup must not inject or read the page.
    }
  }
  renderState();
  scheduleStateRefresh();
}

void init();
