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

const SETTINGS_DEFAULTS = {
  enabled: true,
  showOriginal: true,
  showPersian: true,
  origFirst: false,
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
  rafId: null,
  translationSessionId: 0,
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
  for (const key of Object.keys(changes)) {
    if (key in settings || key in SETTINGS_DEFAULTS) {
      settings[key] = changes[key].newValue;
      touched = true;
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
    } else {
      bootFailed = false;
      subtitleVisible = true;
      if (bar) attachBar();
      ensureToggleBtn();
      updateToggleBtn();
      if (!state.cues.length && !state.loading) {
        boot();
      } else if (state.cues.length) {
        translateAll();
      }
    }
  }
});

/* ------------------------- subtitle overlay UI ----------------------- */

let bar, faEl, origEl;

function ensureBar() {
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
  const player =
    document.querySelector('.html5-video-player') ||
    document.getElementById('movie_player');
  const host = player || document.body;
  if (bar.parentElement !== host) host.appendChild(bar);
  if (player) player.classList.toggle('ytfa-on', !!settings.enabled);
  ensureToggleBtn();
}

/* ───────────────── floating toggle / retry button ────────────────────────── */

let toggleBtn = null;

function ensureToggleBtn() {
  if (!settings.enabled) {
    if (toggleBtn) toggleBtn.style.display = 'none';
    return;
  }

  const player =
    document.querySelector('.html5-video-player') ||
    document.getElementById('movie_player');
  if (!player) return;

  if (!toggleBtn || !player.contains(toggleBtn)) {
    toggleBtn = document.createElement('button');
    toggleBtn.id = 'ytfa-toggle-btn';

    const icon = document.createElement('span');
    icon.className = 'ytfa-btn-icon';
    toggleBtn.appendChild(icon);

    toggleBtn.addEventListener('click', onToggleBtnClick);
    player.appendChild(toggleBtn);
  }

  toggleBtn.style.display = '';
}

function updateToggleBtn() {
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
}

function onToggleBtnClick() {
  if (state.loading) return; 

  if (bootFailed || !state.cues.length) {
    bootFailed = false;
    subtitleVisible = true;
    state.videoId = null; 
    state.cues = [];
    state.currentIndex = -1;
    updateToggleBtn();
    boot({ silent: false });
    return;
  }

  subtitleVisible = !subtitleVisible;
  if (subtitleVisible) {
    const video = getVideo();
    if (video) {
      const idx = findCue(video.currentTime);
      if (idx !== -1) showCue(state.cues[idx]);
    }
  } else {
    if (bar) bar.classList.remove('ytfa-visible');
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

  if (s.origFirst) {
    if (bar.firstChild !== origEl) bar.insertBefore(origEl, faEl);
  } else {
    if (bar.firstChild !== faEl) bar.insertBefore(faEl, origEl);
  }
}

function showCue(cue) {
  ensureBar();
  attachBar();
  faEl.textContent = cue.fa || '…';
  origEl.textContent = cue.text || '';
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
    cues.push({ start, end: start + (dur || 4), text, fa: '' });
  }

  cues.sort((a, b) => a.start - b.start);
  return cues;
}

function groupCuesByRPM(cues, rpm) {
  const multiplier = 3; 
  const minDuration = (60 / rpm) * multiplier; 
  const batches = [];
  if (!cues.length) return batches;

  let currentTexts = [];
  let startIdx = 0;
  let batchStartTime = cues[0].start;

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    currentTexts.push(cue.text);
    const duration = cue.end - batchStartTime;

    if (duration >= minDuration || i === cues.length - 1 || currentTexts.length >= 25) {
      batches.push({
        texts: currentTexts,
        startIdx: startIdx,
        endIdx: i
      });

      startIdx = i + 1;
      currentTexts = [];
      if (i + 1 < cues.length) {
        batchStartTime = cues[i + 1].start;
      }
    }
  }

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
  if (!settings.enabled) {
    stopTranslation();
    return;
  }

  if (isTranslating) return;

  const currentSessionId = state.translationSessionId;
  const rpm = settings.rpm || 15;
  activeBatches = groupCuesByRPM(state.cues, rpm);
  isTranslating = true;

  let notifiedError = false;

  while (isTranslating && currentSessionId === state.translationSessionId) {
    if (!settings.enabled) {
      stopTranslation();
      break;
    }

    const untranslated = activeBatches.filter(b => !isBatchTranslated(b));
    if (untranslated.length === 0) break;

    const video = getVideo();
    const currentTime = video ? video.currentTime : 0;

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
    const { texts, startIdx, endIdx } = batch;

    const ERROR_MESSAGES = {
      ERR_429: 'به محدودیت تعداد درخواست هوش مصنوعی (ارور ۴۲۹) برخوردید. لطفاً چند لحظه صبر کنید یا محدودیت RPM را در تنظیمات کاهش دهید.',
      ERR_AUTH: 'کلید API معتبر نیست یا منقضی شده است (ارور ۴۰۱/۴۰۳). لطفاً کلید ثبت‌شده در تنظیمات افزونه را بررسی کنید.',
      ERR_SERVER: 'سرور هوش مصنوعی موقتاً در دسترس نیست یا با ترافیک سنگین مواجه است (ارور ۵۰۳/۵۰۰). افزونه به طور خودکار مجدداً تلاش خواهد کرد.',
      ERR_400: 'درخواست نامعتبر است (ارور ۴۰۰). احتمالاً نام مدل انتخابی اشتباه است یا توسط این پرووایدر پشتیبانی نمی‌شود.',
      ERR_NETWORK: 'خطای شبکه یا قطعی اینترنت. لطفاً اتصال فیلترشکن (VPN) خود را بررسی کنید.',
    };

    let hasError = false;
    try {
      if (!settings.enabled || currentSessionId !== state.translationSessionId) break;
      const resp = await chrome.runtime.sendMessage({ type: 'TRANSLATE', texts });
      if (!settings.enabled || currentSessionId !== state.translationSessionId) break;

      if (resp?.ok) {
        if (currentSessionId === state.translationSessionId) {
          resp.translations.forEach((fa, j) => {
            const cueIdx = startIdx + j;
            if (state.cues[cueIdx]) {
              // برای جلوگیری از گیر کردن، اگر ترجمه خالی بود یک فاصله قرار می‌دهیم
              state.cues[cueIdx].fa = fa ? fa : ' ';
              if (!fa) console.warn(`[ytfa] Empty translation for cue ${cueIdx}`);
            }
          });
          if (state.currentIndex >= startIdx && state.currentIndex <= endIdx) {
            showCue(state.cues[state.currentIndex]);
          }
        }
      } else if (resp?.error === 'APP_DISABLED') {
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
      if (!settings.enabled || currentSessionId !== state.translationSessionId) break;
    }
  }

  if (currentSessionId === state.translationSessionId) {
    isTranslating = false;
  }
}

function isBatchTranslated(batch) {
  for (let i = batch.startIdx; i <= batch.endIdx; i++) {
    if (state.cues[i] && state.cues[i].fa === '') return false;
  }
  return true;
}

/* --------------------------- playback sync --------------------------- */

function getVideo() {
  return document.querySelector('video.html5-main-video, video');
}

function syncLoop() {
  state.rafId = requestAnimationFrame(syncLoop);
  if (!settings.enabled || !state.cues.length) return;
  const video = getVideo();
  if (!video) return;
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
  if (!settings.enabled) return;
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
  if (!location.pathname.startsWith('/watch')) {
    hideBar();
    return;
  }
  if (!settings.enabled) return;
  if (state.loading) return;

  const generation = ++bootGeneration;
  state.loading = true;
  updateToggleBtn(); 

  let success = false;
  try {
    const { videoId, url, tracks } = await requestCaptions();
    if (!settings.enabled || generation !== bootGeneration) return;
    if (!videoId) {
      if (!silent) bootFailed = true;
      return;
    }
    if (videoId === state.videoId && state.cues.length) {
      bootFailed = false;
      return;
    }

    state.videoId = videoId;
    state.cues = [];
    state.currentIndex = -1;

    if (!tracks || !tracks.length) {
      if (!silent) {
        notify('این ویدئو زیرنویس قابل‌دسترس ندارد.');
        bootFailed = true;
      }
      return;
    }
    if (!url) {
      if (!silent) {
        notify('دریافت زیرنویس از یوتیوب ناموفق بود؛ مطمئن شوید زیرنویس خودکار روشن است و دکمه ریلود در گوشه ویدیو را بزنید.');
        bootFailed = true;
      }
      return;
    }
    state.cues = await fetchCues(url);
    if (!settings.enabled || generation !== bootGeneration) return;
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

function onNavigate() {
  bootGeneration++;
  state.loading = false;
  stopTranslation();
  state.videoId = null;
  state.cues = [];
  state.currentIndex = -1;
  bootFailed = false;
  subtitleVisible = true; 
  hideBar();
  updateToggleBtn(); 
  if (!settings.enabled) return;
  setTimeout(() => {
    if (settings.enabled) boot({ silent: false });
  }, 800);
}

document.addEventListener('yt-navigate-finish', onNavigate);
window.addEventListener('yt-page-data-updated', onNavigate);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'APPLY') {
    loadSettings().then(() => {
      if (!settings.enabled) {
        hideBar();
        stopTranslation();
        if (toggleBtn) toggleBtn.style.display = 'none';
      } else {
        attachBar();
        applyStyles();
        if (state.cues.length) {
          state.cues.forEach(c => c.fa = '');
          // توقف ترجمه قبلی تا تنظیمات و کلیدهای جدید اعمال شوند
          stopTranslation();
          translateAll();
        } else if (!state.loading) {
          boot();
        }
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
  updateToggleBtn();

  let tries = 0;
  const MAX_TRIES = 10;
  const iv = setInterval(() => {
    if (!settings.enabled) {
      clearInterval(iv);
      return;
    }
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
          notify('دریافت زیرنویس از یوتیوب ناموفق بود؛کمی صبر کنید و دکمه ریلود در گوشه ویدیو را فشار دهید.');
          updateToggleBtn();
        }
      });
      return;
    }
    boot({ silent: true });
  }, 1000);
})();