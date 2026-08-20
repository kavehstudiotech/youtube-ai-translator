/*
 * content.js  —  isolated-world content script (the orchestrator).
 *
 *  - Asks the MAIN-world bridge for the current video's caption tracks.
 *  - Downloads the timed-text (json3) track and parses it into cues.
 *  - Sends cue text to the background worker for Persian translation (batched).
 *  - Renders a styled, synced subtitle overlay on top of the player.
 *  - Reacts to SPA navigation and live settings changes.
 */

const REQ = 'ytfa-req';
const RES = 'ytfa-res';

function isYouTubeVideoPage() {
  if (!window.location.hostname.includes('youtube.com')) return true;
  const path = window.location.pathname;
  return path.includes('/watch') || path.includes('/shorts/');
}

function getVideoIdFromUrl(url = window.location.href) {
  try {
    const parsed = new URL(url, window.location.origin);
    const shortsMatch = parsed.pathname.match(/^\/shorts\/([^/?#]+)/);
    if (shortsMatch) return shortsMatch[1];
    if (parsed.pathname.includes('/watch')) return parsed.searchParams.get('v');
  } catch (error) {
    console.warn('[ytfa] failed to parse video URL:', error);
  }
  return null;
}

function isExtensionValid() {
  try {
    return typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  } catch {
    return false;
  }
}

const MAX_CACHE_SIZE = 15;
const captionCache = new Map();
let currentVideoId = getVideoIdFromUrl();

function getCaptionCacheKey(videoId, sourceText) {
  return `${videoId}_${sourceText}`;
}

function getCachedCaption(videoId, sourceText) {
  if (!videoId) return undefined;
  const key = getCaptionCacheKey(videoId, sourceText);
  if (!captionCache.has(key)) return undefined;

  const value = captionCache.get(key);
  captionCache.delete(key);
  captionCache.set(key, value);
  return value;
}

function cacheCaption(videoId, sourceText, translatedText, phrases = []) {
  if (!videoId || !sourceText) return;
  const key = getCaptionCacheKey(videoId, sourceText);
  captionCache.delete(key);
  captionCache.set(key, { fa: translatedText, phrases: phrases || [] });

  while (captionCache.size > MAX_CACHE_SIZE) {
    const oldestKey = captionCache.keys().next().value;
    if (oldestKey === undefined) break;
    captionCache.delete(oldestKey);
  }
}

function applyCachedCaptions(videoId, cues) {
  for (const cue of cues) {
    const cached = getCachedCaption(videoId, cue.text);
    if (cached !== undefined) {
      if (typeof cached === 'object' && cached !== null && cached.fa !== undefined) {
        cue.fa = cached.fa;
        cue.phrases = cached.phrases || [];
      } else {
        cue.fa = cached;
        cue.phrases = cue.phrases || [];
      }
    }
  }
}

const SETTINGS_DEFAULTS = {
  enabled: true,
  showOriginal: true,
  showPersian: true,
  origFirst: false,
  activeRecall: false,
  faFontSize: 26,
  faColor: '#ffffff',
  faFontFamily: "'Vazirmatn', Tahoma, Arial, sans-serif",
  faBold: true,
  origFontSize: 17,
  origColor: '#ffd24a',
  bgColor: '#000000',
  bgOpacity: 0.55,
  bottomOffset: 8, // percent from the bottom of the player
  rpm: 15,
};

let settings = { ...SETTINGS_DEFAULTS };
let state = {
  videoId: null,
  cues: [], // [{ start, end, text, fa }]
  loading: false,
  currentIndex: -1,
  activeVideo: null,
  rafId: null,
  translationSessionId: 0,
  videoMeta: null, // { title, category, keywords, shortDescription }
  loadedFromCloudCache: false,
  uploadedToCloud: false,
  bypassCloudCache: false,
  cachedModels: [], // array of { provider, modelId, modelName, cues, createdAt }
  activeModelIndex: -1,
};

// Temporary visibility toggle (independent of settings.enabled).
let subtitleVisible = true;
// Whether the last boot() attempt ended in a hard error.
let bootFailed = false;
// Changes whenever a boot attempt is cancelled or superseded.
let bootGeneration = 0;

/* ------------------------------- fonts ------------------------------- */

async function loadFonts() {
  const defs = [
    { weight: '400', file: 'fonts/Vazirmatn-Regular.woff2' },
    { weight: '700', file: 'fonts/Vazirmatn-Bold.woff2' },
  ];
  for (const d of defs) {
    try {
      const buf = await (await fetch(chrome.runtime.getURL(d.file))).arrayBuffer();
      const ff = new FontFace('Vazirmatn', buf, { weight: d.weight, style: 'normal' });
      await ff.load();
      document.fonts.add(ff);
    } catch (e) {
      console.warn('[ytfa] font load failed:', d.file, e);
    }
  }
}

/* ----------------------------- settings ----------------------------- */

async function loadSettings() {
  const stored = await chrome.storage.sync.get(SETTINGS_DEFAULTS);
  settings = { ...SETTINGS_DEFAULTS, ...stored };
  applyStyles();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  let touched = false;
  let requiresRetranslation = false;

  const TRANSLATION_KEYS = new Set([
    'enabled', 'provider', 'apiKey', 'geminiApiKey', 'grokApiKey',
    'deepseekApiKey', 'openaiApiKey', 'model', 'geminiModel', 'grokModel',
    'deepseekModel', 'openaiModel', 'localBaseUrl', 'localModel',
    'customBaseUrl', 'customApiKey', 'customModel', 'rpm', 'translationDomain'
  ]);

  for (const key of Object.keys(changes)) {
    if (key in settings || key in SETTINGS_DEFAULTS) {
      settings[key] = changes[key].newValue;
      touched = true;
      if (TRANSLATION_KEYS.has(key)) {
        requiresRetranslation = true;
      }
    }
  }

  if (touched) {
    applyStyles();

    if (!settings.enabled) {
      bootGeneration++;
      state.loading = false;
      hideBar();
      stopTranslation();
      const player =
        document.querySelector('.html5-video-player') ||
        document.getElementById('movie_player');
      if (player) player.classList.remove('ytfa-on');
      if (toggleBtn) toggleBtn.style.display = 'none';
    } else if (isYouTubeVideoPage()) {
      bootFailed = false;
      subtitleVisible = true;
      if (bar) attachBar();
      ensureToggleBtn();
      updateToggleBtn();

      // Only trigger re-translation / boot if translation configuration changed
      if (requiresRetranslation) {
        if (!state.cues.length && !state.loading) {
          boot();
        } else if (state.cues.length) {
          stopTranslation();
          translateAll();
        }
      }
    } else {
      cleanupPageUi();
    }
  }
});

/* ------------------------- subtitle overlay UI ----------------------- */

let bar, faEl, origEl;

const COMMON_MULTI_WORD_EXPRESSIONS = [
  'look after', 'look for', 'look forward to', 'look into', 'look up', 'look out', 'look back', 'look at',
  'take care of', 'take care', 'take off', 'take over', 'take on', 'take out', 'take up', 'take in',
  'give up', 'give in', 'give away', 'give back', 'give out',
  'turn on', 'turn off', 'turn up', 'turn down', 'turn out', 'turn in', 'turn over',
  'get up', 'get out', 'get back', 'get along', 'get in', 'get off', 'get away', 'get over', 'get through', 'get by',
  'go on', 'go off', 'go out', 'go back', 'go through', 'go over', 'go away',
  'come on', 'come in', 'come back', 'come out', 'come up', 'come across', 'come over',
  'set up', 'set off', 'set out', 'put on', 'put off', 'put out', 'put away', 'put up',
  'run out', 'run into', 'run away', 'find out', 'figure out', 'work out', 'break down', 'break out', 'break up',
  'bring up', 'bring out', 'carry out', 'call off', 'check in', 'check out', 'drop off', 'hold on', 'keep up',
  'point out', 'shut up', 'stand up', 'sit down', 'wake up', 'make up', 'pass out', 'pay back',
  'as well as', 'at least', 'so that', 'in order to', 'according to', 'because of', 'due to',
  'instead of', 'as long as', 'as soon as', 'by the way', 'for example', 'for instance',
  'in spite of', 'kind of', 'sort of', 'a lot of', 'lots of', 'at all', 'right now', 'so far'
];

function getFallbackPhrases(text) {
  if (!text) return [];
  const matches = [];
  const lowerText = text.toLowerCase();
  for (const expr of COMMON_MULTI_WORD_EXPRESSIONS) {
    const escaped = expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    if (regex.test(lowerText)) {
      matches.push(expr);
    }
  }
  return matches;
}

function renderClickableOriginalText(text, phrases) {
  if (!origEl) return;
  origEl.textContent = '';
  if (!text) return;

  let effectivePhrases = (Array.isArray(phrases) && phrases.length) ? phrases : getFallbackPhrases(text);

  // Remove duplicates and sort by length descending to prioritize longer multi-word phrases
  effectivePhrases = Array.from(new Set(effectivePhrases))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  // Find all non-overlapping occurrences of phrases in text
  const ranges = [];
  for (const phrase of effectivePhrases) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    let m;
    while ((m = regex.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      // Check if overlaps with an already chosen longer phrase match
      const overlaps = ranges.some(r => !(end <= r.start || start >= r.end));
      if (!overlaps) {
        ranges.push({ start, end, phrase, matchedText: m[0] });
      }
    }
  }

  ranges.sort((a, b) => a.start - b.start);

  let lastIndex = 0;
  for (const range of ranges) {
    if (range.start > lastIndex) {
      renderSingleWords(text.slice(lastIndex, range.start), origEl);
    }

    const span = document.createElement('span');
    span.className = 'ytfa-word ytfa-phrase';
    span.textContent = range.matchedText;
    span.dataset.word = range.phrase;
    span.addEventListener('click', (e) => {
      e.stopPropagation();
      onWordClick(span, range.phrase);
    });
    origEl.appendChild(span);

    lastIndex = range.end;
  }

  if (lastIndex < text.length) {
    renderSingleWords(text.slice(lastIndex), origEl);
  }
}

function renderSingleWords(subText, parentEl) {
  const regex = /([\w\u0600-\u06FF']+)|([^\w\u0600-\u06FF']+)/g;
  let match;

  while ((match = regex.exec(subText)) !== null) {
    const wordToken = match[1];
    const nonWordToken = match[2];

    if (wordToken) {
      const span = document.createElement('span');
      span.className = 'ytfa-word';
      span.textContent = wordToken;
      span.dataset.word = wordToken;
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        onWordClick(span, wordToken);
      });
      parentEl.appendChild(span);
    } else if (nonWordToken) {
      parentEl.appendChild(document.createTextNode(nonWordToken));
    }
  }
}

function speakWord(text) {
  if (!text || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
  } catch (e) {
    console.warn('[ytfa] Speech synthesis failed:', e);
  }
}

let tutorModalEl = null;

function positionTutorModal(targetEl, modalEl, container) {
  if (!targetEl || !modalEl || !container) return;
  const containerRect = container.getBoundingClientRect();
  const targetRect = targetEl.getBoundingClientRect();

  // Position above the clicked word
  let top = targetRect.top - containerRect.top - modalEl.offsetHeight - 10;
  let left = targetRect.left - containerRect.left + (targetRect.width / 2) - (modalEl.offsetWidth / 2);

  // If overflowing top of player, place it below the subtitle
  if (top < 12) {
    top = targetRect.bottom - containerRect.top + 10;
  }
  // Keep horizontally within container
  if (left < 12) left = 12;
  if (left + modalEl.offsetWidth > containerRect.width - 12) {
    left = containerRect.width - modalEl.offsetWidth - 12;
  }

  modalEl.style.top = `${top}px`;
  modalEl.style.left = `${left}px`;
  modalEl.style.transform = 'none';
}

async function isWordSaved(word, en, videoId) {
  if (!isExtensionValid() || !chrome?.storage?.local) return false;
  try {
    const data = await chrome.storage.local.get({ savedWords: [] });
    const savedWords = data?.savedWords || [];
    return savedWords.some(
      (item) => (item.word || item.en) === word && item.en === en && item.videoId === videoId
    );
  } catch {
    return false;
  }
}

async function removeWordFromFlashcards(word, en, videoId) {
  if (!isExtensionValid() || !chrome?.storage?.local) return;
  try {
    const data = await chrome.storage.local.get({ savedWords: [] });
    let savedWords = (data?.savedWords || []).filter(
      (item) => !((item.word || item.en) === word && item.en === en && item.videoId === videoId)
    );
    await chrome.storage.local.set({ savedWords });
  } catch (err) {
    console.warn('[ytfa] Failed to remove word from flashcards:', err);
  }
}

async function saveWordToFlashcards(word, wordFa, en, fa, ipa = '', videoMeta = null) {
  if (!isExtensionValid() || !chrome?.storage?.local) {
    notify('افزونه به‌روزرسانی شد. لطفاً صفحه را تازه (رفرش) کنید 🔄');
    return;
  }

  const vId = state.videoId || getVideoIdFromUrl() || 'video';
  const video = getVideo();
  const currentTimeSec = video ? Math.floor(video.currentTime) : 0;
  const rawTitle =
    videoMeta?.title ||
    document.querySelector('h1.ytd-watch-metadata, h1.ytd-video-primary-info-renderer')
      ?.textContent?.trim() || document.title.replace('- YouTube', '').trim();
  const url = `https://www.youtube.com/watch?v=${vId}&t=${currentTimeSec}s`;

  const newItem = {
    id: 'sw_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    word: word,
    wordFa: wordFa,
    ipa: ipa,
    en: en || '',
    fa: fa || '',
    title: rawTitle || 'ویدیو یوتیوب',
    url: url,
    videoId: vId,
    timestamp: currentTimeSec,
    dateAdded: new Date().toISOString(),
  };

  try {
    const data = await chrome.storage.local.get({ savedWords: [] });
    let savedWords = data?.savedWords || [];

    const existsIndex = savedWords.findIndex(
      (item) => (item.word || item.en) === word && item.en === en && item.videoId === vId
    );

    if (existsIndex === -1) {
      savedWords.unshift(newItem);
    } else {
      if (wordFa) savedWords[existsIndex].wordFa = wordFa;
      if (ipa) savedWords[existsIndex].ipa = ipa;
    }
    await chrome.storage.local.set({ savedWords });
  } catch (err) {
    console.warn('[ytfa] Failed to save word to flashcards:', err);
  }
}

function showAiTutorModal(targetSpan, word, sentence, tutorData, cueFa, videoMeta, isInitiallySaved, isLoading = false) {
  if (tutorModalEl) tutorModalEl.remove();
  const container = getActivePlayer() || document.body;
  const vId = state.videoId || getVideoIdFromUrl() || 'video';

  const trans = tutorData?.translation || '';
  const ipa = tutorData?.ipa || '';
  const formality = (tutorData?.formality || '').trim();
  const synonyms = Array.isArray(tutorData?.synonyms) ? tutorData.synonyms : [];
  const tutorNote = tutorData?.tutorNote || '';

  tutorModalEl = document.createElement('div');
  tutorModalEl.id = 'ytfa-tutor-modal';
  tutorModalEl.dataset.word = word;
  tutorModalEl.innerHTML = `
    <div class="ytfa-tutor-header">
      <div class="ytfa-tutor-word-box">
        <span class="ytfa-tutor-word">${escapeHtml(word)}</span>
        <span class="ytfa-tutor-ipa" style="${ipa ? '' : 'display:none'}">/${escapeHtml(ipa)}/</span>
        <button type="button" class="ytfa-tutor-audio-btn" title="پخش تلفظ">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
          </svg>
        </button>
        <span class="ytfa-tutor-badge" style="${formality && !isLoading ? '' : 'display:none'}">${escapeHtml(formality)}</span>
      </div>
      <div class="ytfa-tutor-actions">
        <button type="button" class="ytfa-tutor-star-btn ${isInitiallySaved ? 'is-saved' : ''}" title="${isInitiallySaved ? 'حذف از فلاش‌کارت‌ها' : 'افزودن به فلاش‌کارت‌ها'}">
          <svg class="ytfa-star-icon" viewBox="0 0 24 24" width="18" height="18" stroke="#fbbf24" stroke-width="2" fill="${isInitiallySaved ? '#fbbf24' : 'none'}" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </button>
        <button type="button" class="ytfa-tutor-close" title="بستن">✕</button>
      </div>
    </div>
    <div class="ytfa-tutor-body">
      ${isLoading ? `
        <div class="ytfa-tutor-loading">
          <span class="ytfa-spinner"></span>
          <span>در حال تحلیل هوش مصنوعی…</span>
        </div>
      ` : `
        <div class="ytfa-tutor-trans-main">${escapeHtml(trans || word)}</div>
        ${synonyms.length > 0 ? `<div class="ytfa-tutor-synonyms">سایر معانی: ${escapeHtml(synonyms.join('، '))}</div>` : ''}
        ${tutorNote ? `
          <div class="ytfa-tutor-note-box">
            <div class="ytfa-tutor-note-title">💡 نکته:</div>
            <div>${escapeHtml(tutorNote)}</div>
          </div>
        ` : ''}
      `}
      <div class="ytfa-tutor-context-box">
        <div class="ytfa-tutor-en-sent">${escapeHtml(sentence)}</div>
        ${cueFa ? `<div class="ytfa-tutor-fa-sent">${escapeHtml(cueFa)}</div>` : ''}
      </div>
    </div>
  `;

  // Speech synthesis button
  tutorModalEl.querySelector('.ytfa-tutor-audio-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    speakWord(word);
  });

  // Star Toggle Button
  const starBtn = tutorModalEl.querySelector('.ytfa-tutor-star-btn');
  starBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const starIcon = starBtn.querySelector('.ytfa-star-icon');
    const isNowSaved = starBtn.classList.contains('is-saved');

    if (isNowSaved) {
      await removeWordFromFlashcards(word, sentence, vId);
      starBtn.classList.remove('is-saved');
      starIcon.setAttribute('fill', 'none');
      starBtn.title = 'افزودن به فلاش‌کارت‌ها';
      notify(`عبارت "${word}" از فلاش‌کارت‌ها حذف شد.`);
    } else {
      const curTrans = tutorModalEl?.querySelector('.ytfa-tutor-trans-main')?.textContent || word;
      const curIpa = tutorModalEl?.querySelector('.ytfa-tutor-ipa')?.textContent.replace(/\//g, '') || '';

      await saveWordToFlashcards(
        word,
        curTrans,
        sentence,
        cueFa,
        curIpa,
        videoMeta
      );
      starBtn.classList.add('is-saved');
      starIcon.setAttribute('fill', '#fbbf24');
      starBtn.title = 'حذف از فلاش‌کارت‌ها';
      starBtn.classList.add('ytfa-star-pop');
      setTimeout(() => starBtn.classList.remove('ytfa-star-pop'), 400);
      notify(`عبارت "${word}" به فلاش‌کارت‌ها اضافه شد ⭐`);
    }
  });

  // Close button
  tutorModalEl.querySelector('.ytfa-tutor-close').addEventListener('click', (e) => {
    e.stopPropagation();
    if (tutorModalEl) {
      tutorModalEl.remove();
      tutorModalEl = null;
    }
  });

  // Prevent clicks inside modal from propagating
  tutorModalEl.addEventListener('click', (e) => e.stopPropagation());

  container.appendChild(tutorModalEl);

  // Position relative to target word
  positionTutorModal(targetSpan, tutorModalEl, container);

  // Auto-speak pronunciation
  speakWord(word);

  // Close on outside click
  const onDocClick = (e) => {
    if (tutorModalEl && !tutorModalEl.contains(e.target) && e.target !== targetSpan) {
      tutorModalEl.remove();
      tutorModalEl = null;
      document.removeEventListener('click', onDocClick);
    }
  };
  setTimeout(() => document.addEventListener('click', onDocClick), 50);
}

function updateAiTutorModalContent(word, sentence, tutorData, cueFa) {
  if (!tutorModalEl || tutorModalEl.dataset.word !== word) return;

  const trans = tutorData?.translation || word;
  const ipa = tutorData?.ipa || '';
  const formality = (tutorData?.formality || '').trim();
  const synonyms = Array.isArray(tutorData?.synonyms) ? tutorData.synonyms : [];
  const tutorNote = tutorData?.tutorNote || '';

  const ipaEl = tutorModalEl.querySelector('.ytfa-tutor-ipa');
  if (ipaEl) {
    if (ipa) {
      ipaEl.textContent = `/${ipa}/`;
      ipaEl.style.display = '';
    } else {
      ipaEl.style.display = 'none';
    }
  }

  const badgeEl = tutorModalEl.querySelector('.ytfa-tutor-badge');
  if (badgeEl) {
    if (formality) {
      badgeEl.textContent = formality;
      badgeEl.style.display = '';
    } else {
      badgeEl.style.display = 'none';
    }
  }

  const bodyEl = tutorModalEl.querySelector('.ytfa-tutor-body');
  if (bodyEl) {
    bodyEl.innerHTML = `
      <div class="ytfa-tutor-trans-main">${escapeHtml(trans)}</div>
      ${synonyms.length > 0 ? `<div class="ytfa-tutor-synonyms">سایر معانی: ${escapeHtml(synonyms.join('، '))}</div>` : ''}
      ${tutorNote ? `
        <div class="ytfa-tutor-note-box">
          <div class="ytfa-tutor-note-title">💡 نکته:</div>
          <div>${escapeHtml(tutorNote)}</div>
        </div>
      ` : ''}
      <div class="ytfa-tutor-context-box">
        <div class="ytfa-tutor-en-sent">${escapeHtml(sentence)}</div>
        ${cueFa ? `<div class="ytfa-tutor-fa-sent">${escapeHtml(cueFa)}</div>` : ''}
      </div>
    `;
  }
}

async function onWordClick(spanEl, word) {
  if (!isExtensionValid()) {
    notify('افزونه به‌روزرسانی شد. لطفاً صفحه را تازه (رفرش) کنید 🔄');
    return;
  }

  const cue = state.cues[state.currentIndex];
  if (!cue) return;

  spanEl.classList.add('ytfa-word-saved');
  setTimeout(() => spanEl.classList.remove('ytfa-word-saved'), 500);

  const vId = state.videoId || getVideoIdFromUrl() || 'video';
  const initiallySaved = await isWordSaved(word, cue.text || '', vId);

  // 1. Show modal INSTANTLY (0ms latency feedback)
  showAiTutorModal(spanEl, word, cue.text || '', null, cue.fa || '', state.videoMeta, initiallySaved, true /* isLoading */);

  // 2. Fetch full AI Tutor Dictionary details asynchronously
  try {
    const dictResp = await chrome.runtime.sendMessage({
      type: 'TRANSLATE_WORD_DICTIONARY',
      word: word,
      sentence: cue.text || ''
    });
    if (dictResp?.ok && dictResp.translation) {
      let tutorData = typeof dictResp.translation === 'object' ? dictResp.translation : { translation: dictResp.translation };
      updateAiTutorModalContent(word, cue.text || '', tutorData, cue.fa || '');
    } else {
      updateAiTutorModalContent(word, cue.text || '', { translation: word }, cue.fa || '');
    }
  } catch (err) {
    if (err?.message?.includes('Extension context invalidated')) {
      notify('افزونه به‌روزرسانی شد. لطفاً صفحه را تازه (رفرش) کنید 🔄');
      return;
    }
    console.warn('[ytfa] Dictionary fetch failed for word/phrase:', word, err);
    updateAiTutorModalContent(word, cue.text || '', { translation: word }, cue.fa || '');
  }
}

function ensureBar() {
  if (!isYouTubeVideoPage()) return null;
  if (bar && document.body.contains(bar)) return bar;

  bar = document.createElement('div');
  bar.id = 'ytfa-bar';
  bar.dir = 'rtl';

  faEl = document.createElement('div');
  faEl.className = 'ytfa-fa';
  faEl.addEventListener('click', (e) => {
    if (settings.activeRecall) {
      e.stopPropagation();
      faEl.classList.toggle('ytfa-manual-reveal');
    }
  });

  origEl = document.createElement('div');
  origEl.className = 'ytfa-orig';
  origEl.dir = 'ltr';

  bar.appendChild(faEl);
  bar.appendChild(origEl);

  attachBar();
  applyStyles();
  return bar;
}

function getActiveReelRenderer() {
  if (!window.location.pathname.startsWith('/shorts/')) return null;

  const candidates = Array.from(
    document.querySelectorAll('ytd-reel-video-renderer')
  ).map((renderer) => {
    const video = renderer.querySelector('video.html5-main-video, video');
    const rect = renderer.getBoundingClientRect();
    const visibleWidth = Math.max(
      0,
      Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0)
    );
    const visibleHeight = Math.max(
      0,
      Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
    );
    return {
      renderer,
      video,
      visibleArea: visibleWidth * visibleHeight,
      centerDistance: Math.abs((rect.top + rect.bottom) / 2 - window.innerHeight / 2),
    };
  }).filter((candidate) => candidate.video && candidate.visibleArea > 0);

  candidates.sort((a, b) => {
    const aPlaying = !a.video.paused && !a.video.ended ? 1 : 0;
    const bPlaying = !b.video.paused && !b.video.ended ? 1 : 0;
    if (aPlaying !== bPlaying) return bPlaying - aPlaying;
    if (a.visibleArea !== b.visibleArea) return b.visibleArea - a.visibleArea;
    if (a.centerDistance !== b.centerDistance) return a.centerDistance - b.centerDistance;
    return Number(b.renderer.hasAttribute('is-active')) -
      Number(a.renderer.hasAttribute('is-active'));
  });

  return candidates[0]?.renderer || null;
}

function getActiveVideo() {
  const activeReelVideo = getActiveReelRenderer()?.querySelector(
    'video.html5-main-video, video'
  );
  if (activeReelVideo) return activeReelVideo;

  const videos = Array.from(document.querySelectorAll('video.html5-main-video, video'));
  if (!videos.length) return null;

  const visibleVideos = videos.filter((video) => {
    const rect = video.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
      rect.bottom > 0 && rect.right > 0 &&
      rect.top < window.innerHeight && rect.left < window.innerWidth;
  });

  return visibleVideos.find((video) => !video.paused && !video.ended) ||
    visibleVideos.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return (bRect.width * bRect.height) - (aRect.width * aRect.height);
    })[0] || videos[0];
}

function getActivePlayer() {
  const activeReelPlayer = getActiveReelRenderer()?.querySelector('.html5-video-player');
  if (activeReelPlayer) return activeReelPlayer;

  const video = getActiveVideo();
  return video?.closest('.html5-video-player') ||
    document.getElementById('movie_player') ||
    document.querySelector('.html5-video-player');
}

function ensureBar() {
  if (!isYouTubeVideoPage()) return null;
  if (bar && document.body.contains(bar)) return bar;

  bar = document.createElement('div');
  bar.id = 'ytfa-bar';
  bar.dir = 'rtl';

  faEl = document.createElement('div');
  faEl.className = 'ytfa-fa';
  origEl = document.createElement('div');
  origEl.className = 'ytfa-orig';
  origEl.dir = 'ltr';

  bar.appendChild(faEl);
  bar.appendChild(origEl);

  attachBar();
  applyStyles();
  return bar;
}
function attachBar() {
  if (!isYouTubeVideoPage() || !bar) return;
  const player = getActivePlayer();
  const host = player || document.body;
  if (bar.parentElement !== host) {
    bar.parentElement?.classList.remove('ytfa-on');
    host.appendChild(bar);
  }
  if (player) player.classList.toggle('ytfa-on', !!settings.enabled);
  ensureToggleBtn();
}

let controlsWrap = null;
let toggleBtn = null;
let progressBadge = null;
let modelSelectBtn = null;
let modelDropdownEl = null;
let dlEnBtn = null;
let dlFaBtn = null;
let ensureToggleBtnFrame = null;

function getActiveShortsActionBar() {
  const activeReel = document.querySelector('ytd-reel-video-renderer[is-active]') ||
                     Array.from(document.querySelectorAll('ytd-reel-video-renderer')).find(r => {
                       const rect = r.getBoundingClientRect();
                       return rect.top >= -100 && rect.top < window.innerHeight / 2 && rect.height > 0;
                     });

  if (activeReel) {
    const actionBar = activeReel.querySelector('reel-action-bar-view-model, .ytwReelActionBarViewModelHost, #button-bar, #actions-inner, #actions');
    const likeBtn = activeReel.querySelector('like-button-view-model, .ytLikeButtonViewModelHost, ytd-like-button-entity, #like-button');
    if (actionBar) return { actionBar, likeBtn };
  }

  const visibleBar = document.querySelector('reel-action-bar-view-model, .ytwReelActionBarViewModelHost');
  if (visibleBar) {
    const likeBtn = visibleBar.querySelector('like-button-view-model, .ytLikeButtonViewModelHost') ||
                    document.querySelector('like-button-view-model, .ytLikeButtonViewModelHost');
    return { actionBar: visibleBar, likeBtn };
  }

  const likeBtn = document.querySelector('like-button-view-model, .ytLikeButtonViewModelHost, ytd-like-button-entity, #like-button');
  if (likeBtn) {
    const actionBar = likeBtn.closest('reel-action-bar-view-model, .ytwReelActionBarViewModelHost, #button-bar, #actions-inner, #actions') || likeBtn.parentElement;
    return { actionBar, likeBtn };
  }

  return { actionBar: null, likeBtn: null };
}

function getToggleBtnHost() {
  if (window.location.pathname.startsWith('/shorts/')) {
    const { actionBar } = getActiveShortsActionBar();
    if (actionBar) return actionBar;
  }

  const player = getActivePlayer();
  if (!player) return null;
  return player.querySelector('.ytp-right-controls') ||
    player.querySelector('.ytp-chrome-controls');
}

function formatSecondsToSRT(sec) {
  if (isNaN(sec) || sec < 0) sec = 0;
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = Math.floor(sec % 60);
  const millis = Math.floor((sec % 1) * 1000);

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const mmm = String(millis).padStart(3, '0');

  return `${hh}:${mm}:${ss},${mmm}`;
}

function exportCuesToSRT(cues, lang = 'fa') {
  let srt = '';
  let index = 1;
  for (const cue of cues) {
    const rawText = (lang === 'fa' ? (cue.fa && cue.fa.trim() !== '…' ? cue.fa : '') : cue.text) || '';
    if (!rawText.trim()) continue;

    const cleanText = rawText.replace(/<[^>]*>/g, '').replace(/\*\*(.*?)\*\*/g, '$1').trim();
    const startTime = formatSecondsToSRT(cue.start);
    const endTime = formatSecondsToSRT(cue.end);

    srt += `${index}\n${startTime} --> ${endTime}\n${cleanText}\n\n`;
    index++;
  }
  return srt;
}

function downloadSubtitles(lang = 'fa') {
  if (!state.cues || !state.cues.length) {
    notify('هیچ زیرنویسی برای دانلود موجود نیست.');
    return;
  }

  const srtContent = exportCuesToSRT(state.cues, lang);
  if (!srtContent.trim()) {
    notify(`زیرنویس ${lang === 'fa' ? 'فارسی' : 'انگلیسی'} هنوز بارگذاری یا ترجمه نشده است.`);
    return;
  }

  const titleRaw = state.videoMeta?.title || document.title.replace('- YouTube', '').trim() || 'YouTube_Subtitle';
  const cleanTitle = titleRaw.replace(/[\\/:*?"<>|]/g, '_');
  const filename = `${cleanTitle}_${lang.toUpperCase()}.srt`;

  const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 300);

  notify(`زیرنویس ${lang === 'fa' ? 'فارسی' : 'انگلیسی'} با موفقیت دانلود شد: ${filename}`);
}

function applyCachedModel(modelIndex) {
  if (!state.cachedModels || !state.cachedModels[modelIndex]) return;
  state.activeModelIndex = modelIndex;
  const model = state.cachedModels[modelIndex];
  const translationVideoId = state.videoId || currentVideoId;

  if (Array.isArray(model.cues)) {
    model.cues.forEach((cc, idx) => {
      const cue = state.cues[idx] || state.cues.find(c => c.text === cc.text);
      if (cue && cc.fa) {
        cue.fa = cc.fa;
        cue.phrases = Array.isArray(cc.phrases) ? cc.phrases : [];
        cacheCaption(translationVideoId, cue.text, cue.fa, cue.phrases);
      }
    });
  }

  state.loadedFromCloudCache = true;
  updateProgressAndDownload();
  updateModelSelectBtn();

  if (state.currentIndex >= 0 && state.cues[state.currentIndex]) {
    showCue(state.cues[state.currentIndex]);
  }

  notify(`نسخه ترجمه تغییر یافت: ${model.modelName}`);
}

function updateModelSelectBtn() {
  if (!modelSelectBtn) return;

  if (state.loadedFromCloudCache && state.cachedModels && state.cachedModels.length > 0) {
    const curModel = state.cachedModels[state.activeModelIndex] || state.cachedModels[0];
    const isGoogle = curModel?.provider === 'google_free';
    const icon = isGoogle ? '🌐' : '⚡';
    const shortName = (curModel?.modelName || 'ابری').replace(/^OpenRouter\s*\(|\)$|^Gemini\s*\(|^DeepSeek\s*\(|^OpenAI\s*\(/g, '').trim();

    modelSelectBtn.innerHTML = `
      <span class="ytfa-model-icon">${icon}</span>
      <span class="ytfa-model-name">${escapeHtml(shortName)}</span>
      <span class="ytfa-model-arrow">▾</span>
    `;
    modelSelectBtn.title = `نسخه ترجمه فعال: ${curModel?.modelName || 'ابری'} (کلیک برای انتخاب مدل)`;
    modelSelectBtn.style.display = 'inline-flex';
  } else {
    modelSelectBtn.style.display = 'none';
    closeModelDropdown();
  }
}

function closeModelDropdown() {
  if (modelDropdownEl) {
    modelDropdownEl.remove();
    modelDropdownEl = null;
    document.removeEventListener('click', onDocClickCloseDropdown);
  }
}

function onDocClickCloseDropdown(e) {
  if (modelDropdownEl && !modelDropdownEl.contains(e.target) && e.target !== modelSelectBtn) {
    closeModelDropdown();
  }
}

function toggleModelDropdown(e) {
  e.stopPropagation();
  if (modelDropdownEl) {
    closeModelDropdown();
    return;
  }

  if (!state.cachedModels || state.cachedModels.length === 0) return;

  const player = getActivePlayer() || document.body;
  modelDropdownEl = document.createElement('div');
  modelDropdownEl.id = 'ytfa-model-dropdown';

  let modelsHtml = state.cachedModels.map((m, idx) => {
    const isActive = idx === state.activeModelIndex;
    const isGoogle = m.provider === 'google_free';
    return `
      <button type="button" class="ytfa-model-item ${isActive ? 'active' : ''}" data-index="${idx}">
        <span class="ytfa-model-item-icon">${isGoogle ? '🌐' : '⚡'}</span>
        <div class="ytfa-model-item-info">
          <div class="ytfa-model-item-title">${escapeHtml(m.modelName)}</div>
          <div class="ytfa-model-item-sub">${isGoogle ? 'مترجم گوگل' : 'هوش مصنوعی'}</div>
        </div>
        ${isActive ? '<span class="ytfa-model-check">✓</span>' : ''}
      </button>
    `;
  }).join('');

  modelDropdownEl.innerHTML = `
    <div class="ytfa-dropdown-header">
      <span>نسخه‌های ترجمه ابری</span>
      <span class="ytfa-dropdown-badge">${state.cachedModels.length} نسخه</span>
    </div>
    <div class="ytfa-dropdown-list">
      ${modelsHtml}
    </div>
    <div class="ytfa-dropdown-divider"></div>
    <button type="button" class="ytfa-model-retrans-action" title="ترجمه مجدد بر اساس پرووایدر و مدل فعال در تنظیمات افزونه">
      <span class="ytfa-model-item-icon">🔄</span>
      <div class="ytfa-model-item-info">
        <div class="ytfa-model-item-title">ترجمه زنده با تنظیمات شما…</div>
        <div class="ytfa-model-item-sub">نادیده گرفتن کش و ترجمه با پرووایدر انتخابی</div>
      </div>
    </button>
  `;

  modelDropdownEl.querySelectorAll('.ytfa-model-item').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const idx = parseInt(btn.dataset.index, 10);
      closeModelDropdown();
      applyCachedModel(idx);
    });
  });

  modelDropdownEl.querySelector('.ytfa-model-retrans-action').addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeModelDropdown();
    console.log('[ytfa] User opted for live translation with active settings. Stopping old and starting fresh...');
    stopTranslation();
    state.bypassCloudCache = true;
    state.loadedFromCloudCache = false;
    state.uploadedToCloud = false;
    state.cachedModels = [];
    state.activeModelIndex = -1;
    updateModelSelectBtn();
    state.cues.forEach((c) => {
      c.fa = '';
      c.phrases = [];
    });
    captionCache.clear();
    updateProgressAndDownload();
    if (state.currentIndex >= 0 && state.cues[state.currentIndex]) {
      showCue(state.cues[state.currentIndex]);
    }
    notify('در حال شروع ترجمه زنده با تنظیمات شما…');
    translateAll({ bypassCloudCache: true });
  });

  modelDropdownEl.addEventListener('click', (ev) => ev.stopPropagation());

  player.appendChild(modelDropdownEl);

  const btnRect = modelSelectBtn.getBoundingClientRect();
  const playerRect = player.getBoundingClientRect();

  let bottom = playerRect.bottom - btnRect.top + 8;
  let right = playerRect.right - btnRect.right;

  modelDropdownEl.style.bottom = `${bottom}px`;
  modelDropdownEl.style.right = `${Math.max(12, right)}px`;

  setTimeout(() => document.addEventListener('click', onDocClickCloseDropdown), 50);
}

function updateProgressAndDownload() {
  if (!progressBadge || !dlEnBtn || !dlFaBtn) return;

  const totalCues = state.cues.length;
  if (!totalCues) {
    progressBadge.style.display = 'none';
    dlEnBtn.style.display = 'none';
    dlFaBtn.style.display = 'none';
    if (modelSelectBtn) modelSelectBtn.style.display = 'none';
    return;
  }

  const translatedCount = state.cues.filter(
    (c) => c.fa && c.fa.trim() !== '' && c.fa.trim() !== '…'
  ).length;

  const pct = Math.round((translatedCount / totalCues) * 100);

  progressBadge.textContent = `${pct}%`;
  progressBadge.dataset.tooltip = `درصد تکمیل زیرنویس: ${pct}% (${translatedCount} از ${totalCues} جمله)`;
  progressBadge.classList.toggle('completed', pct === 100);
  progressBadge.style.display = 'inline-flex';

  dlEnBtn.style.display = 'inline-flex';

  if (translatedCount > 0) {
    dlFaBtn.style.display = 'inline-flex';
    dlFaBtn.classList.toggle('completed', pct === 100);
    dlFaBtn.dataset.tooltip = pct === 100
      ? 'دانلود زیرنویس کامل فارسی (SRT)'
      : `دانلود زیرنویس فارسی (SRT) — ${pct}% کامل شده`;
  } else {
    dlFaBtn.style.display = 'none';
  }

  updateModelSelectBtn();
}

function ensureToggleBtn() {
  if (!settings.enabled || !isYouTubeVideoPage()) {
    if (controlsWrap) controlsWrap.style.display = 'none';
    return;
  }

  const isShorts = window.location.pathname.startsWith('/shorts/');
  let controls = null;
  let shortsLikeBtn = null;

  if (isShorts) {
    const res = getActiveShortsActionBar();
    controls = res.actionBar;
    shortsLikeBtn = res.likeBtn;
  } else {
    controls = getToggleBtnHost();
  }

  if (!controls) {
    if (controlsWrap) controlsWrap.style.display = 'none';
    return;
  }

  if (!controlsWrap) {
    controlsWrap = document.createElement('div');
    controlsWrap.id = 'ytfa-controls-wrap';

    toggleBtn = document.createElement('button');
    toggleBtn.id = 'ytfa-toggle-btn';
    toggleBtn.className = 'ytp-button';
    toggleBtn.type = 'button';
    const icon = document.createElement('span');
    icon.className = 'ytfa-btn-icon';
    toggleBtn.appendChild(icon);
    toggleBtn.addEventListener('click', onToggleBtnClick);
    controlsWrap.appendChild(toggleBtn);

    progressBadge = document.createElement('div');
    progressBadge.id = 'ytfa-progress-badge';
    progressBadge.style.display = 'none';
    controlsWrap.appendChild(progressBadge);

    modelSelectBtn = document.createElement('button');
    modelSelectBtn.id = 'ytfa-model-select-btn';
    modelSelectBtn.className = 'ytfa-dl-btn ytfa-model-btn';
    modelSelectBtn.type = 'button';
    modelSelectBtn.style.display = 'none';
    modelSelectBtn.addEventListener('click', toggleModelDropdown);
    controlsWrap.appendChild(modelSelectBtn);

    dlEnBtn = document.createElement('button');
    dlEnBtn.id = 'ytfa-dl-en-btn';
    dlEnBtn.className = 'ytfa-dl-btn ytfa-dl-en';
    dlEnBtn.type = 'button';
    dlEnBtn.innerHTML = '<span>EN</span> 📥';
    dlEnBtn.dataset.tooltip = 'دانلود زیرنویس انگلیسی (SRT)';
    dlEnBtn.style.display = 'none';
    dlEnBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadSubtitles('en');
    });
    controlsWrap.appendChild(dlEnBtn);

    dlFaBtn = document.createElement('button');
    dlFaBtn.id = 'ytfa-dl-fa-btn';
    dlFaBtn.className = 'ytfa-dl-btn ytfa-dl-fa';
    dlFaBtn.type = 'button';
    dlFaBtn.innerHTML = '<span>FA</span> 📥';
    dlFaBtn.dataset.tooltip = 'دانلود زیرنویس فارسی (SRT)';
    dlFaBtn.style.display = 'none';
    dlFaBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadSubtitles('fa');
    });
    controlsWrap.appendChild(dlFaBtn);
  }

  toggleBtn.classList.toggle('ytfa-shorts-btn', isShorts);
  controlsWrap.classList.toggle('ytfa-shorts-wrap', isShorts);

  if (isShorts) {
    toggleBtn.classList.add('ytwReelActionBarViewModelHostDesktopActionButton');

    if (shortsLikeBtn) {
      let targetNode = shortsLikeBtn;
      while (targetNode && targetNode.parentElement !== controls) {
        targetNode = targetNode.parentElement;
      }
      if (targetNode && targetNode.parentElement === controls) {
        if (controlsWrap.nextSibling !== targetNode) {
          controls.insertBefore(controlsWrap, targetNode);
        }
      } else {
        if (controlsWrap.parentElement !== controls || controls.firstChild !== controlsWrap) {
          controls.prepend(controlsWrap);
        }
      }
    } else {
      if (controlsWrap.parentElement !== controls || controls.firstChild !== controlsWrap) {
        controls.prepend(controlsWrap);
      }
    }
  } else {
    toggleBtn.classList.remove('ytwReelActionBarViewModelHostDesktopActionButton');
    if (controlsWrap.parentElement !== controls) {
      controls.prepend(controlsWrap);
    }
  }

  controlsWrap.style.display = 'inline-flex';
}

function scheduleEnsureToggleBtn() {
  if (ensureToggleBtnFrame !== null) return;
  ensureToggleBtnFrame = requestAnimationFrame(() => {
    ensureToggleBtnFrame = null;
    ensureToggleBtn();
  });
}

const playerControlsObserver = new MutationObserver(() => {
  if (!settings.enabled || !isYouTubeVideoPage()) return;
  scheduleEnsureToggleBtn();
});

playerControlsObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['is-active', 'class']
});

function updateToggleBtn() {
  if (!isYouTubeVideoPage()) {
    if (controlsWrap) controlsWrap.style.display = 'none';
    return;
  }
  if (!toggleBtn) {
    ensureToggleBtn();
    if (!toggleBtn) return;
  }

  const icon = toggleBtn.querySelector('.ytfa-btn-icon');

  toggleBtn.classList.remove(
    'ytfa-btn-active', 'ytfa-btn-hidden',
    'ytfa-btn-error', 'ytfa-btn-loading'
  );

  if (state.loading) {
    toggleBtn.classList.add('ytfa-btn-loading');
    icon.textContent = '⟳';
    toggleBtn.dataset.tooltip = 'در حال دریافت زیرنویس…';
  } else if (bootFailed) {
    toggleBtn.classList.add('ytfa-btn-error');
    icon.textContent = '↺';
    toggleBtn.dataset.tooltip = 'خطا — کلیک برای تلاش مجدد';
  } else if (!state.cues.length) {
    toggleBtn.classList.add('ytfa-btn-error');
    icon.textContent = '↺';
    toggleBtn.dataset.tooltip = 'کلیک برای بارگذاری زیرنویس';
  } else if (!subtitleVisible) {
    toggleBtn.classList.add('ytfa-btn-hidden');
    icon.textContent = '🚫';
    toggleBtn.dataset.tooltip = 'زیرنویس پنهان — کلیک برای نمایش';
  } else {
    toggleBtn.classList.add('ytfa-btn-active');
    icon.textContent = '👁';
    toggleBtn.dataset.tooltip = 'زیرنویس فعال — کلیک برای پنهان کردن';
  }

  updateProgressAndDownload();
}

async function reloadSubtitles() {
  bootFailed = false;
  subtitleVisible = true;
  state.videoId = null;
  state.cues = [];
  state.currentIndex = -1;
  state.activeVideo = null;
  updateToggleBtn();
  await boot({ silent: false });
}

async function onToggleBtnClick() {
  if (state.loading) return;

  if (bootFailed || !state.cues.length) {
    await reloadSubtitles();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await reloadSubtitles();
    return;
  }

  subtitleVisible = !subtitleVisible;
  if (subtitleVisible) {
    const video = getVideo();
    if (video) {
      const idx = findCue(video.currentTime);
      if (idx !== -1) showCue(state.cues[idx]);
    }
  } else if (bar) {
    bar.classList.remove('ytfa-visible');
  }
  updateToggleBtn();
}

function applyStyles() {
  if (!bar) return;
  const s = settings;
  const rgba = hexToRgba(s.bgColor, s.bgOpacity);
  bar.style.setProperty('--ytfa-bottom', `${s.bottomOffset}%`);
  bar.style.setProperty('--ytfa-bg', rgba);

  faEl.style.fontSize = `${s.faFontSize}px`;
  faEl.style.color = s.faColor;
  faEl.style.fontFamily = s.faFontFamily;
  faEl.style.fontWeight = s.faBold ? '700' : '400';

  origEl.style.fontSize = `${s.origFontSize}px`;
  origEl.style.color = s.origColor;
  origEl.style.display = s.showOriginal ? 'block' : 'none';

  faEl.style.display = s.showPersian ? 'block' : 'none';

  if (s.activeRecall) {
    faEl.classList.add('ytfa-active-recall');
  } else {
    faEl.classList.remove('ytfa-active-recall', 'ytfa-manual-reveal');
  }

  if (s.origFirst) {
    if (bar.firstChild !== origEl) bar.insertBefore(origEl, faEl);
  } else {
    if (bar.firstChild !== faEl) bar.insertBefore(faEl, origEl);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showCue(cue) {
  if (!isYouTubeVideoPage()) return;
  if (!ensureBar()) return;
  attachBar();

  const faRaw = cue.fa || '…';
  const formattedHtml = escapeHtml(faRaw).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  if (faEl.innerHTML !== formattedHtml) {
    faEl.classList.remove('ytfa-manual-reveal');
    faEl.innerHTML = formattedHtml;
  }

  renderClickableOriginalText(cue.text || '', cue.phrases);
  if (subtitleVisible) bar.classList.add('ytfa-visible');
}

function hideBar() {
  if (bar) bar.classList.remove('ytfa-visible');
  state.currentIndex = -1;
}

function hexToRgba(hex, alpha) {
  const m = hex.replace('#', '');
  const v =
    m.length === 3
      ? m.split('').map((c) => c + c).join('')
      : m.padEnd(6, '0').slice(0, 6);
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* --------------------------- caption fetching ------------------------ */

function requestCaptions() {
  return new Promise((resolve) => {
    const reqId = `r${Date.now()}_${Math.floor(performance.now())}`;
    const onMsg = (event) => {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.channel !== RES || d.reqId !== reqId) return;
      window.removeEventListener('message', onMsg);
      resolve(d);
    };
    window.addEventListener('message', onMsg);
    window.postMessage({ channel: REQ, type: 'GET_CAPTIONS', reqId }, '*');
    setTimeout(() => {
      window.removeEventListener('message', onMsg);
      resolve({ videoId: null, url: null, tracks: [] });
    }, 8000);
  });
}

async function fetchCues(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`captions ${res.status}`);
  const data = await res.json();
  const events = data.events || [];
  const cues = [];
  for (const ev of events) {
    if (!ev.segs) continue;
    const text = ev.segs
      .map((s) => s.utf8)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const start = (ev.tStartMs || 0) / 1000;
    const dur = (ev.dDurationMs || 0) / 1000;
    cues.push({ start, end: start + (dur || 4), text, fa: '', phrases: [] });
  }

  cues.sort((a, b) => a.start - b.start);
  return segmentCuesIntelligently(cues);
}

/* ───────────── Smart Subtitle Segmentation Engine ─────────────────────── */
/*
 * YouTube's auto-generated captions (ASR) produce wildly uneven segments:
 * some events contain a single word, others contain 30+ words.
 * This engine normalizes raw cues into natural, readable sentence-level
 * chunks (similar to Language Reactor's approach), ensuring:
 *   - Each displayed segment is 3–15 words (readable at a glance)
 *   - Display duration is 1.8–8 seconds
 *   - Splits happen at natural punctuation boundaries
 *   - No single-word flashes or giant text walls
 */

const SEG_CONFIG = {
  // Merge thresholds
  MERGE_MIN_WORDS: 3,           // Cues with fewer words are merge candidates
  MERGE_MAX_GAP_SEC: 1.5,       // Max time gap to allow merging adjacent cues
  MERGE_MAX_WORDS: 15,          // Don't merge beyond this word count
  MERGE_MAX_CHARS: 120,         // Don't merge beyond this character count
  MERGE_SHORT_DUR_SEC: 1.5,     // Cues shorter than this are considered "tiny"

  // Split thresholds
  SPLIT_MIN_WORDS: 15,          // Cues with more words are split candidates
  SPLIT_MIN_CHARS: 120,         // Cues with more chars are split candidates
  SPLIT_PART_MIN_WORDS: 3,      // Each split part must have at least this many words

  // Timing constraints
  MIN_DURATION_SEC: 1.8,        // Minimum display time per cue
  MAX_DURATION_SEC: 8.0,        // Maximum display time per cue
};

/**
 * Count whitespace-separated words in a string.
 */
function wordCount(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).length;
}

/**
 * Phase 1: Merge tiny fragments into larger, readable cues.
 *
 * Scans cues linearly. A cue is considered "tiny" if it has fewer than
 * MERGE_MIN_WORDS words AND its duration is shorter than MERGE_SHORT_DUR_SEC.
 * Tiny cues are accumulated into a buffer and flushed when the buffer
 * reaches a natural size or when a gap in timing is detected.
 */
function mergeTinyFragments(cues) {
  if (!cues.length) return [];

  const {
    MERGE_MIN_WORDS, MERGE_MAX_GAP_SEC,
    MERGE_MAX_WORDS, MERGE_MAX_CHARS, MERGE_SHORT_DUR_SEC
  } = SEG_CONFIG;

  const merged = [];
  let buf = null; // { start, end, text }

  function flush() {
    if (!buf) return;
    merged.push({ start: buf.start, end: buf.end, text: buf.text.trim(), fa: '', phrases: [] });
    buf = null;
  }

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const wc = wordCount(cue.text);
    const dur = cue.end - cue.start;
    const isTiny = wc < MERGE_MIN_WORDS && dur < MERGE_SHORT_DUR_SEC;

    if (!buf) {
      // Start a new buffer with this cue
      buf = { start: cue.start, end: cue.end, text: cue.text };

      // If this cue is already large enough on its own, flush immediately
      if (!isTiny) flush();
      continue;
    }

    // Check if we can merge this cue into the buffer
    const gap = cue.start - buf.end;
    const combinedText = buf.text + ' ' + cue.text;
    const combinedWords = wordCount(combinedText);
    const combinedChars = combinedText.length;

    const canMerge =
      gap <= MERGE_MAX_GAP_SEC &&
      combinedWords <= MERGE_MAX_WORDS &&
      combinedChars <= MERGE_MAX_CHARS;

    if (isTiny && canMerge) {
      // Merge tiny cue into buffer
      buf.text = combinedText;
      buf.end = cue.end;
    } else if (!isTiny && canMerge && wordCount(buf.text) < MERGE_MIN_WORDS) {
      // Buffer itself is tiny — absorb this normal cue into it and flush
      buf.text = combinedText;
      buf.end = cue.end;
      flush();
    } else {
      // Can't merge — flush buffer first, then start fresh
      flush();
      buf = { start: cue.start, end: cue.end, text: cue.text };
      if (!isTiny) flush();
    }
  }

  flush();
  return merged;
}

/**
 * Phase 2: Split oversized cues at natural punctuation boundaries.
 *
 * If a cue exceeds SPLIT_MIN_WORDS or SPLIT_MIN_CHARS, we attempt to
 * split it at punctuation marks (prioritized: sentence-ending → clause → comma).
 * Each resulting part must have at least SPLIT_PART_MIN_WORDS words.
 * Timing is distributed proportionally by character count.
 */
function splitOversizedCues(cues) {
  if (!cues.length) return [];

  const { SPLIT_MIN_WORDS, SPLIT_MIN_CHARS, SPLIT_PART_MIN_WORDS } = SEG_CONFIG;
  const result = [];

  for (const cue of cues) {
    const wc = wordCount(cue.text);
    const cc = cue.text.length;

    if (wc <= SPLIT_MIN_WORDS && cc <= SPLIT_MIN_CHARS) {
      result.push(cue);
      continue;
    }

    // Find best split points using punctuation priority tiers
    const parts = findBestSplit(cue.text, SPLIT_PART_MIN_WORDS, SPLIT_MIN_WORDS);

    if (parts.length <= 1) {
      // No valid split found — keep as-is
      result.push(cue);
      continue;
    }

    // Distribute timing proportionally by character count
    const totalChars = parts.reduce((sum, p) => sum + p.length, 0);
    const totalDur = cue.end - cue.start;
    let elapsed = cue.start;

    for (let i = 0; i < parts.length; i++) {
      const partDur = totalDur * (parts[i].length / totalChars);
      const partStart = elapsed;
      const partEnd = i === parts.length - 1 ? cue.end : elapsed + partDur;
      result.push({
        start: partStart,
        end: partEnd,
        text: parts[i].trim(),
        fa: '',
        phrases: [],
      });
      elapsed = partEnd;
    }
  }

  return result;
}

/**
 * Find the best way to split text at punctuation boundaries.
 * Tries sentence-ending punctuation first, then clause separators, then commas.
 * Returns an array of text parts, or [text] if no valid split is possible.
 */
function findBestSplit(text, minWordsPerPart, targetMaxWords) {
  // Priority tiers of split-point patterns (regex matches the punctuation + trailing space)
  const tiers = [
    /[.!?]+\s+/g,           // Sentence-ending punctuation
    /[;—–]+\s+/g,           // Clause separators (semicolon, em-dash, en-dash)
    /,\s+/g,                // Commas
    /:\s+/g,                // Colons
  ];

  for (const pattern of tiers) {
    const parts = trySplitAt(text, pattern, minWordsPerPart, targetMaxWords);
    if (parts && parts.length > 1) return parts;
  }

  return [text];
}

/**
 * Attempt to split text using a specific punctuation regex pattern.
 * Returns valid parts array or null if split doesn't meet constraints.
 */
function trySplitAt(text, pattern, minWordsPerPart, targetMaxWords) {
  // Find all split positions
  const positions = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    // Split position is AFTER the punctuation+space
    positions.push(match.index + match[0].length);
  }

  if (!positions.length) return null;

  // Try splitting at each position and pick the most balanced split
  let bestParts = null;
  let bestScore = Infinity;

  // Try single-point splits first (into 2 parts)
  for (const pos of positions) {
    const left = text.slice(0, pos).trim();
    const right = text.slice(pos).trim();

    if (!left || !right) continue;

    const leftWc = wordCount(left);
    const rightWc = wordCount(right);

    if (leftWc < minWordsPerPart || rightWc < minWordsPerPart) continue;

    // Score: how balanced are the parts? Lower is better.
    const score = Math.abs(leftWc - rightWc);

    // Also check if both parts are under targetMaxWords
    const bothUnderTarget = leftWc <= targetMaxWords && rightWc <= targetMaxWords;

    if (bothUnderTarget && score < bestScore) {
      bestScore = score;
      bestParts = [left, right];
    }
  }

  // If a 2-way split didn't bring parts under target, try 3-way
  if (!bestParts && positions.length >= 2) {
    for (let i = 0; i < positions.length - 1; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const p1 = text.slice(0, positions[i]).trim();
        const p2 = text.slice(positions[i], positions[j]).trim();
        const p3 = text.slice(positions[j]).trim();

        if (!p1 || !p2 || !p3) continue;

        const wc1 = wordCount(p1);
        const wc2 = wordCount(p2);
        const wc3 = wordCount(p3);

        if (wc1 < minWordsPerPart || wc2 < minWordsPerPart || wc3 < minWordsPerPart) continue;

        const maxWc = Math.max(wc1, wc2, wc3);
        const minWc = Math.min(wc1, wc2, wc3);
        const score = maxWc - minWc;

        if (score < bestScore) {
          bestScore = score;
          bestParts = [p1, p2, p3];
        }
      }
    }
  }

  return bestParts;
}

/**
 * Phase 3: Enforce minimum and maximum display duration constraints.
 *
 * - If a cue is too short (< MIN_DURATION_SEC), extend its `end` time
 *   without overlapping the next cue.
 * - If a cue is too long (> MAX_DURATION_SEC), trim its `end` time.
 */
function enforceTimingConstraints(cues) {
  if (!cues.length) return [];

  const { MIN_DURATION_SEC, MAX_DURATION_SEC } = SEG_CONFIG;
  const result = [];

  for (let i = 0; i < cues.length; i++) {
    const cue = { ...cues[i] };
    let dur = cue.end - cue.start;

    // Extend short cues
    if (dur < MIN_DURATION_SEC) {
      const desiredEnd = cue.start + MIN_DURATION_SEC;
      // Don't overlap with the next cue
      const nextStart = (i + 1 < cues.length) ? cues[i + 1].start : Infinity;
      cue.end = Math.min(desiredEnd, nextStart);
    }

    // Trim overly long cues
    dur = cue.end - cue.start;
    if (dur > MAX_DURATION_SEC) {
      cue.end = cue.start + MAX_DURATION_SEC;
    }

    result.push(cue);
  }

  return result;
}

/**
 * Main orchestrator: takes raw YouTube cues and returns intelligently
 * segmented cues with natural sentence boundaries and proper timing.
 */
function segmentCuesIntelligently(rawCues) {
  if (!rawCues || !rawCues.length) return rawCues;

  // Phase 1: Merge tiny fragments into readable chunks
  const merged = mergeTinyFragments(rawCues);

  // Phase 2: Split oversized cues at punctuation boundaries
  const split = splitOversizedCues(merged);

  // Phase 3: Enforce min/max display duration
  const final = enforceTimingConstraints(split);

  console.log(
    `[ytfa] 📐 Segmentation: ${rawCues.length} raw cues → ` +
    `${merged.length} merged → ${split.length} split → ${final.length} final`
  );

  return final;
}

/* ───────────── End of Smart Subtitle Segmentation Engine ──────────────── */

function groupCuesByRPM(cues, rpm) {
  const multiplier = 3;
  const minDuration = (60 / rpm) * multiplier;
  const batches = [];
  let texts = [];
  let indices = [];
  let batchStartTime = null;

  const flushBatch = () => {
    if (!indices.length) return;
    batches.push({
      texts,
      indices,
      startIdx: indices[0],
      endIdx: indices[indices.length - 1],
    });
    texts = [];
    indices = [];
    batchStartTime = null;
  };

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (cue.fa !== '') continue;
    if (batchStartTime === null) batchStartTime = cue.start;

    texts.push(cue.text);
    indices.push(i);
    const duration = cue.end - batchStartTime;
    if (duration >= minDuration || texts.length >= 25) flushBatch();
  }

  flushBatch();
  return batches;
}

/* --------------------------- translation flow ------------------------ */

let activeBatches = []; 
let isTranslating = false;

function stopTranslation() {
  state.translationSessionId++;
  isTranslating = false;
}

async function translateAll({ bypassCloudCache = false } = {}) {
  if (!isExtensionValid()) {
    stopTranslation();
    return;
  }

  // اگر افزونه خاموش باشد، صفحه یوتیوب نباشد یا تب در پس‌زمینه (مخفی) باشد، ترجمه متوقف می‌شود
  if (!settings.enabled || !isYouTubeVideoPage() || document.hidden) {
    stopTranslation();
    return;
  }

  if (isTranslating) return;

  const currentSessionId = state.translationSessionId;
  const translationVideoId = state.videoId || currentVideoId;
  applyCachedCaptions(translationVideoId, state.cues);

  // Check Cloud Cache if not bypassed, not already loaded from cloud, and cues are untranslated
  if (!bypassCloudCache && !state.bypassCloudCache && !state.loadedFromCloudCache && state.cues.some(c => !c.fa)) {
    try {
      const cloudRes = await chrome.runtime.sendMessage({
        type: 'GET_CLOUD_CACHE',
        videoId: translationVideoId
      });
      if (cloudRes?.ok && cloudRes.data?.found) {
        console.log(`[ytfa] ⚡ Loaded subtitles from Cloud Cache for ${translationVideoId}`);
        if (Array.isArray(cloudRes.data.models) && cloudRes.data.models.length > 0) {
          state.cachedModels = cloudRes.data.models;
          const bestIdx = cloudRes.data.bestIndex != null ? cloudRes.data.bestIndex : 0;
          applyCachedModel(bestIdx);
          return;
        } else if (Array.isArray(cloudRes.data.cues) && cloudRes.data.cues.length > 0) {
          state.cachedModels = [{
            provider: 'unknown',
            modelId: 'legacy',
            modelName: 'ترجمه ابری',
            cues: cloudRes.data.cues
          }];
          applyCachedModel(0);
          return;
        }
      }
    } catch (cloudErr) {
      if (cloudErr?.message?.includes('Extension context invalidated') || !isExtensionValid()) {
        console.warn('[ytfa] Extension context invalidated on cloud cache check.');
        stopTranslation();
        notify('افزونه به‌روزرسانی شد. لطفاً برای ادامه، صفحه را تازه (رفرش) کنید 🔄');
        return;
      }
      console.warn('[ytfa] Cloud cache lookup error:', cloudErr);
    }
  }

  const rpm = settings.rpm || 15;
  activeBatches = groupCuesByRPM(state.cues, rpm);
  isTranslating = true;

  let notifiedError = false;

  while (isTranslating && currentSessionId === state.translationSessionId) {
    if (!isExtensionValid()) {
      stopTranslation();
      return;
    }

    // بررسی مجدد فعال بودن تب و تنظیمات در هر دور حلقه
    if (!settings.enabled || document.hidden) {
      stopTranslation();
      break;
    }

    const untranslated = activeBatches.filter(b => !isBatchTranslated(b));
    if (untranslated.length === 0) break;

    const video = getVideo();
    const currentTime = video ? video.currentTime : 0;

    // اولویت‌بندی ارسال درخواست بر اساس بازه زمانی فعلی ویدیو
    untranslated.sort((a, b) => {
      const startA = state.cues[a.startIdx].start;
      const endA = state.cues[a.endIdx].end;
      const startB = state.cues[b.startIdx].start;
      const endB = state.cues[b.endIdx].end;

      const isActiveA = (currentTime >= startA && currentTime <= endA);
      const isActiveB = (currentTime >= startB && currentTime <= endB);

      if (isActiveA && !isActiveB) return -1;
      if (!isActiveA && isActiveB) return 1;

      const distA = startA - currentTime;
      const distB = startB - currentTime;

      if (distA >= 0 && distB >= 0) return distA - distB; 
      if (distA < 0 && distB < 0) return distB - distA;   
      return distA >= 0 ? -1 : 1;
    });

    const batch = untranslated[0];
    const { texts, indices, startIdx, endIdx } = batch;

    const ERROR_MESSAGES = {
      ERR_429: 'به محدودیت تعداد درخواست هوش مصنوعی (ارور ۴۲۹) برخوردید. لطفاً چند لحظه صبر کنید یا محدودیت RPM را در تنظیمات کاهش دهید.',
      ERR_AUTH: 'کلید API معتبر نیست، منقضی شده یا دسترسی ندارد (ارور ۴۰۱/۴۰۳). لطفاً کلید ثبت‌شده در تنظیمات افزونه را بررسی کنید.',
      ERR_SERVER: 'سرور هوش مصنوعی موقتاً در دسترس نیست یا با ترافیک سنگین مواجه است (ارور ۵۰۳/۵۰۰). افزونه به طور خودکار مجدداً تلاش خواهد کرد.',
      ERR_400: 'درخواست نامعتبر است (ارور ۴۰۰). احتمالاً نام مدل انتخابی اشتباه است یا توسط این پرووایدر پشتیبانی نمی‌شود.',
      ERR_GEO: '🌍 دسترسی به هوش مصنوعی به دلیل تحریم یا لوکیشن مسدود شد (ارور ۴۰۰/۴۰۳). لطفاً VPN خود را روشن کرده یا لوکیشن سرور آن را تغییر دهید.',
      ERR_NETWORK: 'خطای شبکه یا قطعی اینترنت. لطفاً اتصال فیلترشکن (VPN) خود را بررسی کنید.',
    };

    let hasError = false;
    try {
      if (!settings.enabled || currentSessionId !== state.translationSessionId || document.hidden) {
        stopTranslation();
        break;
      }

      const resp = await chrome.runtime.sendMessage({ type: 'TRANSLATE', texts, videoMeta: state.videoMeta });

      if (!settings.enabled || currentSessionId !== state.translationSessionId || document.hidden) {
        stopTranslation();
        break;
      }

      if (resp?.ok) {
        if (currentSessionId === state.translationSessionId) {
          resp.translations.forEach((fa, j) => {
            const cueIdx = indices[j];
            const cue = state.cues[cueIdx];
            if (cue) {
              // برای جلوگیری از گیر کردن، اگر ترجمه خالی بود یک فاصله قرار می‌دهیم
              cue.fa = fa ? fa : ' ';
              cue.phrases = (resp.phrases && Array.isArray(resp.phrases[j])) ? resp.phrases[j] : [];
              cacheCaption(translationVideoId, cue.text, cue.fa, cue.phrases);
              if (!fa) console.warn(`[ytfa] Empty translation for cue ${cueIdx}`);
            }
          });
          if (state.currentIndex >= startIdx && state.currentIndex <= endIdx) {
            showCue(state.cues[state.currentIndex]);
          }
          updateProgressAndDownload();
        }
      } else if (resp?.error === 'APP_DISABLED' || resp?.error === 'TAB_INACTIVE') {
        // اگر افزونه خاموش باشد یا تب غیرفعال باشد، حلقه ترجمه فوراً متوقف می‌شود
        if (currentSessionId === state.translationSessionId) stopTranslation();
        return;
      } else if (resp?.error === 'NO_API_KEY') {
        if (currentSessionId === state.translationSessionId) {
          notify('برای ترجمه، کلید API مربوطه را در تنظیمات افزونه وارد کنید.');
          stopTranslation();
        }
        return;
      } else if (resp?.error === 'GOOGLE_CAPTCHA_OR_BLOCKED') {
        if (currentSessionId === state.translationSessionId) {
          notify('🚫 گوگل ترنسلیت به دلیل استفاده از VPN نامعتبر شما را مسدود کرده است. لطفاً سرور VPN خود را تغییر دهید و صفحه را رفرش کنید.');
          stopTranslation();
        }
        return;
      } else if (resp?.error === 'ERR_AUTH' || resp?.error === 'ERR_GEO') {
        if (currentSessionId === state.translationSessionId) {
          notify(ERROR_MESSAGES[resp.error]);
          stopTranslation();
        }
        return;
      } else if (resp?.error === 'ERR_429' || resp?.error === 'ERR_SERVER' || resp?.error === 'ERR_NETWORK') {
        hasError = true;
        console.warn('[ytfa] transient error:', resp.error);
        if (!notifiedError && currentSessionId === state.translationSessionId) {
          notify(ERROR_MESSAGES[resp.error]);
          notifiedError = true;
        }
      } else if (resp?.error) {
        hasError = true;
        console.warn('[ytfa] translate error:', resp.error);
        if (!notifiedError && currentSessionId === state.translationSessionId) {
          const msg = ERROR_MESSAGES[resp.error] || ('خطای ترجمه: ' + resp.error);
          notify(msg);
          notifiedError = true;
        }
      }
    } catch (e) {
      if (e?.message?.includes('Extension context invalidated') || !isExtensionValid()) {
        console.warn('[ytfa] Extension was reloaded or updated. Stopping translation loop.');
        stopTranslation();
        notify('افزونه به‌روزرسانی شد. لطفاً برای ادامه، صفحه را تازه (رفرش) کنید 🔄');
        return;
      }
      hasError = true;
      console.warn('[ytfa] translate failed:', e);
    }

    if (hasError) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      if (!settings.enabled || currentSessionId !== state.translationSessionId || document.hidden) break;
    }
  }

  if (currentSessionId === state.translationSessionId) {
    isTranslating = false;

    // Upload 100% translated subtitles to Cloud Cache (if enabled & not from cloud)
    const allTranslated = state.cues.length > 0 && state.cues.every(c => c.fa && c.fa.trim().length > 0);
    if (allTranslated && !state.uploadedToCloud && !state.loadedFromCloudCache && isExtensionValid()) {
      state.uploadedToCloud = true;
      chrome.runtime.sendMessage({
        type: 'SAVE_CLOUD_CACHE',
        videoId: translationVideoId,
        cues: state.cues,
        title: state.videoMeta?.title || document.title
      }).then(res => {
        if (res?.ok) console.log(`[ytfa] ☁️ Subtitles successfully shared to Cloud Cache!`);
      }).catch(err => {
        console.warn('[ytfa] Subtitle cloud upload error:', err);
      });
    }
  }
}

function isBatchTranslated(batch) {
  return batch.indices.every((index) => state.cues[index]?.fa !== '');
}

/* --------------------------- playback sync --------------------------- */

function getVideo() {
  return getActiveVideo();
}

function syncLoop() {
  state.rafId = requestAnimationFrame(syncLoop);
  if (!settings.enabled) return;

  if (isYouTubeVideoPage()) scheduleEnsureToggleBtn();

  const urlVideoId = getVideoIdFromUrl();
  if (urlVideoId !== currentVideoId) {
    onNavigate();
    return;
  }
  if (!isYouTubeVideoPage() || !state.cues.length) return;

  const video = getVideo();
  if (!video) {
    hideBar();
    return;
  }
  if (state.activeVideo && video !== state.activeVideo) {
    hideBar();
    return;
  }
  const t = video.currentTime;

  const idx = findCue(t);

  if (idx === state.currentIndex) {
    const cur = state.cues[idx];
    if (cur && cur.fa && faEl && faEl.textContent !== cur.fa) {
      showCue(cur);
    }
    return;
  }

  state.currentIndex = idx;
  if (idx === -1) {
    hideBar();
  } else {
    showCue(state.cues[idx]);
  }
}

function findCue(t) {
  const cues = state.cues;
  if (!cues.length) return -1;

  let lo = 0;
  let hi = cues.length - 1;
  let best = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best === -1) return -1;

  for (let i = best; i >= 0; i--) {
    if (t < cues[i].end) return i;
    if (t - cues[i].start > 15) break;
  }

  return -1;
}

/* ------------------------------- boot -------------------------------- */

let notifyEl;
let notifyTimeout = null;

function notify(text) {
  if (!isYouTubeVideoPage()) return;
  if (!notifyEl) {
    notifyEl = document.createElement('div');
    notifyEl.id = 'ytfa-toast';
    document.body.appendChild(notifyEl);
  }

  if (notifyTimeout) {
    clearTimeout(notifyTimeout);
  }

  notifyEl.textContent = text;
  notifyEl.classList.add('ytfa-visible');

  notifyTimeout = setTimeout(() => {
    notifyEl?.classList.remove('ytfa-visible');
    notifyTimeout = null;
  }, 8000);
}

async function boot({ silent = false } = {}) {
  if (!isYouTubeVideoPage()) {
    cleanupPageUi();
    return;
  }
  if (!settings.enabled) return;
  if (state.loading) return;

  const generation = ++bootGeneration;
  const expectedVideoId = getVideoIdFromUrl();
  state.loading = true;
  updateToggleBtn(); 

  let success = false;
  try {
    const { videoId, url, tracks, videoMeta } = await requestCaptions();
    if (!settings.enabled || generation !== bootGeneration) return;
    state.videoMeta = videoMeta || null;
    if (getVideoIdFromUrl() !== expectedVideoId ||
        (expectedVideoId && videoId !== expectedVideoId)) {
      console.warn('[ytfa] ignored stale caption response:', videoId, expectedVideoId);
      return;
    }
    if (!videoId) {
      if (!silent) bootFailed = true;
      return;
    }
    if (videoId === state.videoId && state.cues.length) {
      bootFailed = false;
      return;
    }

    state.videoId = videoId;
    currentVideoId = videoId;
    state.cues = [];
    state.currentIndex = -1;
    state.activeVideo = getVideo();

    // Log new video detection with metadata
    const vTitle = state.videoMeta?.title || 'N/A';
    const vCategory = state.videoMeta?.category || 'N/A';
    console.log(`[ytfa] 🎬 New video loaded: "${vTitle.slice(0, 80)}" | YouTube Category: ${vCategory} | ID: ${videoId}`);

    if (!tracks || !tracks.length) {
      if (!silent) {
        notify('این ویدئو زیرنویس قابل‌دسترس ندارد.');
        bootFailed = true;
      }
      return;
    }
    if (!url) {
      if (!silent) {
        notify('دریافت زیرنویس از یوتیوب ناموفق بود؛ مطمئن شوید زیرنویس خودکار روشن است و دکمه ریلود در کنار دکمه سابتایتل را بزنید.');
        bootFailed = true;
      }
      return;
    }
    state.cues = await fetchCues(url);
    if (!settings.enabled || generation !== bootGeneration) return;
    applyCachedCaptions(videoId, state.cues);
    if (!state.cues.length) {
      if (!silent) {
        notify('زیرنویسی برای ترجمه پیدا نشد.');
        bootFailed = true;
      }
      return;
    }
    success = true;
    translateAll(); 
  } catch (e) {
    console.warn('[ytfa] boot error:', e);
    if (!silent) bootFailed = true;
  } finally {
    if (generation !== bootGeneration) return;
    state.loading = false;
    if (success) bootFailed = false;
    updateToggleBtn(); 
  }
}

/* ----------------------- navigation handling ------------------------- */

function cleanupPageUi() {
  hideBar();
  closeModelDropdown();
  if (faEl) faEl.textContent = '';
  if (origEl) origEl.textContent = '';
  if (bar?.parentElement) bar.parentElement.classList.remove('ytfa-on');
  if (toggleBtn) toggleBtn.style.display = 'none';
  if (modelSelectBtn) modelSelectBtn.style.display = 'none';
  if (notifyEl) notifyEl.classList.remove('ytfa-visible');
  if (notifyTimeout) {
    clearTimeout(notifyTimeout);
    notifyTimeout = null;
  }
}

const MAX_NAVIGATION_BOOT_RETRIES = 10;
let navigationBootTimer = null;

function scheduleNavigationBoot(videoId, attempt = 0) {
  if (!videoId || navigationBootTimer) return;

  navigationBootTimer = setTimeout(async () => {
    navigationBootTimer = null;
    if (!settings.enabled || getVideoIdFromUrl() !== videoId) return;

    await boot({ silent: attempt < MAX_NAVIGATION_BOOT_RETRIES - 1 });
    if (getVideoIdFromUrl() === videoId && !state.cues.length &&
        attempt + 1 < MAX_NAVIGATION_BOOT_RETRIES) {
      scheduleNavigationBoot(videoId, attempt + 1);
    }
  }, attempt === 0 ? 300 : 700);
}

function onNavigate() {
  const nextVideoId = getVideoIdFromUrl();
  const videoChanged = nextVideoId !== currentVideoId;

  if (videoChanged || !isYouTubeVideoPage()) {
    if (navigationBootTimer) {
      clearTimeout(navigationBootTimer);
      navigationBootTimer = null;
    }
    bootGeneration++;
    state.loading = false;
    stopTranslation();
    state.videoId = null;
    state.videoMeta = null;
    state.cues = [];
    state.currentIndex = -1;
    state.activeVideo = null;
    state.loadedFromCloudCache = false;
    state.uploadedToCloud = false;
    state.bypassCloudCache = false;
    state.cachedModels = [];
    state.activeModelIndex = -1;
    bootFailed = false;
    subtitleVisible = true;
    cleanupPageUi();
    currentVideoId = nextVideoId;
  }

  if (!settings.enabled || !isYouTubeVideoPage()) return;
  ensureToggleBtn();
  if (!videoChanged && (state.loading || state.cues.length)) return;
  scheduleNavigationBoot(nextVideoId);
}

document.addEventListener('yt-navigate-finish', onNavigate);
window.addEventListener('popstate', onNavigate);
window.addEventListener('yt-page-data-updated', onNavigate);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'APPLY') {
    loadSettings().then(() => {
      if (!settings.enabled) {
        hideBar();
        stopTranslation();
        if (toggleBtn) toggleBtn.style.display = 'none';
      } else if (isYouTubeVideoPage()) {
        attachBar();
        applyStyles();
        if (state.cues.length) {
          captionCache.clear();
          state.cues.forEach(c => c.fa = '');
          // توقف ترجمه قبلی تا تنظیمات و کلیدهای جدید اعمال شوند
          stopTranslation();
          translateAll();
        } else if (!state.loading) {
          boot();
        }
      } else {
        cleanupPageUi();
      }
      sendResponse({ ok: true });
    });
    return true; 
  }
});

(async function init() {
  loadFonts();
  await loadSettings();
  syncLoop();
  if (isYouTubeVideoPage()) updateToggleBtn();

  let tries = 0;
  const MAX_TRIES = 10;
  const iv = setInterval(() => {
    if (!settings.enabled) {
      clearInterval(iv);
      return;
    }
    if (!isYouTubeVideoPage()) return;
    tries++;
    if (state.cues.length) {
      clearInterval(iv);
      return;
    }
    if (tries >= MAX_TRIES) {
      clearInterval(iv);
      boot({ silent: true }).finally(() => {
        if (!settings.enabled) return;
        if (!state.cues.length) {
          bootFailed = true;
          notify('دریافت زیرنویس از یوتیوب ناموفق بود؛کمی صبر کنید و دکمه ریلود در کنار دکمه سابتایتل را فشار دهید.');
          updateToggleBtn();
        }
      });
      return;
    }
    boot({ silent: true });
  }, 1000);
})();

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && settings.enabled && isYouTubeVideoPage()) {
    if (state.cues.length) {
      if (!isTranslating) translateAll();
    } else if (!state.loading) {
      boot({ silent: true });
    }
  } else if (document.hidden) {
    stopTranslation();
  }
});