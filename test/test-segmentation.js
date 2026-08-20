/*
 * test-segmentation.js — Unit tests for the Smart Subtitle Segmentation Engine.
 *
 * Run with:  node test/test-segmentation.js
 *
 * We extract and test the pure functions independently without needing
 * a browser environment or Chrome extension APIs.
 */

// ────────────── Inline copy of segmentation functions ──────────────

const SEG_CONFIG = {
  MERGE_MIN_WORDS: 3,
  MERGE_MAX_GAP_SEC: 1.5,
  MERGE_MAX_WORDS: 15,
  MERGE_MAX_CHARS: 120,
  MERGE_SHORT_DUR_SEC: 1.5,
  SPLIT_MIN_WORDS: 15,
  SPLIT_MIN_CHARS: 120,
  SPLIT_PART_MIN_WORDS: 3,
  MIN_DURATION_SEC: 1.8,
  MAX_DURATION_SEC: 8.0,
};

function wordCount(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).length;
}

function mergeTinyFragments(cues) {
  if (!cues.length) return [];
  const { MERGE_MIN_WORDS, MERGE_MAX_GAP_SEC, MERGE_MAX_WORDS, MERGE_MAX_CHARS, MERGE_SHORT_DUR_SEC } = SEG_CONFIG;
  const merged = [];
  let buf = null;

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
      buf = { start: cue.start, end: cue.end, text: cue.text };
      if (!isTiny) flush();
      continue;
    }

    const gap = cue.start - buf.end;
    const combinedText = buf.text + ' ' + cue.text;
    const combinedWords = wordCount(combinedText);
    const combinedChars = combinedText.length;
    const canMerge = gap <= MERGE_MAX_GAP_SEC && combinedWords <= MERGE_MAX_WORDS && combinedChars <= MERGE_MAX_CHARS;

    if (isTiny && canMerge) {
      buf.text = combinedText;
      buf.end = cue.end;
    } else if (!isTiny && canMerge && wordCount(buf.text) < MERGE_MIN_WORDS) {
      buf.text = combinedText;
      buf.end = cue.end;
      flush();
    } else {
      flush();
      buf = { start: cue.start, end: cue.end, text: cue.text };
      if (!isTiny) flush();
    }
  }
  flush();
  return merged;
}

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
    const parts = findBestSplit(cue.text, SPLIT_PART_MIN_WORDS, SPLIT_MIN_WORDS);
    if (parts.length <= 1) {
      result.push(cue);
      continue;
    }
    const totalChars = parts.reduce((sum, p) => sum + p.length, 0);
    const totalDur = cue.end - cue.start;
    let elapsed = cue.start;
    for (let i = 0; i < parts.length; i++) {
      const partDur = totalDur * (parts[i].length / totalChars);
      const partStart = elapsed;
      const partEnd = i === parts.length - 1 ? cue.end : elapsed + partDur;
      result.push({ start: partStart, end: partEnd, text: parts[i].trim(), fa: '', phrases: [] });
      elapsed = partEnd;
    }
  }
  return result;
}

function findBestSplit(text, minWordsPerPart, targetMaxWords) {
  const tiers = [/[.!?]+\s+/g, /[;\u2014\u2013]+\s+/g, /,\s+/g, /:\s+/g];
  for (const pattern of tiers) {
    const parts = trySplitAt(text, pattern, minWordsPerPart, targetMaxWords);
    if (parts && parts.length > 1) return parts;
  }
  return [text];
}

function trySplitAt(text, pattern, minWordsPerPart, targetMaxWords) {
  const positions = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    positions.push(match.index + match[0].length);
  }
  if (!positions.length) return null;

  let bestParts = null;
  let bestScore = Infinity;

  for (const pos of positions) {
    const left = text.slice(0, pos).trim();
    const right = text.slice(pos).trim();
    if (!left || !right) continue;
    const leftWc = wordCount(left);
    const rightWc = wordCount(right);
    if (leftWc < minWordsPerPart || rightWc < minWordsPerPart) continue;
    const score = Math.abs(leftWc - rightWc);
    const bothUnderTarget = leftWc <= targetMaxWords && rightWc <= targetMaxWords;
    if (bothUnderTarget && score < bestScore) {
      bestScore = score;
      bestParts = [left, right];
    }
  }

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

function enforceTimingConstraints(cues) {
  if (!cues.length) return [];
  const { MIN_DURATION_SEC, MAX_DURATION_SEC } = SEG_CONFIG;
  const result = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = { ...cues[i] };
    let dur = cue.end - cue.start;
    if (dur < MIN_DURATION_SEC) {
      const desiredEnd = cue.start + MIN_DURATION_SEC;
      const nextStart = (i + 1 < cues.length) ? cues[i + 1].start : Infinity;
      cue.end = Math.min(desiredEnd, nextStart);
    }
    dur = cue.end - cue.start;
    if (dur > MAX_DURATION_SEC) {
      cue.end = cue.start + MAX_DURATION_SEC;
    }
    result.push(cue);
  }
  return result;
}

function segmentCuesIntelligently(rawCues) {
  if (!rawCues || !rawCues.length) return rawCues;
  const merged = mergeTinyFragments(rawCues);
  const split = splitOversizedCues(merged);
  const final = enforceTimingConstraints(split);
  return final;
}

// ────────────── Test Helpers ──────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  \u2705 ${message}`);
  } else {
    failed++;
    console.error(`  \u274C FAIL: ${message}`);
  }
}

function makeCue(start, end, text) {
  return { start, end, text, fa: '', phrases: [] };
}

// ────────────── Tests ──────────────

console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
console.log('  Smart Subtitle Segmentation \u2014 Unit Tests');
console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n');

// -- wordCount --
console.log('\u25B8 wordCount()');
assert(wordCount('') === 0, 'empty string \u2192 0');
assert(wordCount('hello') === 1, 'single word \u2192 1');
assert(wordCount('hello world') === 2, 'two words \u2192 2');
assert(wordCount('  spaced   out   words  ') === 3, 'extra whitespace \u2192 3');
assert(wordCount(null) === 0, 'null \u2192 0');

// -- mergeTinyFragments --
console.log('\n\u25B8 mergeTinyFragments()');

// Test 1: Five single-word cues merge into fewer
const tinyCues = [
  makeCue(0.0, 0.5, 'the'),
  makeCue(0.5, 1.0, 'quick'),
  makeCue(1.0, 1.5, 'brown'),
  makeCue(1.5, 2.0, 'fox'),
  makeCue(2.0, 2.5, 'jumps'),
];
const mergedTiny = mergeTinyFragments(tinyCues);
assert(mergedTiny.length < tinyCues.length, `5 single-word cues \u2192 ${mergedTiny.length} merged cue(s) (less than 5)`);
assert(mergedTiny[0].text.includes('the'), 'merged text contains "the"');
assert(mergedTiny[mergedTiny.length - 1].text.includes('jumps'), 'merged text contains "jumps"');

// Test 2: Already-large cues don't merge
const largeCues = [
  makeCue(0, 3, 'This is a complete sentence with many words in it'),
  makeCue(3, 6, 'Another complete sentence that should stay separate'),
];
const mergedLarge = mergeTinyFragments(largeCues);
assert(mergedLarge.length === 2, 'two large cues stay as 2 separate cues');

// Test 3: Tiny + large merge when buffer is tiny
const mixedCues = [
  makeCue(0, 0.5, 'So'),
  makeCue(0.5, 4, 'this is the main sentence of the video'),
];
const mergedMixed = mergeTinyFragments(mixedCues);
assert(mergedMixed.length === 1, 'tiny "So" merges into the following sentence');
assert(mergedMixed[0].text.includes('So') && mergedMixed[0].text.includes('main sentence'), 'merged text has both parts');

// Test 4: Gap too large prevents merge
const gapCues = [
  makeCue(0, 0.5, 'hi'),
  makeCue(5, 6, 'there is a big gap here and this should not merge'),
];
const mergedGap = mergeTinyFragments(gapCues);
assert(mergedGap.length === 2, 'cues with large time gap remain separate');

// Test 5: Empty input
const mergedEmpty = mergeTinyFragments([]);
assert(mergedEmpty.length === 0, 'empty input \u2192 empty output');

// Test 6: Timing preservation
const timingCues = [
  makeCue(10.0, 10.4, 'and'),
  makeCue(10.4, 10.9, 'then'),
  makeCue(10.9, 11.5, 'he'),
  makeCue(11.5, 13.0, 'walked away from the building'),
];
const mergedTiming = mergeTinyFragments(timingCues);
assert(mergedTiming.length >= 1, `timing cues merged to ${mergedTiming.length} cue(s)`);
assert(mergedTiming[0].start === 10.0, 'merged start time preserved from first cue');
assert(mergedTiming[mergedTiming.length - 1].end === 13.0, 'merged end time preserved from last cue');

// -- splitOversizedCues --
console.log('\n\u25B8 splitOversizedCues()');

// Test 1: Long sentence with period splits
const longCue = makeCue(0, 10, 'The quick brown fox jumped over the lazy dog. And then the cat came running after them with great speed.');
const splitLong = splitOversizedCues([longCue]);
assert(splitLong.length === 2, `long sentence with period \u2192 ${splitLong.length} parts (expected 2)`);
if (splitLong.length === 2) {
  assert(splitLong[0].text.includes('fox'), 'first part has fox sentence');
  assert(splitLong[1].text.includes('cat'), 'second part has cat sentence');
  assert(Math.abs(splitLong[0].end - splitLong[1].start) < 0.001, 'timing is continuous');
  assert(splitLong[1].end === 10, 'last part ends at original end');
}

// Test 2: Normal-sized cue stays as-is
const normalCue = makeCue(0, 3, 'This is fine');
const splitNormal = splitOversizedCues([normalCue]);
assert(splitNormal.length === 1, 'normal cue stays as single cue');
assert(splitNormal[0].text === 'This is fine', 'text unchanged');

// Test 3: Long cue without punctuation stays as-is
const noPuncCue = makeCue(0, 8, 'word '.repeat(20).trim());
const splitNoPunc = splitOversizedCues([noPuncCue]);
assert(splitNoPunc.length === 1, 'long cue without punctuation stays as 1 (cannot split)');

// Test 4: Split with question mark
const questionCue = makeCue(0, 8, 'Have you ever wondered what happens when we look at the stars? I think about it every single night before sleeping.');
const splitQuestion = splitOversizedCues([questionCue]);
assert(splitQuestion.length === 2, `question+statement \u2192 ${splitQuestion.length} parts (expected 2)`);

// -- enforceTimingConstraints --
console.log('\n\u25B8 enforceTimingConstraints()');

// Test 1: Short cue gets extended
const shortCue = makeCue(5.0, 5.5, 'hello world there');
const timedShort = enforceTimingConstraints([shortCue]);
assert(timedShort[0].end - timedShort[0].start >= SEG_CONFIG.MIN_DURATION_SEC - 0.01,
  `0.5s cue extended to \u2265 ${SEG_CONFIG.MIN_DURATION_SEC}s (got ${(timedShort[0].end - timedShort[0].start).toFixed(3)}s)`);

// Test 2: Long cue gets trimmed
const longDurCue = makeCue(0, 15, 'very long duration cue');
const timedLong = enforceTimingConstraints([longDurCue]);
assert(timedLong[0].end - timedLong[0].start <= SEG_CONFIG.MAX_DURATION_SEC,
  `15s cue trimmed to \u2264 ${SEG_CONFIG.MAX_DURATION_SEC}s`);

// Test 3: No overlap with next cue
const overlapCues = [
  makeCue(0, 0.3, 'short'),
  makeCue(0.5, 3, 'next cue starts at half second'),
];
const timedOverlap = enforceTimingConstraints(overlapCues);
assert(timedOverlap[0].end <= timedOverlap[1].start,
  'extended cue does not overlap next cue');

// Test 4: Normal duration unchanged
const normalDurCue = makeCue(0, 3, 'perfect timing');
const timedNormal = enforceTimingConstraints([normalDurCue]);
assert(timedNormal[0].start === 0 && timedNormal[0].end === 3, 'normal 3s cue unchanged');

// -- Full Pipeline: segmentCuesIntelligently --
console.log('\n\u25B8 segmentCuesIntelligently() \u2014 Full Pipeline');

// Test 1: Realistic YouTube ASR scenario (fragmented words)
const asrCues = [
  makeCue(0.0, 0.3, 'so'),
  makeCue(0.3, 0.6, 'today'),
  makeCue(0.6, 1.0, "we're"),
  makeCue(1.0, 1.3, 'going'),
  makeCue(1.3, 1.5, 'to'),
  makeCue(1.5, 1.8, 'talk'),
  makeCue(1.8, 2.0, 'about'),
  makeCue(2.0, 2.5, 'something'),
  makeCue(2.5, 3.2, 'really'),
  makeCue(3.2, 4.0, 'important'),
];
const segmented = segmentCuesIntelligently(asrCues);
assert(segmented.length < asrCues.length, `10 ASR fragments \u2192 ${segmented.length} readable cue(s)`);
assert(segmented.every(c => wordCount(c.text) >= 2), 'all cues have \u2265 2 words');
assert(segmented.every(c => (c.end - c.start) >= 1.0), 'all cues display \u2265 1 second');

// Test 2: Mixed tiny and normal
const mixedPipeline = [
  makeCue(0, 0.5, 'um'),
  makeCue(0.5, 3, 'I think the best way to learn programming is to practice'),
  makeCue(3, 3.3, 'you'),
  makeCue(3.3, 3.5, 'know'),
  makeCue(3.5, 6, 'building real projects is much better than reading books'),
];
const segMixed = segmentCuesIntelligently(mixedPipeline);
assert(segMixed.length <= 3, `mixed cues \u2192 ${segMixed.length} cue(s) (expected \u2264 3)`);

// Test 3: Already well-segmented cues (manual captions)
const manualCues = [
  makeCue(0, 3, 'Welcome to this course on machine learning'),
  makeCue(3, 6, 'Today we will cover the basics of neural networks'),
  makeCue(6, 9, 'Let us start with the concept of perceptrons'),
];
const segManual = segmentCuesIntelligently(manualCues);
assert(segManual.length === 3, 'well-segmented manual cues stay as 3');
assert(segManual[0].text === manualCues[0].text, 'first cue text preserved');
assert(segManual[2].text === manualCues[2].text, 'last cue text preserved');

// Test 4: Edge case single cue
const singleCue = [makeCue(0, 5, 'Hello world')];
const segSingle = segmentCuesIntelligently(singleCue);
assert(segSingle.length === 1, 'single cue stays as 1');

// Test 5: Edge case empty
const segEmpty = segmentCuesIntelligently([]);
assert(segEmpty.length === 0, 'empty input \u2192 empty output');

// Test 6: Timing integrity no overlaps in final output
const stressCues = [];
for (let t = 0; t < 60; t += 0.5) {
  const words = ['hello', 'world', 'how', 'are', 'you', 'doing', 'today'];
  stressCues.push(makeCue(t, t + 0.5, words[Math.floor(Math.random() * words.length)]));
}
const segStress = segmentCuesIntelligently(stressCues);
let hasOverlap = false;
for (let i = 0; i < segStress.length - 1; i++) {
  if (segStress[i].end > segStress[i + 1].start + 0.001) {
    hasOverlap = true;
    console.error(`    Overlap at index ${i}: end=${segStress[i].end} > nextStart=${segStress[i + 1].start}`);
    break;
  }
}
assert(!hasOverlap, `stress test (120 single-word cues) \u2192 ${segStress.length} cues, no overlaps`);
assert(segStress.every(c => (c.end - c.start) >= SEG_CONFIG.MIN_DURATION_SEC - 0.01),
  'stress test: all cues meet minimum duration');

// Test 7: All cues have valid structure
assert(segStress.every(c =>
  typeof c.start === 'number' &&
  typeof c.end === 'number' &&
  typeof c.text === 'string' &&
  c.end >= c.start &&
  c.text.trim().length > 0
), 'stress test: all cues have valid structure (start, end, text)');


// ────────────── Summary ──────────────

console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n');

process.exit(failed > 0 ? 1 : 0);
