const ENDPOINT = "https://api.mymemory.translated.net/get";
const MAX_CHUNK_BYTES = 450;
const encoder = new TextEncoder();

function byteLength(text) {
  return encoder.encode(text).length;
}

function splitOversizedSegment(segment, maxBytes) {
  const chunks = [];
  let current = "";
  let currentBytes = 0;
  for (const character of segment) {
    const characterBytes = byteLength(character);
    if (current && currentBytes + characterBytes > maxBytes) {
      chunks.push(current);
      current = character;
      currentBytes = characterBytes;
    } else {
      current += character;
      currentBytes += characterBytes;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function splitText(text, maxBytes = MAX_CHUNK_BYTES) {
  if (byteLength(text) <= maxBytes) return [text];

  const sentences = [...new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text)]
    .map(({ segment }) => segment);
  const chunks = [];
  let current = "";
  let currentBytes = 0;

  for (const sentence of sentences) {
    const sentenceBytes = byteLength(sentence);
    if (sentenceBytes > maxBytes) {
      if (current) chunks.push(current);
      chunks.push(...splitOversizedSegment(sentence, maxBytes));
      current = "";
      currentBytes = 0;
      continue;
    }

    if (currentBytes + sentenceBytes > maxBytes) {
      chunks.push(current);
      current = sentence;
      currentBytes = sentenceBytes;
    } else {
      current += sentence;
      currentBytes += sentenceBytes;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

export function createMyMemoryTranslator(fetchImpl = fetch) {
  return async function translate(text, sourceLanguage, targetLanguage, { signal } = {}) {
    const chunks = splitText(text);
    const translated = [];

    for (const chunk of chunks) {
      const url = new URL(ENDPOINT);
      url.search = new URLSearchParams({
        q: chunk,
        langpair: `${sourceLanguage}|${targetLanguage}`,
        mt: "1"
      });

      const response = await fetchImpl(url, { signal });
      if (!response.ok) throw new Error(`翻译服务返回 ${response.status}`);

      const payload = await response.json();
      if (payload?.responseStatus !== 200) {
        throw new Error(payload?.responseDetails || "在线翻译服务暂不可用");
      }
      const result = payload?.responseData?.translatedText;
      if (!result) throw new Error("翻译服务未返回有效内容");
      translated.push(result);
    }

    return translated.join("");
  };
}
