/* popup.js — settings UI: load, live-preview, persist to chrome.storage.sync */

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
  bottomOffset: 8,
};

const $ = (id) => document.getElementById(id);

// id -> { type } describing how each control maps to a setting.
const FIELDS = {
  enabled: 'checked',
  provider: 'value',
  apiKey: 'value',
  geminiApiKey: 'value',
  grokApiKey: 'value',
  deepseekApiKey: 'value',
  openaiApiKey: 'value',
  model: 'value',
  geminiModel: 'value',
  grokModel: 'value',
  deepseekModel: 'value',
  openaiModel: 'value',
  localBaseUrl: 'value',
  localModel: 'value',
  customBaseUrl: 'value',
  customApiKey: 'value',
  customModel: 'value',
  rpm: 'int',
  showOriginal: 'checked',
  showPersian: 'checked',
  origFirst: 'checked',
  faFontSize: 'int',
  faColor: 'value',
  faFontFamily: 'value',
  faBold: 'checked',
  origFontSize: 'int',
  origColor: 'value',
  bgColor: 'value',
  bgOpacity: 'pct',
  bottomOffset: 'int',
};

let current = { ...DEFAULTS };

// Models offered in the dropdown; anything else => "custom".
const PRESET_MODELS = new Set([
  'anthropic/claude-3.5-sonnet',
  'openai/gpt-4o',
  'openai/gpt-5.6-sol',
  'deepseek/deepseek-v4-pro',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-pro:free',
  'meta-llama/llama-4-scout:free',
  'deepseek/deepseek-r1:free',
  'deepseek/deepseek-chat:free',
]);

const PRESET_GEMINI_MODELS = new Set([
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.1-pro',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
]);

const PRESET_GROK_MODELS = new Set([
  'openai/gpt-oss-120b',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'qwen/qwen3.6-27b',
  'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile',
]);

const PRESET_DEEPSEEK_MODELS = new Set([
  'deepseek-v4-flash',
  'deepseek-v4-pro',
]);

const PRESET_OPENAI_MODELS = new Set([
  'gpt-5.6-luna',
  'gpt-4o-mini',
  'gpt-5.6-sol',
  'gpt-4o',
]);

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

function readModel() {
  const sel = $('modelSelect').value;
  if (sel === '__custom__') return $('model').value.trim();
  return sel;
}

function applyModelToControls(model) {
  const isPreset = PRESET_MODELS.has(model);
  $('modelSelect').value = isPreset ? model : '__custom__';
  $('customModelField').hidden = isPreset;
  if (!isPreset) $('model').value = model || '';
}

function readGeminiModel() {
  const sel = $('geminiModelSelect').value;
  if (sel === '__custom__') return $('geminiModel').value.trim();
  return sel;
}

function applyGeminiModelToControls(model) {
  const isPreset = PRESET_GEMINI_MODELS.has(model);
  $('geminiModelSelect').value = isPreset ? model : '__custom__';
  $('customGeminiModelField').hidden = isPreset;
  if (!isPreset) $('geminiModel').value = model || '';
}

function readGrokModel() {
  const sel = $('grokModelSelect').value;
  if (sel === '__custom__') return $('grokModel').value.trim();
  return sel;
}

function applyGrokModelToControls(model) {
  const isPreset = PRESET_GROK_MODELS.has(model);
  $('grokModelSelect').value = isPreset ? model : '__custom__';
  $('customGrokModelField').hidden = isPreset;
  if (!isPreset) $('grokModel').value = model || '';
}

function readDeepseekModel() {
  const sel = $('deepseekModelSelect').value;
  if (sel === '__custom__') return $('deepseekModel').value.trim();
  return sel;
}

function applyDeepseekModelToControls(model) {
  const isPreset = PRESET_DEEPSEEK_MODELS.has(model);
  $('deepseekModelSelect').value = isPreset ? model : '__custom__';
  $('customDeepseekModelField').hidden = isPreset;
  if (!isPreset) $('deepseekModel').value = model || '';
}

function readOpenaiModel() {
  const sel = $('openaiModelSelect').value;
  if (sel === '__custom__') return $('openaiModel').value.trim();
  return sel;
}

function applyOpenaiModelToControls(model) {
  const isPreset = PRESET_OPENAI_MODELS.has(model);
  $('openaiModelSelect').value = isPreset ? model : '__custom__';
  $('customOpenaiModelField').hidden = isPreset;
  if (!isPreset) $('openaiModel').value = model || '';
}

function toggleProviderSections(provider) {
  document.querySelectorAll('.provider-section').forEach((el) => {
    el.hidden = true;
  });
  const sec = $('section-' + provider);
  if (sec) sec.hidden = false;

  // پنهان کردن فیلد RPM در صورت انتخاب گوگل ترنسلیت
  const rpmField = $('rpm').closest('.field');
  if (rpmField) {
    rpmField.style.display = provider === 'google_free' ? 'none' : '';
  }
}

function readControl(id, kind) {
  const el = $(id);
  if (!el) return DEFAULTS[id];
  switch (kind) {
    case 'checked':
      return el.checked;
    case 'int':
      return parseInt(el.value, 10);
    case 'pct':
      return parseInt(el.value, 10) / 100;
    default:
      return el.value;
  }
}

function writeControl(id, kind, val) {
  const el = $(id);
  if (!el) return;
  switch (kind) {
    case 'checked':
      el.checked = !!val;
      break;
    case 'pct':
      el.value = Math.round(val * 100);
      break;
    default:
      el.value = val;
  }
}

function hexToRgba(hex, alpha) {
  const m = hex.replace('#', '');
  const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function updateOutputs() {
  $('faFontSizeV').textContent = current.faFontSize;
  $('origFontSizeV').textContent = current.origFontSize;
  $('bgOpacityV').textContent = Math.round(current.bgOpacity * 100) + '٪';
  $('bottomOffsetV').textContent = current.bottomOffset + '٪';
}

function renderPreview() {
  const bar = $('previewBar');
  const fa = $('previewFa');
  const orig = $('previewOrig');
  bar.style.background = hexToRgba(current.bgColor, current.bgOpacity);
  bar.style.bottom = current.bottomOffset + '%';

  fa.style.fontSize = current.faFontSize + 'px';
  fa.style.color = current.faColor;
  fa.style.fontFamily = current.faFontFamily;
  fa.style.fontWeight = current.faBold ? '700' : '400';

  orig.style.fontSize = current.origFontSize + 'px';
  orig.style.color = current.origColor;
  orig.style.display = current.showOriginal ? 'block' : 'none';

  fa.style.display = current.showPersian ? 'block' : 'none';

  // Swap visual order: origFirst → English on top, Persian below
  if (current.origFirst) {
    if (bar.firstChild !== orig) bar.insertBefore(orig, fa);
  } else {
    if (bar.firstChild !== fa) bar.insertBefore(fa, orig);
  }
}

/* ─── Slider split-colour tracks ─────────────────────────── */
function updateSliderTracks() {
  document.querySelectorAll("input[type='range']").forEach((input) => {
    const min = parseFloat(input.min) || 0;
    const max = parseFloat(input.max) || 100;
    const pct = ((parseFloat(input.value) - min) / (max - min)) * 100;
    input.style.background =
      `linear-gradient(to left, var(--accent) ${pct}%, var(--line) ${pct}%)`;
  });
}

/* ─── Custom Select Wrappers ─────────────────────────── */
/* Builds a true HTML custom dropdown for every <select>.
* This allows us to animate the dropdown menu itself and style it
* with the dark premium theme, bypassing the unstyleable native OS menu.
*/
function initCustomSelects() {
  document.querySelectorAll('select').forEach((sel) => {
    if (sel.parentElement.classList.contains('custom-select')) return;

    const wrap = document.createElement('div');
    wrap.className = 'custom-select';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.style.display = 'none'; // hide native select

    const selected = document.createElement('div');
    selected.className = 'select-selected';
    selected.innerHTML = sel.options[sel.selectedIndex]?.innerHTML || '';
    wrap.appendChild(selected);

    const items = document.createElement('div');
    items.className = 'select-items select-hide';

    Array.from(sel.options).forEach((opt, index) => {
      const item = document.createElement('div');
      item.innerHTML = opt.innerHTML;
      if (index === sel.selectedIndex) item.classList.add('same-as-selected');

      item.addEventListener('click', function (e) {
        e.stopPropagation();
        sel.selectedIndex = index;
        selected.innerHTML = this.innerHTML;

        const y = this.parentNode.getElementsByClassName('same-as-selected');
        for (let k = 0; k < y.length; k++) y[k].classList.remove('same-as-selected');
        this.classList.add('same-as-selected');

        // Close dropdown explicitly on selection
        items.classList.add('select-hide');
        selected.classList.remove('select-arrow-active');

        sel.dispatchEvent(new Event('change'));
      });
      items.appendChild(item);
    });
    wrap.appendChild(items);

    selected.addEventListener('click', function (e) {
      e.stopPropagation();
      closeAllSelect(e);
      items.classList.toggle('select-hide');
      selected.classList.toggle('select-arrow-active');
    });
  });

  document.addEventListener('click', closeAllSelect);
}

function closeAllSelect(e) {
  const x = document.getElementsByClassName('select-items');
  const y = document.getElementsByClassName('select-selected');
  for (let i = 0; i < y.length; i++) {
    const wrap = y[i].parentNode;
    // If we clicked inside this specific custom select, do not close it here
    if (e && e.target && wrap.contains(e.target)) {
      continue;
    }
    y[i].classList.remove('select-arrow-active');
    x[i].classList.add('select-hide');
  }
}

/** Re-syncs the displayed text in all custom selects after a programmatic value change. */
function refreshSelectDisplays() {
  document.querySelectorAll('.custom-select').forEach((wrap) => {
    const sel = wrap.querySelector('select');
    const selected = wrap.querySelector('.select-selected');
    const items = wrap.querySelectorAll('.select-items div');

    if (sel && selected) {
      const idx = sel.selectedIndex;
      selected.innerHTML = sel.options[idx]?.innerHTML || '';

      items.forEach(item => item.classList.remove('same-as-selected'));
      if (items[idx]) items[idx].classList.add('same-as-selected');
    }
  });
}

let saveTimer;
function flashSaved() {
  const el = $('saved');
  el.classList.add('show');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => el.classList.remove('show'), 1200);
}

function persist() {
  chrome.storage.sync.set(current, flashSaved);
}

function onChange() {
  const prevProvider = current.provider;
  for (const [id, kind] of Object.entries(FIELDS)) {
    current[id] = readControl(id, kind);
  }
  current.model = readModel();
  current.geminiModel = readGeminiModel();
  current.grokModel = readGrokModel();
  current.deepseekModel = readDeepseekModel();
  current.openaiModel = readOpenaiModel();

  const activeModel = getActiveModel(current);
  if (activeModel) {
    if (!current.modelRpms) current.modelRpms = {};
    if (current.provider !== prevProvider) {
      // Provider changed: load the new model's stored RPM instead of overwriting it
      const rpmVal = current.modelRpms[activeModel] || 15;
      writeControl('rpm', 'int', rpmVal);
      current.rpm = rpmVal;
      updateSliderTracks();
    } else {
      // Normal change: save current slider RPM to this model's slot
      const rpmVal = readControl('rpm', 'int') || 15;
      current.modelRpms[activeModel] = rpmVal;
      current.rpm = rpmVal;
    }
  }

  updateOutputs();
  renderPreview();
  persist();
}

function onModelChange() {
  $('customModelField').hidden = $('modelSelect').value !== '__custom__';
  current.model = readModel();
  const activeModel = current.model;
  const rpmVal = (current.modelRpms && current.modelRpms[activeModel]) || 15;
  writeControl('rpm', 'int', rpmVal);
  current.rpm = rpmVal;
  persist();
}

function onGeminiModelChange() {
  $('customGeminiModelField').hidden = $('geminiModelSelect').value !== '__custom__';
  current.geminiModel = readGeminiModel();
  const activeModel = current.geminiModel;
  const rpmVal = (current.modelRpms && current.modelRpms[activeModel]) || 15;
  writeControl('rpm', 'int', rpmVal);
  current.rpm = rpmVal;
  persist();
}

function onGrokModelChange() {
  $('customGrokModelField').hidden = $('grokModelSelect').value !== '__custom__';
  current.grokModel = readGrokModel();
  const activeModel = current.grokModel;
  const rpmVal = (current.modelRpms && current.modelRpms[activeModel]) || 15;
  writeControl('rpm', 'int', rpmVal);
  current.rpm = rpmVal;
  persist();
}

function onDeepseekModelChange() {
  $('customDeepseekModelField').hidden = $('deepseekModelSelect').value !== '__custom__';
  current.deepseekModel = readDeepseekModel();
  const activeModel = current.deepseekModel;
  const rpmVal = (current.modelRpms && current.modelRpms[activeModel]) || 15;
  writeControl('rpm', 'int', rpmVal);
  current.rpm = rpmVal;
  persist();
}

function onOpenaiModelChange() {
  $('customOpenaiModelField').hidden = $('openaiModelSelect').value !== '__custom__';
  current.openaiModel = readOpenaiModel();
  const activeModel = current.openaiModel;
  const rpmVal = (current.modelRpms && current.modelRpms[activeModel]) || 15;
  writeControl('rpm', 'int', rpmVal);
  current.rpm = rpmVal;
  persist();
}

function hydrate(values) {
  current = { ...DEFAULTS, ...values };
  for (const [id, kind] of Object.entries(FIELDS)) {
    writeControl(id, kind, current[id]);
  }
  applyModelToControls(current.model);
  applyGeminiModelToControls(current.geminiModel);
  applyGrokModelToControls(current.grokModel);
  applyDeepseekModelToControls(current.deepseekModel);
  applyOpenaiModelToControls(current.openaiModel);
  toggleProviderSections(current.provider);

  // Update the RPM input field with the active model's RPM
  const activeModel = getActiveModel(current);
  if (activeModel) {
    const rpmVal = (current.modelRpms && current.modelRpms[activeModel]) || 15;
    writeControl('rpm', 'int', rpmVal);
    current.rpm = rpmVal;
  }

  updateOutputs();
  renderPreview();
  // Keep custom select displays in sync with programmatic value changes
  refreshSelectDisplays();
  // Repaint all slider tracks so gradients match their new values
  updateSliderTracks();
}

/* --- API key test --- */
async function testKey() {
  const status = $('status');
  const key = $('apiKey').value.trim();
  if (!key) {
    status.className = 'status err';
    status.textContent = 'ابتدا کلید را وارد کنید.';
    return;
  }
  status.className = 'status loading';
  status.textContent = 'در حال بررسی…';
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) {
      status.className = 'status ok';
      status.textContent = 'کلید معتبر است ✓';
    } else {
      status.className = 'status err';
      status.textContent = `کلید نامعتبر (کد ${res.status}).`;
    }
  } catch (e) {
    status.className = 'status err';
    status.textContent = 'خطا در اتصال به OpenRouter.';
  }
}

async function testGeminiKey() {
  const status = $('status');
  const key = $('geminiApiKey').value.trim();
  if (!key) {
    status.className = 'status err';
    status.textContent = 'ابتدا کلید Gemini را وارد کنید.';
    return;
  }
  status.className = 'status loading';
  status.textContent = 'در حال بررسی…';
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
    if (res.ok) {
      status.className = 'status ok';
      status.textContent = 'کلید معتبر است ✓';
    } else {
      status.className = 'status err';
      status.textContent = `کلید نامعتبر (کد ${res.status}).`;
    }
  } catch (e) {
    status.className = 'status err';
    status.textContent = 'خطا در اتصال به گوگل.';
  }
}

async function testGrokKey() {
  const status = $('status');
  const key = $('grokApiKey').value.trim();
  if (!key) {
    status.className = 'status err';
    status.textContent = 'ابتدا کلید Grok را وارد کنید.';
    return;
  }
  status.className = 'status loading';
  status.textContent = 'در حال بررسی…';
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) {
      status.className = 'status ok';
      status.textContent = 'کلید معتبر است ✓';
    } else {
      status.className = 'status err';
      status.textContent = `کلید نامعتبر (کد ${res.status}).`;
    }
  } catch (e) {
    status.className = 'status err';
    status.textContent = 'خطا در اتصال به Grok.';
  }
}

async function testDeepseekKey() {
  const status = $('status');
  const key = $('deepseekApiKey').value.trim();
  if (!key) {
    status.className = 'status err';
    status.textContent = 'ابتدا کلید DeepSeek را وارد کنید.';
    return;
  }
  status.className = 'status loading';
  status.textContent = 'در حال بررسی…';
  try {
    const res = await fetch('https://api.deepseek.com/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) {
      status.className = 'status ok';
      status.textContent = 'کلید معتبر است ✓';
    } else {
      status.className = 'status err';
      status.textContent = `کلید نامعتبر (کد ${res.status}).`;
    }
  } catch (e) {
    status.className = 'status err';
    status.textContent = 'خطا در اتصال به DeepSeek.';
  }
}

async function testOpenaiKey() {
  const status = $('status');
  const key = $('openaiApiKey').value.trim();
  if (!key) {
    status.className = 'status err';
    status.textContent = 'ابتدا کلید OpenAI را وارد کنید.';
    return;
  }
  status.className = 'status loading';
  status.textContent = 'در حال بررسی…';
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) {
      status.className = 'status ok';
      status.textContent = 'کلید معتبر است ✓';
    } else {
      status.className = 'status err';
      status.textContent = `کلید نامعتبر (کد ${res.status}).`;
    }
  } catch (e) {
    status.className = 'status err';
    status.textContent = 'خطا در اتصال به OpenAI.';
  }
}

/* --- wire up --- */
document.addEventListener('DOMContentLoaded', async () => {
  // Build custom select wrappers before hydrating so first render is correct
  initCustomSelects();

  const stored = await chrome.storage.sync.get(DEFAULTS);
  hydrate(stored);

  // Initialize split-colour range tracks on load
  updateSliderTracks();

  for (const id of Object.keys(FIELDS)) {
    const el = $(id);
    if (!el) continue;
    const isTextInput = el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'password' || el.type === 'range' || el.type === 'color');
    const ev = isTextInput ? 'input' : 'change';
    el.addEventListener(ev, onChange);
    // Keep range tracks live while dragging
    if (el.type === 'range') el.addEventListener('input', updateSliderTracks);
  }

  $('modelSelect').addEventListener('change', onModelChange);
  $('model').addEventListener('input', () => {
    current.model = readModel();
    const activeModel = current.model;
    if (activeModel) {
      if (!current.modelRpms) current.modelRpms = {};
      current.modelRpms[activeModel] = current.rpm;
    }
    persist();
  });

  $('geminiModelSelect').addEventListener('change', onGeminiModelChange);
  $('geminiModel').addEventListener('input', () => {
    current.geminiModel = readGeminiModel();
    const activeModel = current.geminiModel;
    if (activeModel) {
      if (!current.modelRpms) current.modelRpms = {};
      current.modelRpms[activeModel] = current.rpm;
    }
    persist();
  });

  $('grokModelSelect').addEventListener('change', onGrokModelChange);
  $('grokModel').addEventListener('input', () => {
    current.grokModel = readGrokModel();
    const activeModel = current.grokModel;
    if (activeModel) {
      if (!current.modelRpms) current.modelRpms = {};
      current.modelRpms[activeModel] = current.rpm;
    }
    persist();
  });

  $('deepseekModelSelect').addEventListener('change', onDeepseekModelChange);
  $('deepseekModel').addEventListener('input', () => {
    current.deepseekModel = readDeepseekModel();
    const activeModel = current.deepseekModel;
    if (activeModel) {
      if (!current.modelRpms) current.modelRpms = {};
      current.modelRpms[activeModel] = current.rpm;
    }
    persist();
  });

  $('openaiModelSelect').addEventListener('change', onOpenaiModelChange);
  $('openaiModel').addEventListener('input', () => {
    current.openaiModel = readOpenaiModel();
    const activeModel = current.openaiModel;
    if (activeModel) {
      if (!current.modelRpms) current.modelRpms = {};
      current.modelRpms[activeModel] = current.rpm;
    }
    persist();
  });

  $('provider').addEventListener('change', (e) => {
    // RPM update is handled inside onChange (fires before this listener).
    // We only need to refresh the provider-specific UI sections here.
    toggleProviderSections(e.target.value);
  });

  $('test').addEventListener('click', testKey);
  $('testGemini').addEventListener('click', testGeminiKey);
  $('testGrok').addEventListener('click', testGrokKey);
  $('testDeepseek').addEventListener('click', testDeepseekKey);
  $('testOpenai').addEventListener('click', testOpenaiKey);

  $('reset').addEventListener('click', () => {
    hydrate(DEFAULTS);
    persist();
  });
  $('apply').addEventListener('click', applyToVideo);
});

/* Force the open YouTube tab to re-read settings and re-render now. */
async function applyToVideo() {
  const btn = $('apply');
  persist(); // make sure latest values are saved first
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/www\.youtube\.com\//.test(tab.url || '')) {
      btn.textContent = 'یک تب یوتیوب باز کنید';
      setTimeout(() => (btn.textContent = 'اعمال روی ویدئو'), 1800);
      return;
    }
    await chrome.tabs.sendMessage(tab.id, { type: 'APPLY' });
    btn.classList.add('applied');
    btn.textContent = 'اعمال شد ✓';
    setTimeout(() => {
      btn.classList.remove('applied');
      btn.textContent = 'اعمال روی ویدئو';
    }, 1500);
  } catch (e) {
    btn.textContent = 'صفحه‌ی یوتیوب را تازه کنید';
    setTimeout(() => (btn.textContent = 'اعمال روی ویدئو'), 1800);
  }
}
