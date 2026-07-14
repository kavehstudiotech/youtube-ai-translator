/*
 * background.js  —  MV3 service worker (module).
 *
 * Responsibilities:
 *   1. Translate batches of subtitle cues to Persian via the OpenRouter/LLM APIs.
 *   2. Cache translations (per video) so re-watching / seeking is instant.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek/deepseek-chat';

// In-memory cache:  Map<sourceText, persianText>
const cache = new Map();

let queuePromise = Promise.resolve();
let lastRequestTime = 0;

async function throttleRequest(rpm) {
  if (!rpm || rpm <= 0) return;
  const minDelay = (60 / rpm) * 1000;

  queuePromise = queuePromise
    .catch(() => { })
    .then(async () => {
      const now = Date.now();
      const elapsed = now - lastRequestTime;
      if (elapsed < minDelay) {
        const delay = minDelay - elapsed;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      lastRequestTime = Date.now();
    });

  await queuePromise;
}

const DEFAULTS = {
  enabled: true,
  provider: 'google_free',
  apiKey: '',
  geminiApiKey: '',
  grokApiKey: '',
  deepseekApiKey: '',
  openaiApiKey: '',
  model: 'anthropic/claude-3.5-sonnet',
  geminiModel: 'gemini-3.1-flash-lite',
  grokModel: 'openai/gpt-oss-120b',
  deepseekModel: 'deepseek-v4-flash',
  openaiModel: 'gpt-5.6-luna',
  localBaseUrl: 'http://localhost:11434/v1',
  localModel: 'llama3',
  customBaseUrl: '',
  customApiKey: '',
  customModel: '',
  rpm: 15,
  modelRpms: {
    'anthropic/claude-3.5-sonnet': 15,
    'openai/gpt-4o': 15,
    'openai/gpt-5.6-sol': 15,
    'deepseek/deepseek-v4-pro': 15,
    'google/gemini-2.5-pro': 15,
    'google/gemini-2.5-pro:free': 15,
    'meta-llama/llama-4-scout:free': 15,
    'deepseek/deepseek-r1:free': 15,
    'deepseek/deepseek-chat:free': 15,
    'gemini-3.1-flash-lite': 15,
    'gemini-3.5-flash': 15,
    'gemini-3.1-pro': 15,
    'gemini-2.5-flash': 15,
    'gemini-2.5-pro': 15,
    'openai/gpt-oss-120b': 30,
    'meta-llama/llama-4-scout-17b-16e-instruct': 30,
    'qwen/qwen3.6-27b': 30,
    'openai/gpt-oss-20b': 30,
    'llama-3.3-70b-versatile': 30,
    'deepseek-v4-flash': 30,
    'deepseek-v4-pro': 30,
    'gpt-5.6-luna': 30,
    'gpt-4o-mini': 30,
    'gpt-5.6-sol': 30,
    'gpt-4o': 30,
    'llama3': 15,
  },
};

async function getConfig() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

/**
 * Translate an array of strings to Persian in a single request.
 * Returns an array of the same length, in the same order.
 */
async function translateBatch(texts, cfg) {
  if (!texts.length) return [];

  // Serve from cache where possible; only send the misses.
  const missesIdx = [];
  const result = new Array(texts.length);
  texts.forEach((t, i) => {
    if (cache.has(t) && cache.get(t) !== "") result[i] = cache.get(t);
    else missesIdx.push(i);
  });
  if (!missesIdx.length) return result;

  const missTexts = missesIdx.map((idx) => texts[idx]);

  // Route requests based on provider
  let translations = [];
  if (cfg.provider === 'google_free') {
    await throttleRequest(15);
    translations = await translateGoogleFree(missTexts);
  } else {
    translations = await translateLLMBatch(missTexts, cfg);
  }

  missesIdx.forEach((idx, i) => {
    const fa = (translations[i] !== undefined ? translations[i] : texts[idx]).trim();
    if (fa !== "") {
      cache.set(texts[idx], fa);
    }
    result[idx] = fa;
  });

  return result;
}

async function translateGoogleFree(texts) {
  if (!texts.length) return [];
  const combined = texts.join('\n');
  
  // استفاده از کلاینت رسمی و قدرتمند dict-chrome-ex 
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=fa&dt=t`;

  try {
    let res;
    try {
      // ارسال متد POST برای جلوگیری از خطای URI Too Long و پایداری بیشتر
      res = await fetch(url, { 
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `q=${encodeURIComponent(combined)}`
      });
    } catch (fetchErr) {
      // اگر کورس یا نتورک داد یعنی گوگل آی‌پی را محدود (Redirect به کپچا) کرده است
      throw new Error('GOOGLE_CAPTCHA_OR_BLOCKED');
    }

    if (!res.ok) {
      if (res.status === 429) throw new Error('ERR_429');
      if (res.status === 401 || res.status === 403) throw new Error('ERR_AUTH');
      if (res.status >= 500) throw new Error('ERR_SERVER');
      throw new Error('GOOGLE_CAPTCHA_OR_BLOCKED');
    }

    const data = await res.json();
    const fullTranslation = (data[0] || []).map(seg => seg[0]).join('').trim();
    const split = fullTranslation.split('\n');

    if (split.length === texts.length) return split;
    console.warn('[ytfa] Google batch translation length mismatch, falling back to per‑line requests');
  } catch (e) {
    console.error('[ytfa] Google batch request failed:', e);
    if (
      e.message === 'GOOGLE_CAPTCHA_OR_BLOCKED' ||
      e.message === 'ERR_NETWORK' ||
      e.message === 'ERR_429' ||
      e.message === 'ERR_AUTH' ||
      e.message === 'ERR_SERVER'
    ) {
      throw e;
    }
  }

  // Fallback for Google Free — per-line sequential requests
  const out = new Array(texts.length);
  for (let i = 0; i < texts.length; i++) {
    try {
      out[i] = await translateOneGoogleFree(texts[i]);
    } catch (e) {
      console.error('[ytfa] Google fallback error for index', i, ':', e);
      throw e; 
    }
  }
  return out;
}

async function translateOneGoogleFree(text) {
  const url = `https://translate.googleapis.com/translate_a/single?client=dict-chrome-ex&sl=auto&tl=fa&dt=t`;
  try {
    let res;
    try {
      res = await fetch(url, { 
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `q=${encodeURIComponent(text)}`
      });
    } catch (fetchErr) {
      throw new Error('GOOGLE_CAPTCHA_OR_BLOCKED');
    }

    if (!res.ok) {
      if (res.status === 429) throw new Error('ERR_429');
      if (res.status === 401 || res.status === 403) throw new Error('ERR_AUTH');
      if (res.status >= 500) throw new Error('ERR_SERVER');
      throw new Error('GOOGLE_CAPTCHA_OR_BLOCKED');
    }

    const data = await res.json();
    if (data && data[0]) {
      return data[0].map(x => x[0]).join('').trim();
    }
    throw new Error('Invalid Google Response');
  } catch (e) {
    throw e;
  }
}

/** Translate the whole batch using LLM. Falls back to sequential individual translation on mismatch. */
async function translateLLMBatch(missTexts, cfg) {
  let translations = [];

  // Attempt 1: Standard Delimiter Batch (JSON Array Mode)
  try {
    console.log(`[ytfa] Attempt 1: Batch translation for ${missTexts.length} items.`);
    translations = await batchRequestLLM(missTexts, cfg, false);
    if (translations.length === missTexts.length) {
      return translations;
    }
    console.warn(`[ytfa] Attempt 1 misaligned. Expected ${missTexts.length}, got ${translations.length}.`);
  } catch (e) {
    console.error(`[ytfa] Attempt 1 batch request failed:`, e);
  }

  // Attempt 2: Stricter Batch Retry (JSON Array Mode)
  try {
    console.log(`[ytfa] Attempt 2: Retrying with stricter instructions...`);
    translations = await batchRequestLLM(missTexts, cfg, true);
    if (translations.length === missTexts.length) {
      return translations;
    }
    console.warn(`[ytfa] Attempt 2 misaligned. Expected ${missTexts.length}, got ${translations.length}.`);
  } catch (e) {
    console.error(`[ytfa] Attempt 2 batch retry failed:`, e);
  }

  // Safe & Strictly Sequential Fallback (100% RPM-Safe)
  // We translate the failed batch lines one by one, sequentially.
  console.warn(`[ytfa] Batch translation failed. Falling back to sequential individual translation.`);
  translations = await translateIndividuallyLLM(missTexts, cfg);
  return translations;
}

/** Strictly Sequential and RPM-safe Individual Fallback with proper error propagation */
async function translateIndividuallyLLM(missTexts, cfg) {
  const out = new Array(missTexts.length);
  for (let i = 0; i < missTexts.length; i++) {
    try {
      out[i] = await translateOneLLM(missTexts[i], cfg);
    } catch (e) {
      console.error(`[ytfa] Individual translation failed for index ${i}:`, e);

      if (
        e.message === 'ERR_429' ||
        e.message === 'ERR_AUTH' ||
        e.message === 'ERR_SERVER' ||
        e.message === 'ERR_400' ||
        e.message === 'ERR_NETWORK' ||
        e.message === 'GOOGLE_CAPTCHA_OR_BLOCKED'
      ) {
        throw e; // شلیک خطا به لایه بالا
      }

      out[i] = ""; 
    }
  }
  return out;
}

/** JSON mode batch request with strict Key-Value indexing */
async function batchRequestLLM(missTexts, cfg, strict = false) {
  const payloadObject = {};
  missTexts.forEach((text, i) => {
    payloadObject[String(i)] = text;
  });

  let system =
    'You are a professional subtitle translator. You will receive a JSON object of English subtitle strings, where each key represents the line index.\n' +
    'Translate each string into natural, fluent, conversational Persian (فارسی).\n' +
    'Your output must be a valid JSON object containing the translations under the key "translations", using the EXACT SAME numeric keys as the input.\n' +
    'Do not omit any keys, do not skip any lines, and do not combine translation strings.\n' +
    'Do not include any explanation, notes, or markdown formatting (except standard JSON).\n' +
    'Example output format:\n' +
    '{\n' +
    '  "translations": {\n' +
    '    "0": "سلام",\n' +
    '    "1": "خوش آمدید"\n' +
    '  }\n' +
    '}';

  if (strict) {
    system += `\nCRITICAL: The "translations" object MUST contain exactly all keys from "0" to "${missTexts.length - 1}".`;
  }

  const content = await llmChat({
    system,
    user: JSON.stringify(payloadObject),
    cfg,
    isJson: true
  });

  return parseJSONTranslations(content, missTexts.length);
}

/** Parses the LLM response safely using explicit Key-Value index mapping */
function parseJSONTranslations(content, expected) {
  let cleaned = content.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(cleaned);

    if (parsed && parsed.translations && typeof parsed.translations === 'object') {
      const result = [];
      for (let i = 0; i < expected; i++) {
        const val = parsed.translations[String(i)];
        result.push(val !== undefined ? String(val).trim() : "");
      }
      return result;
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed[String(0)] !== undefined) {
        const result = [];
        for (let i = 0; i < expected; i++) {
          const val = parsed[String(i)];
          result.push(val !== undefined ? String(val).trim() : "");
        }
        return result;
      }
    }

    if (Array.isArray(parsed)) {
      return parsed.map(x => String(x).trim());
    }
  } catch (e) {
    console.error('[ytfa] Failed to parse JSON translations:', e, 'Raw content:', content);
  }
  return [];
}

/** Translate a single line of text directly. */
async function translateOneLLM(text, cfg) {
  const system =
    'You are a professional subtitle translator. Translate the following single line ' +
    'into natural, fluent, conversational Persian (فارسی).\n' +
    'Output ONLY the translation, and do NOT include any introduction, notes, markdown formatting, or explanations.';

  const content = await llmChat({
    system,
    user: text,
    cfg,
    isJson: false
  });

  let cleaned = content.trim();
  cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/i, '').replace(/```\s*$/i, '').trim();
  return cleaned;
}

function getActiveModel(cfg) {
  const provider = cfg.provider;
  if (provider === 'openrouter') {
    return cfg.model;
  } else if (provider === 'gemini') {
    return cfg.geminiModel;
  } else if (provider === 'grok') {
    return cfg.grokModel;
  } else if (provider === 'deepseek') {
    return cfg.deepseekModel;
  } else if (provider === 'openai') {
    return cfg.openaiModel;
  } else if (provider === 'local') {
    return cfg.localModel;
  } else if (provider === 'custom') {
    return cfg.customModel;
  }
  return '';
}

/** Unified router for all LLM providers. */
async function llmChat({ system, user, cfg, isJson = false }) {
  if (cfg.provider !== 'local') {
    const activeModel = getActiveModel(cfg);
    const modelRpm = (cfg.modelRpms && cfg.modelRpms[activeModel]) || cfg.rpm || 15;
    await throttleRequest(modelRpm);
  }

  if (cfg.provider === 'openrouter') {
    if (!cfg.apiKey) throw new Error('NO_API_KEY');
    return openrouterChat({ apiKey: cfg.apiKey, model: cfg.model, system, user, isJson });
  } else if (cfg.provider === 'gemini') {
    if (!cfg.geminiApiKey) throw new Error('NO_API_KEY');
    return geminiChat({ apiKey: cfg.geminiApiKey, model: cfg.geminiModel, system, user, isJson });
  } else if (cfg.provider === 'grok') {
    if (!cfg.grokApiKey) throw new Error('NO_API_KEY');
    return openaiCompatibleChat({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: cfg.grokApiKey, model: cfg.grokModel, system, user, isJson });
  } else if (cfg.provider === 'deepseek') {
    if (!cfg.deepseekApiKey) throw new Error('NO_API_KEY');
    return openaiCompatibleChat({ baseUrl: 'https://api.deepseek.com', apiKey: cfg.deepseekApiKey, model: cfg.deepseekModel, system, user, isJson });
  } else if (cfg.provider === 'openai') {
    if (!cfg.openaiApiKey) throw new Error('NO_API_KEY');
    return openaiCompatibleChat({ baseUrl: 'https://api.openai.com/v1', apiKey: cfg.openaiApiKey, model: cfg.openaiModel, system, user, isJson });
  } else if (cfg.provider === 'local') {
    const baseUrl = cfg.localBaseUrl || 'http://localhost:11434/v1';
    return openaiCompatibleChat({ baseUrl, apiKey: null, model: cfg.localModel || 'llama3', system, user, isJson });
  } else if (cfg.provider === 'custom') {
    if (!cfg.customBaseUrl) throw new Error('NO_BASE_URL');
    return openaiCompatibleChat({ baseUrl: cfg.customBaseUrl, apiKey: cfg.customApiKey || null, model: cfg.customModel || '', system, user, isJson });
  }
  throw new Error(`Unknown provider: ${cfg.provider}`);
}

/** Google AI Studio (Gemini) API Chat */
async function geminiChat({ apiKey, model, system, user, isJson = false }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const generationConfig = { temperature: 0.2 };
  if (isJson) generationConfig.responseMimeType = 'application/json';

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig
      })
    });
  } catch (fetchErr) {
    throw new Error('ERR_NETWORK');
  }

  if (!res.ok) {
    if (res.status === 429) throw new Error('ERR_429');
    if (res.status === 401 || res.status === 403) throw new Error('ERR_AUTH');
    if (res.status >= 500) throw new Error('ERR_SERVER');
    if (res.status === 400) throw new Error('ERR_400');
    throw new Error(`ERR_SERVER`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

/** OpenAI Compatible API Chat with auto JSON fallback. */
async function openaiCompatibleChat({ baseUrl, apiKey, model, system, user, isJson = false }) {
  let url = baseUrl.trim();
  if (!url.endsWith('/chat/completions')) {
    url = url.replace(/\/$/, '') + '/chat/completions';
  }

  const headers = { 'Content-Type': 'application/json' };
  if (typeof apiKey === 'string' && apiKey.trim() !== '') {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  }

  const body = { model, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (isJson) body.response_format = { type: 'json_object' };

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (fetchErr) {
    throw new Error('ERR_NETWORK');
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    if (res.status === 400 && isJson && (txt.includes('json_object') || txt.includes('response_format') || txt.includes('INVALID_REQUEST_BODY'))) {
      console.warn(`[ytfa] Provider/Model does not support native JSON mode. Retrying without response_format...`);
      return openaiCompatibleChat({ baseUrl, apiKey, model, system, user, isJson: false });
    }
    if (res.status === 429) throw new Error('ERR_429');
    if (res.status === 401 || res.status === 403) throw new Error('ERR_AUTH');
    if (res.status >= 500) throw new Error('ERR_SERVER');
    if (res.status === 400) throw new Error('ERR_400');
    throw new Error('ERR_SERVER');
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

/** Shared OpenRouter chat-completion call returning the message content with auto JSON fallback. */
async function openrouterChat({ apiKey, model, system, user, isJson = false }) {
  const body = {
    model: model || DEFAULT_MODEL,
    temperature: 0.2,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  if (isJson) body.response_format = { type: 'json_object' };

  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://www.youtube.com/',
        'X-Title': 'Persian YouTube Translator',
      },
      body: JSON.stringify(body),
    });
  } catch (fetchErr) {
    throw new Error('ERR_NETWORK');
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    if (res.status === 400 && isJson && (txt.includes('json_object') || txt.includes('response_format') || txt.includes('INVALID_REQUEST_BODY'))) {
      console.warn(`[ytfa] Model ${model} does not support native JSON mode. Retrying without response_format...`);
      return openrouterChat({ apiKey, model, system, user, isJson: false });
    }
    if (res.status === 429) throw new Error('ERR_429');
    if (res.status === 401 || res.status === 403) throw new Error('ERR_AUTH');
    if (res.status >= 500) throw new Error('ERR_SERVER');
    if (res.status === 400) throw new Error('ERR_400');
    throw new Error('ERR_SERVER');
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

// --- آپدیت کردن لیسنر پیام‌ها ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'TRANSLATE') {
    (async () => {
      try {
        const cfg = await getConfig();
        if (!cfg.enabled) {
          sendResponse({ ok: false, error: 'APP_DISABLED' });
          return;
        }
        const out = await translateBatch(msg.texts, cfg);
        sendResponse({ ok: true, translations: out });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true; // keep the channel open for the async response
  }

  if (msg?.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    const keysToCheck = [
      'provider', 'apiKey', 'geminiApiKey', 'customApiKey', 'grokApiKey',
      'deepseekApiKey', 'openaiApiKey',
      'model', 'geminiModel', 'localModel', 'customModel', 'grokModel',
      'deepseekModel', 'openaiModel',
      'localBaseUrl', 'customBaseUrl'
    ];
    const changed = keysToCheck.some(key => key in changes);
    if (changed) {
      console.log('[ytfa] Configuration changed. Clearing translation cache.');
      cache.clear();
    }
  }
});