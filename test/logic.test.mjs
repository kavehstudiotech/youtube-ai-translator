/* Stand-alone tests for the pure logic used in the extension. Run with: node test/logic.test.mjs */

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, '\n     got :', g, '\n     want:', w); }
}

/* ---- copies of the pure functions under test ---- */

function parseTranslations(content, expected) {
  let cleaned = content.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { const arr = JSON.parse(cleaned); if (Array.isArray(arr)) return arr.map(String); } catch (_) {}
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (match) { try { const arr = JSON.parse(match[0]); if (Array.isArray(arr)) return arr.map(String); } catch (_) {} }
  const lines = cleaned.split('\n').map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim()).filter((l) => l.length);
  if (lines.length >= expected) return lines.slice(0, expected);
  return lines;
}

function parseJson3(data) {
  const events = data.events || [];
  const cues = [];
  for (const ev of events) {
    if (!ev.segs) continue;
    const text = ev.segs.map((s) => s.utf8).join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = (ev.tStartMs || 0) / 1000;
    const dur = (ev.dDurationMs || 0) / 1000;
    cues.push({ start, end: start + (dur || 4), text, fa: '' });
  }
  return cues;
}

function hexToRgba(hex, alpha) {
  const m = hex.replace('#', '');
  const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m.padEnd(6, '0').slice(0, 6);
  const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function findCue(cues, t) {
  let lo = 0, hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < cues[mid].start) hi = mid - 1;
    else if (t >= cues[mid].end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/* ---- tests ---- */

console.log('parseTranslations:');
eq('strict JSON array', parseTranslations('["سلام","خوبی"]', 2), ['سلام', 'خوبی']);
eq('fenced json', parseTranslations('```json\n["یک","دو"]\n```', 2), ['یک', 'دو']);
eq('array with prose around', parseTranslations('Sure!\n["a","b","c"]\nDone.', 3), ['a', 'b', 'c']);
eq('numbered-line fallback', parseTranslations('1. اول\n2. دوم\n3. سوم', 3), ['اول', 'دوم', 'سوم']);
eq('paren-numbered fallback', parseTranslations('1) خط یک\n2) خط دو', 2), ['خط یک', 'خط دو']);

console.log('parseJson3:');
const sample = {
  events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
    { tStartMs: 2000, dDurationMs: 1500, segs: [{ utf8: '\n' }] }, // whitespace only -> skipped
    { tStartMs: 3500, segs: [{ utf8: 'No duration' }] },           // missing dur -> +4s
    { tStartMs: 5000, dDurationMs: 1000 },                          // no segs -> skipped
  ],
};
const cues = parseJson3(sample);
eq('cue count (blanks skipped)', cues.length, 2);
eq('first cue text joined+trimmed', cues[0].text, 'Hello world');
eq('first cue timing', [cues[0].start, cues[0].end], [0, 2]);
eq('missing-duration default +4s', [cues[1].start, cues[1].end], [3.5, 7.5]);

console.log('hexToRgba:');
eq('6-digit', hexToRgba('#000000', 0.55), 'rgba(0, 0, 0, 0.55)');
eq('3-digit shorthand', hexToRgba('#fff', 1), 'rgba(255, 255, 255, 1)');
eq('accent', hexToRgba('#ff0033', 0.6), 'rgba(255, 0, 51, 0.6)');

console.log('findCue (binary search):');
const tl = [
  { start: 0, end: 2 }, { start: 2, end: 4 }, { start: 4, end: 6 }, { start: 8, end: 10 },
];
eq('inside first', findCue(tl, 1), 0);
eq('boundary belongs to next', findCue(tl, 2), 1);
eq('inside third', findCue(tl, 5.9), 2);
eq('gap returns -1', findCue(tl, 7), -1);
eq('inside last', findCue(tl, 9), 3);
eq('after end -1', findCue(tl, 99), -1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
