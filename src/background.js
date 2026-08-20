/*
 * background.js  —  MV3 service worker (module).
 *
 * Responsibilities:
 *   1. Translate batches of subtitle cues to Persian via the OpenRouter/LLM APIs.
 *   2. Cache translations (per video) so re-watching / seeking is instant.
 */

import { CLOUD_CACHE_URL } from './config.js';

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
  translationDomain: 'auto',
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
  cloudCacheEnabled: true,
  cloudCacheShare: true,
};

async function getConfig() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

/* ─────────── Cloudflare Worker Subtitle Cloud Cache ─────────── */

async function fetchCloudCache(videoId, cfg) {
  if (!cfg.cloudCacheEnabled || !videoId || !CLOUD_CACHE_URL) return null;
  const baseUrl = CLOUD_CACHE_URL.replace(/\/+$/, '');
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/subs?videoId=${encodeURIComponent(videoId)}&lang=fa&_t=${Date.now()}`,
      {
        method: 'GET',
        cache: 'no-store'
      },
      6000
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.ok && data.found && Array.isArray(data.cues) && data.cues.length > 0) {
      console.log(`[ytfa] ⚡ Found cloud cached subtitles for ${videoId} (${data.cues.length} cues, ${data.models?.length || 1} models)`);
      return data;
    }
  } catch (err) {
    console.warn('[ytfa] Cloud cache fetch unavailable:', err.message || err);
  }
  return null;
}

function getModelMeta(cfg) {
  const provider = cfg?.provider || 'google_free';
  if (provider === 'google_free') {
    return { provider: 'google_free', modelId: 'google_free', modelName: 'Google Translate' };
  }
  if (provider === 'gemini') {
    return { provider: 'gemini', modelId: cfg.geminiModel || 'gemini-3.1-flash-lite', modelName: `Gemini (${cfg.geminiModel || 'Flash'})` };
  }
  if (provider === 'deepseek') {
    return { provider: 'deepseek', modelId: cfg.deepseekModel || 'deepseek-v4-flash', modelName: `DeepSeek (${cfg.deepseekModel || 'Flash'})` };
  }
  if (provider === 'openai') {
    return { provider: 'openai', modelId: cfg.openaiModel || 'gpt-5.6-luna', modelName: `OpenAI (${cfg.openaiModel || 'GPT'})` };
  }
  if (provider === 'grok') {
    return { provider: 'grok', modelId: cfg.grokModel || 'openai/gpt-oss-120b', modelName: `xAI Grok (${cfg.grokModel || 'Grok'})` };
  }
  if (provider === 'openrouter') {
    const raw = cfg.model || 'openrouter';
    const clean = raw.split('/').pop().replace(/-/g, ' ');
    return { provider: 'openrouter', modelId: raw, modelName: `OpenRouter (${clean})` };
  }
  if (provider === 'local') {
    return { provider: 'local', modelId: cfg.localModel || 'local', modelName: `Local AI (${cfg.localModel || 'Ollama'})` };
  }
  return { provider: 'custom', modelId: cfg.customModel || 'custom', modelName: `Custom AI (${cfg.customModel || 'LLM'})` };
}

async function uploadCloudCache(videoId, cues, title, cfg) {
  if (!cfg.cloudCacheEnabled || !cfg.cloudCacheShare || !videoId || !Array.isArray(cues) || cues.length === 0 || !CLOUD_CACHE_URL) {
    return { ok: false, reason: 'disabled_or_empty' };
  }
  const baseUrl = CLOUD_CACHE_URL.replace(/\/+$/, '');
  const modelMeta = getModelMeta(cfg);
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/subs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId,
          lang: 'fa',
          cues,
          title: title || '',
          provider: modelMeta.provider,
          modelId: modelMeta.modelId,
          modelName: modelMeta.modelName,
        }),
      },
      8000
    );
    if (res.ok) {
      const respData = await res.json();
      console.log(`[ytfa] ☁️ Uploaded ${cues.length} cues for model "${modelMeta.modelName}" to cloud cache for video ${videoId}`);
      return respData;
    }
  } catch (err) {
    console.warn('[ytfa] Cloud cache upload failed:', err.message || err);
  }
  return { ok: false };
}

/* ─────────── Video Domain Detection & Specialized Prompts ─────────── */

/**
 * Detect video domain from YouTube metadata.
 * Returns one of: 'tech', 'medical', 'finance', 'general'
 */
function detectVideoDomain(videoMeta) {
  if (!videoMeta) return 'general';

  const title = (videoMeta.title || '').toLowerCase();
  const category = (videoMeta.category || '').toLowerCase();
  const keywords = (videoMeta.keywords || []).map(k => k.toLowerCase());
  const desc = (videoMeta.shortDescription || '').toLowerCase();
  const combined = `${title} ${category} ${keywords.join(' ')} ${desc}`;

  const DOMAIN_RULES = {
    tech: {
      categories: ['science & technology', 'science', 'technology', 'gaming'],
      keywords: [
        'programming', 'software', 'developer', 'code', 'coding', 'api',
        'javascript', 'python', 'react', 'algorithm', 'database', 'cloud',
        'machine learning', 'deep learning', 'neural', 'ai ', 'artificial intelligence',
        'devops', 'docker', 'kubernetes', 'linux', 'server', 'backend', 'frontend',
        'framework', 'library', 'tutorial', 'web development', 'mobile app',
        'css', 'html', 'typescript', 'rust', 'golang', 'java', 'c++',
        'computer science', 'data structure', 'engineering', 'robotics',
        'cybersecurity', 'hacking', 'network', 'hardware', 'gpu', 'cpu',
        'tech review', 'gadget', 'smartphone', 'processor', 'benchmark'
      ]
    },
    medical: {
      categories: ['science & technology', 'education'],
      keywords: [
        'medical', 'medicine', 'doctor', 'patient', 'disease', 'diagnosis',
        'surgery', 'clinical', 'therapy', 'treatment', 'pharmaceutical',
        'biology', 'biochemistry', 'genetics', 'genome', 'dna', 'rna',
        'cell', 'molecular', 'neuroscience', 'anatomy', 'physiology',
        'pathology', 'immunology', 'oncology', 'cardiology', 'dermatology',
        'health', 'healthcare', 'hospital', 'nurse', 'symptom',
        'virus', 'bacteria', 'infection', 'vaccine', 'antibody',
        'psychology', 'psychiatry', 'mental health', 'brain',
        'biotech', 'bioinformatics', 'evolution', 'ecology', 'organism'
      ]
    },
    finance: {
      categories: ['education', 'news & politics', 'howto & style'],
      keywords: [
        'finance', 'financial', 'investment', 'investing', 'stock', 'stocks',
        'market', 'trading', 'trader', 'forex', 'crypto', 'bitcoin',
        'ethereum', 'blockchain', 'portfolio', 'dividend', 'bond',
        'economy', 'economic', 'inflation', 'gdp', 'interest rate',
        'banking', 'bank', 'mortgage', 'credit', 'debt', 'loan',
        'accounting', 'audit', 'tax', 'revenue', 'profit', 'loss',
        'startup', 'venture capital', 'ipo', 'valuation', 'asset',
        'wealth', 'retirement', 'pension', 'real estate', 'property',
        'insurance', 'fintech', 'money', 'budget', 'savings'
      ]
    }
  };

  const scores = { tech: 0, medical: 0, finance: 0 };

  for (const [domain, rules] of Object.entries(DOMAIN_RULES)) {
    if (rules.categories.some(c => category.includes(c))) {
      scores[domain] += 3;
    }
    for (const kw of rules.keywords) {
      if (combined.includes(kw)) scores[domain] += 1;
    }
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (best[1] >= 4) return best[0];
  return 'general';
}

const DOMAIN_PROMPTS = {
  general:
    'You are a professional subtitle translator and linguistic expert. ' +
    'Translate each string into natural, fluent, conversational Persian (فارسی).',

  tech:
    'You are a specialized technical and software engineering translator with deep expertise in computer science, ' +
    'programming, and technology. Translate each subtitle string into precise, natural Persian (فارسی).\n' +
    'CRITICAL RULES for technical content:\n' +
    '- Keep all technical terms, library/framework names, programming keywords, and brand names in English ' +
    '  (e.g. React, API, Docker, Kubernetes, GPU, CPU, Python, JavaScript, REST, GraphQL, etc.).\n' +
    '- Translate conceptual explanations fluently but preserve technical accuracy.\n' +
    '- For acronyms like CI/CD, OOP, SQL, HTTP, keep them in English.\n' +
    '- Use established Persian equivalents where widely accepted ' +
    '  (e.g. "پایگاه داده" for database, "الگوریتم" for algorithm, "شبکه عصبی" for neural network).\n' +
    '- Do NOT invent Persian equivalents for terms that the Persian tech community uses in English.',

  medical:
    'You are a specialized medical and biological sciences translator with deep expertise in medicine, ' +
    'biology, biochemistry, and healthcare. Translate each subtitle string into precise, natural Persian (فارسی).\n' +
    'CRITICAL RULES for medical/biological content:\n' +
    '- Keep Latin/English scientific names (species names, gene names, drug brand names) as-is.\n' +
    '- Use established Persian medical terminology where available ' +
    '  (e.g. "سلول" for cell, "پروتئین" for protein, "ژن" for gene, "آنتی\u200cبادی" for antibody).\n' +
    '- For anatomical terms, prefer the widely-used Persian equivalent if one exists, ' +
    '  otherwise keep the English term.\n' +
    '- Maintain precision: do NOT simplify or paraphrase technical medical statements.\n' +
    '- For drug names, keep the generic name in English and add Persian description if contextually helpful.\n' +
    '- Abbreviations like DNA, RNA, MRI, CT, ICU must remain in English.',

  finance:
    'You are a specialized financial and economics translator with deep expertise in finance, ' +
    'investment, banking, and economics. Translate each subtitle string into precise, natural Persian (فارسی).\n' +
    'CRITICAL RULES for financial content:\n' +
    '- Keep English terms that the Persian financial community commonly uses in English ' +
    '  (e.g. ETF, IPO, P/E ratio, ROI, GDP, hedge fund, short selling, bull/bear market).\n' +
    '- Use established Persian equivalents for common financial concepts ' +
    '  (e.g. "سهام" for stocks, "اوراق قرضه" for bonds, "نرخ بهره" for interest rate, ' +
    '  "تورم" for inflation, "بازده" for return/yield).\n' +
    '- Maintain numerical precision: do NOT alter figures, percentages, or currency values.\n' +
    '- For cryptocurrency terms (blockchain, mining, staking, DeFi), keep English terms.\n' +
    '- Preserve company names, ticker symbols, and index names in English (S&P 500, NASDAQ, etc.).'
};

/**
 * Translate an array of strings to Persian in a single request.
 * Returns an object with `translations` (array) and `phrases` (array of string arrays).
 */
async function translateBatch(texts, cfg, videoMeta = null) {
  if (!texts.length) return { translations: [], phrases: [] };

  // Serve from cache where possible; only send the misses.
  const missesIdx = [];
  const resultTranslations = new Array(texts.length);
  const resultPhrases = new Array(texts.length).fill(null).map(() => []);

  texts.forEach((t, i) => {
    if (cache.has(t)) {
      const entry = cache.get(t);
      if (typeof entry === 'object' && entry !== null && entry.fa !== undefined) {
        if (entry.fa !== "") {
          resultTranslations[i] = entry.fa;
          resultPhrases[i] = entry.phrases || [];
        }
      } else if (typeof entry === 'string' && entry !== "") {
        resultTranslations[i] = entry;
        resultPhrases[i] = [];
      }
    }
    if (resultTranslations[i] === undefined) missesIdx.push(i);
  });

  if (!missesIdx.length) {
    return { translations: resultTranslations, phrases: resultPhrases };
  }

  const missTexts = missesIdx.map((idx) => texts[idx]);

  // Route requests based on provider
  let batchRes = { translations: [], phrases: [] };
  if (cfg.provider === 'google_free') {
    await throttleRequest(15);
    const googleTrans = await translateGoogleFree(missTexts);
    batchRes = { translations: googleTrans, phrases: missTexts.map(() => []) };
  } else {
    // Resolve domain once per video — only log when video or domain changes
    let domain = 'general';
    const DOMAIN_LABELS = { tech: '💻 فنی و تکنولوژی', medical: '🧬 پزشکی و بایولوژی', finance: '📊 مالی و اقتصادی', general: '📝 عمومی' };
    const videoTitle = videoMeta?.title || '';

    if (cfg.translationDomain && cfg.translationDomain !== 'auto') {
      domain = cfg.translationDomain;
    } else {
      domain = detectVideoDomain(videoMeta);
    }

    // Log only once per video+domain combo to avoid console spam
    const domainKey = `${videoTitle}_${domain}_${cfg.translationDomain || 'auto'}`;
    if (domainKey !== translateBatch._lastDomainKey) {
      translateBatch._lastDomainKey = domainKey;
      const source = (cfg.translationDomain && cfg.translationDomain !== 'auto') ? '📌 دستی' : '🔍 خودکار';
      console.log(`[ytfa] 📌 Translation domain: ${DOMAIN_LABELS[domain] || domain} | Source: ${source} | Video: "${videoTitle.slice(0, 70)}"`);
    }

    batchRes = await translateLLMBatch(missTexts, cfg, domain);
  }

  missesIdx.forEach((idx, i) => {
    const fa = (batchRes.translations[i] !== undefined ? batchRes.translations[i] : texts[idx]).trim();
    const phrases = (batchRes.phrases && batchRes.phrases[i]) ? batchRes.phrases[i] : [];
    if (fa !== "") {
      cache.set(texts[idx], { fa, phrases });
    }
    resultTranslations[idx] = fa;
    resultPhrases[idx] = phrases;
  });

  return { translations: resultTranslations, phrases: resultPhrases };
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

/** Helper function to wrap fetch with AbortController timeout */
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`[ytfa] ⏱️ Fetch request timed out after ${timeoutMs}ms`);
      throw new Error('ERR_TIMEOUT');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function translateOneGoogleFree(text) {
  const url = `https://translate.googleapis.com/translate_a/single?client=dict-chrome-ex&sl=auto&tl=fa&dt=t`;
  try {
    let res;
    try {
      res = await fetchWithTimeout(url, { 
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `q=${encodeURIComponent(text)}`
      }, 10000);
    } catch (fetchErr) {
      if (fetchErr.message === 'ERR_TIMEOUT') throw fetchErr;
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
async function translateLLMBatch(missTexts, cfg, domain = 'general') {
  let batchRes = { translations: [], phrases: [] };

  // Attempt 1: Standard Delimiter Batch (JSON Array Mode)
  try {
    console.log(`[ytfa] Attempt 1: Batch translation for ${missTexts.length} items.`);
    batchRes = await batchRequestLLM(missTexts, cfg, false, domain);
    if (batchRes.translations.length === missTexts.length) {
      return batchRes;
    }
    console.warn(`[ytfa] Attempt 1 misaligned. Expected ${missTexts.length}, got ${batchRes.translations.length}.`);
  } catch (e) {
    if (e.message === 'ERR_TIMEOUT') {
      console.warn(`[ytfa] ⏱️ Attempt 1 batch request timed out. Aborting hung request and retrying...`);
    } else {
      console.error(`[ytfa] Attempt 1 batch request failed:`, e);
    }
  }

  // Attempt 2: Stricter Batch Retry (JSON Array Mode)
  try {
    console.log(`[ytfa] Attempt 2: Retrying with stricter instructions...`);
    batchRes = await batchRequestLLM(missTexts, cfg, true, domain);
    if (batchRes.translations.length === missTexts.length) {
      return batchRes;
    }
    console.warn(`[ytfa] Attempt 2 misaligned. Expected ${missTexts.length}, got ${batchRes.translations.length}.`);
  } catch (e) {
    if (e.message === 'ERR_TIMEOUT') {
      console.warn(`[ytfa] ⏱️ Attempt 2 batch request timed out.`);
    } else {
      console.error(`[ytfa] Attempt 2 batch retry failed:`, e);
    }
  }

  // Safe & Strictly Sequential Fallback (100% RPM-Safe)
  console.warn(`[ytfa] Batch translation failed. Falling back to sequential individual translation.`);
  const translations = await translateIndividuallyLLM(missTexts, cfg, domain);
  return { translations, phrases: missTexts.map(() => []) };
}

/** Strictly Sequential and RPM-safe Individual Fallback with proper error propagation */
async function translateIndividuallyLLM(missTexts, cfg, domain = 'general') {
  const out = new Array(missTexts.length);
  for (let i = 0; i < missTexts.length; i++) {
    try {
      out[i] = await translateOneLLM(missTexts[i], cfg, domain);
    } catch (e) {
      console.error(`[ytfa] Individual translation failed for index ${i}:`, e);

      if (
        e.message === 'ERR_429' ||
        e.message === 'ERR_AUTH' ||
        e.message === 'ERR_SERVER' ||
        e.message === 'ERR_400' ||
        e.message === 'ERR_NETWORK' ||
        e.message === 'ERR_TIMEOUT' ||
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
async function batchRequestLLM(missTexts, cfg, strict = false, domain = 'general') {
  const payloadObject = {};
  missTexts.forEach((text, i) => {
    payloadObject[String(i)] = text;
  });

  const domainBase = DOMAIN_PROMPTS[domain] || DOMAIN_PROMPTS.general;

  let system =
    domainBase + '\n' +
    'You will receive a JSON object of English subtitle strings, where each key represents the line index.\n' +
    'Additionally, identify any phrasal verbs, idioms, or multi-word expressions (e.g. "look after", "give up", "take care of", "as well as") present in each line, and include them in the "phrases" object mapping line index to an array of detected multi-word expressions.\n' +
    'Your output must be a valid JSON object containing both "translations" and "phrases" under their respective keys, using the EXACT SAME numeric keys as the input.\n' +
    'Do not omit any keys, do not skip any lines, and do not combine translation strings.\n' +
    'If no multi-word expressions exist in a line, provide an empty array [] for that key in "phrases".\n' +
    'Do not include any explanation, notes, or markdown formatting (except standard JSON).\n' +
    'Example output format:\n' +
    '{\n' +
    '  "translations": {\n' +
    '    "0": "من باید از برادرم مراقبت کنم",\n' +
    '    "1": "خوش آمدید"\n' +
    '  },\n' +
    '  "phrases": {\n' +
    '    "0": ["look after"],\n' +
    '    "1": []\n' +
    '  }\n' +
    '}';

  if (strict) {
    system += `\nCRITICAL: The "translations" and "phrases" objects MUST contain exactly all keys from "0" to "${missTexts.length - 1}".`;
  }

  // Dynamic timeout: base 15 seconds + 1.5 seconds per item, capped between 15s and 25s
  const timeoutMs = Math.min(25000, Math.max(15000, missTexts.length * 1500));

  const content = await llmChat({
    system,
    user: JSON.stringify(payloadObject),
    cfg,
    isJson: true,
    timeoutMs
  });

  return parseJSONTranslations(content, missTexts.length);
}

/** Parses the LLM response safely using explicit Key-Value index mapping */
function parseJSONTranslations(content, expected) {
  let cleaned = content.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  const translations = new Array(expected).fill("");
  const phrases = new Array(expected).fill(null).map(() => []);

  try {
    const parsed = JSON.parse(cleaned);

    if (parsed && typeof parsed === 'object') {
      const transObj = parsed.translations || (parsed[String(0)] !== undefined && typeof parsed[String(0)] === 'string' ? parsed : null);
      if (transObj && typeof transObj === 'object' && !Array.isArray(transObj)) {
        for (let i = 0; i < expected; i++) {
          const val = transObj[String(i)];
          translations[i] = val !== undefined ? String(val).trim() : "";
        }
      } else if (Array.isArray(parsed)) {
        parsed.forEach((x, i) => {
          if (i < expected) translations[i] = String(x).trim();
        });
      }

      if (parsed.phrases && typeof parsed.phrases === 'object') {
        for (let i = 0; i < expected; i++) {
          const pList = parsed.phrases[String(i)] || parsed.phrases[i];
          if (Array.isArray(pList)) {
            phrases[i] = pList.map(p => String(p).trim()).filter(Boolean);
          }
        }
      }
    }
  } catch (e) {
    console.error('[ytfa] Failed to parse JSON translations:', e, 'Raw content:', content);
  }

  return { translations, phrases };
}

/** Translate a single line of text directly. */
async function translateOneLLM(text, cfg, domain = 'general') {
  const domainBase = DOMAIN_PROMPTS[domain] || DOMAIN_PROMPTS.general;
  const system =
    domainBase + '\n' +
    'Translate the following single subtitle line.\n' +
    'Output ONLY the translation, and do NOT include any introduction, notes, markdown formatting, or explanations.';

  const content = await llmChat({
    system,
    user: text,
    cfg,
    isJson: false,
    timeoutMs: 10000
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
async function llmChat({ system, user, cfg, isJson = false, timeoutMs = 15000 }) {
  if (cfg.provider !== 'local') {
    const activeModel = getActiveModel(cfg);
    const modelRpm = (cfg.modelRpms && cfg.modelRpms[activeModel]) || cfg.rpm || 15;
    await throttleRequest(modelRpm);
  }

  if (cfg.provider === 'openrouter') {
    if (!cfg.apiKey) throw new Error('NO_API_KEY');
    return openrouterChat({ apiKey: cfg.apiKey, model: cfg.model, system, user, isJson, timeoutMs });
  } else if (cfg.provider === 'gemini') {
    if (!cfg.geminiApiKey) throw new Error('NO_API_KEY');
    return geminiChat({ apiKey: cfg.geminiApiKey, model: cfg.geminiModel, system, user, isJson, timeoutMs });
  } else if (cfg.provider === 'grok') {
    if (!cfg.grokApiKey) throw new Error('NO_API_KEY');
    return openaiCompatibleChat({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: cfg.grokApiKey, model: cfg.grokModel, system, user, isJson, timeoutMs });
  } else if (cfg.provider === 'deepseek') {
    if (!cfg.deepseekApiKey) throw new Error('NO_API_KEY');
    return openaiCompatibleChat({ baseUrl: 'https://api.deepseek.com', apiKey: cfg.deepseekApiKey, model: cfg.deepseekModel, system, user, isJson, timeoutMs });
  } else if (cfg.provider === 'openai') {
    if (!cfg.openaiApiKey) throw new Error('NO_API_KEY');
    return openaiCompatibleChat({ baseUrl: 'https://api.openai.com/v1', apiKey: cfg.openaiApiKey, model: cfg.openaiModel, system, user, isJson, timeoutMs });
  } else if (cfg.provider === 'local') {
    const baseUrl = cfg.localBaseUrl || 'http://localhost:11434/v1';
    return openaiCompatibleChat({ baseUrl, apiKey: null, model: cfg.localModel || 'llama3', system, user, isJson, timeoutMs });
  } else if (cfg.provider === 'custom') {
    if (!cfg.customBaseUrl) throw new Error('NO_BASE_URL');
    return openaiCompatibleChat({ baseUrl: cfg.customBaseUrl, apiKey: cfg.customApiKey || null, model: cfg.customModel || '', system, user, isJson, timeoutMs });
  }
  throw new Error(`Unknown provider: ${cfg.provider}`);
}

/** Google AI Studio (Gemini) API Chat */
async function geminiChat({ apiKey, model, system, user, isJson = false, timeoutMs = 15000 }) {
  const cleanModel = (model || 'gemini-2.5-flash').trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${apiKey}`;
  const generationConfig = { temperature: 0.2 };
  if (isJson) generationConfig.responseMimeType = 'application/json';

  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig
      })
    }, timeoutMs);
  } catch (fetchErr) {
    if (fetchErr.message === 'ERR_TIMEOUT') throw fetchErr;
    throw new Error('ERR_NETWORK');
  }

  if (!res.ok) {
    let errBody = '';
    try { errBody = await res.text(); } catch {}
    console.warn(`[ytfa] Gemini API error (status ${res.status}, model "${cleanModel}"):`, errBody);

    // Detect geo-restriction (Iran, etc.)
    if ((res.status === 400 || res.status === 403) && (
      errBody.includes('User location is not supported') ||
      errBody.includes('FAILED_PRECONDITION') ||
      errBody.includes('location') ||
      errBody.includes('country') ||
      errBody.includes('region')
    )) {
      console.error('[ytfa] ⛔ Gemini API geo-restricted. User location is not supported.');
      throw new Error('ERR_GEO');
    }

    // Auto-fallback if model or API version dislikes native JSON mode or systemInstruction
    if (res.status === 400) {
      console.warn(`[ytfa] Gemini returned 400. Retrying with merged prompt...`);
      try {
        const fallbackRes = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: `${system}\n\n${user}` }] }],
            generationConfig: { temperature: 0.2 }
          })
        }, timeoutMs);
        if (fallbackRes.ok) {
          const fallbackData = await fallbackRes.json();
          return fallbackData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        }
      } catch (e) {
        console.warn('[ytfa] Gemini fallback retry failed:', e);
      }
    }

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
async function openaiCompatibleChat({ baseUrl, apiKey, model, system, user, isJson = false, timeoutMs = 15000 }) {
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
    res = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
  } catch (fetchErr) {
    if (fetchErr.message === 'ERR_TIMEOUT') throw fetchErr;
    throw new Error('ERR_NETWORK');
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.warn(`[ytfa] OpenAI compatible API error (status ${res.status}):`, txt);

    // Detect geo-restriction (OpenAI / Groq 403 or 400)
    if ((res.status === 400 || res.status === 403) && (
      txt.includes('unsupported_country') ||
      txt.includes('country') ||
      txt.includes('region') ||
      txt.includes('territory') ||
      txt.includes('location') ||
      txt.includes('Access denied') ||
      txt.includes('Cloudflare')
    )) {
      console.error('[ytfa] ⛔ API provider geo-restricted / blocked by IP:', txt);
      throw new Error('ERR_GEO');
    }

    if (res.status === 400 && isJson && (txt.includes('json_object') || txt.includes('response_format') || txt.includes('INVALID_REQUEST_BODY'))) {
      console.warn(`[ytfa] Provider/Model does not support native JSON mode. Retrying without response_format...`);
      return openaiCompatibleChat({ baseUrl, apiKey, model, system, user, isJson: false, timeoutMs });
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
async function openrouterChat({ apiKey, model, system, user, isJson = false, timeoutMs = 15000 }) {
  const body = {
    model: model || DEFAULT_MODEL,
    temperature: 0.2,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  if (isJson) body.response_format = { type: 'json_object' };

  let res;
  try {
    res = await fetchWithTimeout(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://www.youtube.com/',
        'X-Title': 'Persian YouTube Translator',
      },
      body: JSON.stringify(body),
    }, timeoutMs);
  } catch (fetchErr) {
    if (fetchErr.message === 'ERR_TIMEOUT') throw fetchErr;
    throw new Error('ERR_NETWORK');
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.warn(`[ytfa] OpenRouter API error (status ${res.status}):`, txt);

    // Detect geo-restriction (OpenRouter 403 or 400)
    if ((res.status === 400 || res.status === 403) && (
      txt.includes('unsupported_country') ||
      txt.includes('country') ||
      txt.includes('region') ||
      txt.includes('territory') ||
      txt.includes('location') ||
      txt.includes('geoblocked')
    )) {
      console.error('[ytfa] ⛔ OpenRouter geo-restricted / blocked by IP:', txt);
      throw new Error('ERR_GEO');
    }

    if (res.status === 400 && isJson && (txt.includes('json_object') || txt.includes('response_format') || txt.includes('INVALID_REQUEST_BODY'))) {
      console.warn(`[ytfa] Model ${model} does not support native JSON mode. Retrying without response_format...`);
      return openrouterChat({ apiKey, model, system, user, isJson: false, timeoutMs });
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

async function translateWordDictionary(word, sentence, cfg) {
  if (!word) return { translation: '', ipa: '', formality: '', tutorNote: '', synonyms: [] };

  if (cfg.provider === 'google_free') {
    return await translateWordGoogleFree(word, sentence);
  }

  const system =
    'You are an expert English language tutor helping a learner understand English vocabulary and nuances in context.\n' +
    'Analyze the given English word in the context of the sentence.\n' +
    'Output a valid JSON object ONLY (strictly matching this JSON schema):\n' +
    '{\n' +
    '  "translation": "دقیق‌ترین معنی یا مفهوم کلمه در این جمله (به فارسی روان و طبیعی)",\n' +
    '  "ipa": "IPA phonetic pronunciation e.g. /ˌkɒnvəˈseɪʃn/",\n' +
    '  "formality": "One of: اصطلاح | عامیانه | محاوره‌ای | رسمی (or empty string if general/standard)",\n' +
    '  "synonyms": ["مترادف فارسی ۱", "مترادف فارسی ۲"],\n' +
    '  "tutorNote": "نکته آموزشی انگلیسی (کوتاه در ۱ جمله فارسی): مثلاً کالوکیشن‌های رایج انگلیسی با این کلمه، حروف اضافه همراه آن در انگلیسی، یا تفاوت کاربرد آن با کلمات مشابه در انگلیسی. هرگز به کاربر یاد ندهید که در زبان فارسی چه بگوید یا چه نگوید!"\n' +
    '}';

  const user = `Word: "${word}"\nSentence context: "${sentence || ''}"`;

  try {
    const response = await llmChat({
      system,
      user,
      cfg,
      isJson: true,
      timeoutMs: 9000
    });

    let cleaned = response.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    const formalityRaw = (parsed.formality || '').trim();
    const formality = ['اصطلاح', 'عامیانه', 'محاوره‌ای', 'رسمی'].includes(formalityRaw) ? formalityRaw : '';

    return {
      translation: parsed.translation || '',
      ipa: (parsed.ipa || '').replace(/^\/+|\/+$/g, ''),
      formality: formality,
      synonyms: Array.isArray(parsed.synonyms) ? parsed.synonyms : [],
      tutorNote: parsed.tutorNote || '',
    };
  } catch (err) {
    console.warn('[ytfa] AI tutor parse failed, falling back to Google free dict:', err);
    return await translateWordGoogleFree(word, sentence);
  }
}

async function translateWordGoogleFree(word, sentence) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=fa&dt=t&dt=bd&dt=rm&q=${encodeURIComponent(word)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('ERR_SERVER');
    const data = await res.json();
    
    let mainTrans = '';
    let ipa = '';
    if (data && data[0] && data[0][0] && data[0][0][0]) {
      mainTrans = data[0][0][0].trim();
    }
    if (data && data[0] && data[0][1] && data[0][1][3]) {
      ipa = data[0][1][3];
    }

    const synonyms = [];
    if (data && data[1] && Array.isArray(data[1])) {
      data[1].forEach(dictGroup => {
        if (dictGroup && Array.isArray(dictGroup[2])) {
          dictGroup[2].forEach(item => {
            if (item && item[0] && item[0] !== mainTrans && !synonyms.includes(item[0])) {
              synonyms.push(item[0]);
            }
          });
        }
      });
    }

    const topSynonyms = synonyms.slice(0, 4);

    return {
      translation: mainTrans || word,
      ipa: ipa,
      formality: '',
      synonyms: topSynonyms,
      tutorNote: '',
    };
  } catch (e) {
    console.error('[ytfa] Google word dictionary fetch failed:', e);
    const fallbackText = await translateOneGoogleFree(word).catch(() => word);
    return {
      translation: fallbackText || word,
      ipa: '',
      formality: '',
      synonyms: [],
      tutorNote: '',
    };
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'update') {
    chrome.tabs.create({ url: chrome.runtime.getURL('public/changelog.html') });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'TRANSLATE') {
    (async () => {
      try {
        const cfg = await getConfig();
        if (!cfg.enabled) {
          sendResponse({ ok: false, error: 'APP_DISABLED' });
          return;
        }

        // اگر درخواست از تبی بیاید که در حال حاضر اکتیو/فعال نیست، آن را رد کن
        if (sender?.tab && sender.tab.active === false) {
          sendResponse({ ok: false, error: 'TAB_INACTIVE' });
          return;
        }

        const out = await translateBatch(msg.texts, cfg, msg.videoMeta || null);
        sendResponse({ ok: true, translations: out.translations, phrases: out.phrases });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true; // keep the channel open for the async response
  }

  if (msg?.type === 'TRANSLATE_WORD_DICTIONARY') {
    (async () => {
      try {
        const cfg = await getConfig();
        const result = await translateWordDictionary(msg.word, msg.sentence, cfg);
        sendResponse({ ok: true, translation: result });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }

  if (msg?.type === 'GET_CLOUD_CACHE') {
    (async () => {
      try {
        const cfg = await getConfig();
        const result = await fetchCloudCache(msg.videoId, cfg);
        sendResponse({ ok: true, data: result });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }

  if (msg?.type === 'SAVE_CLOUD_CACHE') {
    (async () => {
      try {
        const cfg = await getConfig();
        const result = await uploadCloudCache(msg.videoId, msg.cues, msg.title, cfg);
        sendResponse({ ok: true, data: result });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
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
      'localBaseUrl', 'customBaseUrl', 'translationDomain'
    ];
    const changed = keysToCheck.some(key => key in changes);
    if (changed) {
      console.log('[ytfa] Configuration changed. Clearing translation cache.');
      cache.clear();
      translateBatch._lastDomainKey = null; // Reset domain log so it re-logs on next batch
    }
  }
});