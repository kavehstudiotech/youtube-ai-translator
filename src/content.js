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

async function onWordClick(spanEl, word) {
  const cue = state.cues[state.currentIndex];
  if (!cue) return;

  spanEl.classList.add('ytfa-word-saved');
  setTimeout(() => spanEl.classList.remove('ytfa-word-saved'), 800);

  let wordFa = '';
  try {
    const dictResp = await chrome.runtime.sendMessage({
      type: 'TRANSLATE_WORD_DICTIONARY',
      word: word,
      sentence: cue.text || ''
    });
    if (dictResp?.ok && dictResp.translation) {
      wordFa = dictResp.translation;
    }
  } catch (err) {
    console.warn('[ytfa] Dictionary fetch failed for word/phrase:', word, err);
  }

  const vId = state.videoId || getVideoIdFromUrl() || 'video';
  const video = getVideo();
  const currentTimeSec = video ? Math.floor(video.currentTime) : 0;
  const rawTitle =
    document.querySelector('h1.ytd-watch-metadata, h1.ytd-video-primary-info-renderer')
      ?.textContent?.trim() || document.title.replace('- YouTube', '').trim();
  const url = `https://www.youtube.com/watch?v=${vId}&t=${currentTimeSec}s`;

  const newItem = {
    id: 'sw_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    word: word,
    wordFa: wordFa,
    en: cue.text || '',
    fa: cue.fa || '',
    title: rawTitle || 'ویدیو یوتیوب',
    url: url,
    videoId: vId,
    timestamp: currentTimeSec,
    dateAdded: new Date().toISOString(),
  };

  const data = await chrome.storage.local.get({ savedWords: [] });
  let savedWords = data.savedWords || [];

  const existsIndex = savedWords.findIndex(
    (item) => (item.word || item.en) === word && item.en === cue.text && item.videoId === vId
  );

  if (existsIndex === -1) {
    savedWords.unshift(newItem);
    await chrome.storage.local.set({ savedWords });
    notify(`عبارت "${word}" به فلاش‌کارت‌ها اضافه شد ✓`);
  } else {
    if (wordFa && !savedWords[existsIndex].wordFa) {
      savedWords[existsIndex].wordFa = wordFa;
      await chrome.storage.local.set({ savedWords });
    }
    notify(`عبارت "${word}" قبلاً ذخیره شده است.`);
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

/* ───────────────── floating toggle / retry button ────────────────────────── */

/* ───────────────── floating toggle / progress / download controls ────────────── */

let controlsWrap = null;
let toggleBtn = null;
let progressBadge = null;
let dlEnBtn = null;
let dlFaBtn = null;
let ensureToggleBtnFrame = null;

function getActiveShortsActionBar() {
  // ۱. پیدا کردن شورتس فعال در صفحه
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

  // ۲. جستجوی مستقیم بر اساس اسکرین‌شات DevTools شما
  const visibleBar = document.querySelector('reel-action-bar-view-model, .ytwReelActionBarViewModelHost');
  if (visibleBar) {
    const likeBtn = visibleBar.querySelector('like-button-view-model, .ytLikeButtonViewModelHost') ||
                    document.querySelector('like-button-view-model, .ytLikeButtonViewModelHost');
    return { actionBar: visibleBar, likeBtn };
  }

  // ۳. فال‌بک بر اساس والد دکمه لایک
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

function updateProgressAndDownload() {
  if (!progressBadge || !dlEnBtn || !dlFaBtn) return;

  const totalCues = state.cues.length;
  if (!totalCues) {
    progressBadge.style.display = 'none';
    dlEnBtn.style.display = 'none';
    dlFaBtn.style.display = 'none';
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

  // English button display
  dlEnBtn.style.display = 'inline-flex';

  // Persian button display
  if (translatedCount > 0) {
    dlFaBtn.style.display = 'inline-flex';
    dlFaBtn.classList.toggle('completed', pct === 100);
    dlFaBtn.dataset.tooltip = pct === 100
      ? 'دانلود زیرنویس کامل فارسی (SRT)'
      : `دانلود زیرنویس فارسی (SRT) — ${pct}% کامل شده`;
  } else {
    dlFaBtn.style.display = 'none';
  }
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
  return cues;
}

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

async function translateAll() {
  // اگر افزونه خاموش باشد، صفحه یوتیوب نباشد یا تب در پس‌زمینه (مخفی) باشد، ترجمه متوقف می‌شود
  if (!settings.enabled || !isYouTubeVideoPage() || document.hidden) {
    stopTranslation();
    return;
  }

  if (isTranslating) return;

  const currentSessionId = state.translationSessionId;
  const translationVideoId = state.videoId || currentVideoId;
  applyCachedCaptions(translationVideoId, state.cues);

  const rpm = settings.rpm || 15;
  activeBatches = groupCuesByRPM(state.cues, rpm);
  isTranslating = true;

  let notifiedError = false;

  while (isTranslating && currentSessionId === state.translationSessionId) {
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
      ERR_AUTH: 'کلید API معتبر نیست یا منقضی شده است (ارور ۴۰۱/۴۰۳). لطفاً کلید ثبت‌شده در تنظیمات افزونه را بررسی کنید.',
      ERR_SERVER: 'سرور هوش مصنوعی موقتاً در دسترس نیست یا با ترافیک سنگین مواجه است (ارور ۵۰۳/۵۰۰). افزونه به طور خودکار مجدداً تلاش خواهد کرد.',
      ERR_400: 'درخواست نامعتبر است (ارور ۴۰۰). احتمالاً نام مدل انتخابی اشتباه است یا توسط این پرووایدر پشتیبانی نمی‌شود.',
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
      } else if (resp?.error === 'ERR_AUTH') {
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
  if (!settings.enabled || !isYouTubeVideoPage()) return;
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
    notifyEl.classList.remove('ytfa-visible');
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
  if (faEl) faEl.textContent = '';
  if (origEl) origEl.textContent = '';
  if (bar?.parentElement) bar.parentElement.classList.remove('ytfa-on');
  if (toggleBtn) toggleBtn.style.display = 'none';
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