export const ONLINE_ORIGIN = "https://api.mymemory.translated.net/*";

export function isInjectableUrl(url = "") {
  if (!/^(?:https?|file):/iu.test(url)) return false;
  return !/^https:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)(?:\/|$)/iu.test(url);
}
