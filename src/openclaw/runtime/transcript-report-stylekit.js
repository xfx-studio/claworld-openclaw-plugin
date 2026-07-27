const FULL_WIDTH_RANGES = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3040, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f250, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

const SCRIPT_RANGES = Object.freeze({
  devanagari: [[0x0900, 0x097f], [0xa8e0, 0xa8ff]],
  bengali: [[0x0980, 0x09ff]],
  gurmukhi: [[0x0a00, 0x0a7f]],
  gujarati: [[0x0a80, 0x0aff]],
  tamil: [[0x0b80, 0x0bff]],
  telugu: [[0x0c00, 0x0c7f]],
  kannada: [[0x0c80, 0x0cff]],
  malayalam: [[0x0d00, 0x0d7f]],
  thai: [[0x0e00, 0x0e7f]],
  lao: [[0x0e80, 0x0eff]],
  myanmar: [[0x1000, 0x109f], [0xaa60, 0xaa7f], [0xa9e0, 0xa9ff]],
  ethiopic: [[0x1200, 0x137f], [0x1380, 0x139f], [0x2d80, 0x2ddf]],
  khmer: [[0x1780, 0x17ff], [0x19e0, 0x19ff]],
  hebrew: [[0x0590, 0x05ff]],
  arabic: [[0x0600, 0x06ff], [0x0750, 0x077f], [0x08a0, 0x08ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff]],
  japanese: [[0x3040, 0x30ff], [0x31f0, 0x31ff]],
  korean: [[0x1100, 0x11ff], [0x3130, 0x318f], [0xac00, 0xd7af]],
  cjk: [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff]],
});

// Conservative em-width budgets for shaped Letter_Other glyphs. These are
// intentionally script-specific: a few independent vowels and compatibility
// ligatures are much wider than the ordinary letters in the same font.
const SCRIPT_LETTER_UNITS = Object.freeze({
  devanagari: 1.3,
  bengali: 1.35,
  gurmukhi: 1.8,
  gujarati: 1.4,
  tamil: 2.5,
  telugu: 2.1,
  kannada: 2,
  malayalam: 1.8,
  thai: 1.1,
  lao: 1.15,
  myanmar: 2.3,
  ethiopic: 1.7,
  khmer: 1.45,
  hebrew: 0.9,
  arabic: 1.15,
});

const SYSTEM_SYMBOL_FONT_FAMILIES = [
  'Segoe UI Symbol',
  'Noto Sans Symbols 2',
  'Noto Sans Symbols',
  'Apple Symbols',
  'Symbola',
];

const SYSTEM_UI_FONT_FAMILIES = [
  'PingFang SC',
  'Microsoft YaHei UI',
  'Microsoft YaHei',
  'Noto Sans CJK SC',
  'Noto Sans SC',
  'Source Han Sans SC',
  'Hiragino Sans GB',
  'Yu Gothic UI',
  'Yu Gothic',
  'Meiryo',
  'Hiragino Kaku Gothic ProN',
  'Apple SD Gothic Neo',
  'Malgun Gothic',
  'Noto Sans CJK JP',
  'Noto Sans CJK KR',
  'Noto Sans CJK TC',
  'Noto Sans CJK HK',
  'Noto Sans',
  'Segoe UI',
  'SF Pro Text',
  'Arial',
  'Noto Sans Arabic',
  'Noto Sans Hebrew',
  'Noto Sans Devanagari',
  'Noto Sans Bengali',
  'Noto Sans Gurmukhi',
  'Noto Sans Gujarati',
  'Noto Sans Tamil',
  'Noto Sans Telugu',
  'Noto Sans Kannada',
  'Noto Sans Malayalam',
  'Noto Sans Thai',
  'Noto Sans Lao',
  'Noto Sans Khmer',
  'Noto Sans Myanmar',
  'Noto Sans Ethiopic',
];

const SCRIPT_FONT_FAMILIES = Object.freeze({
  arabic: ['Noto Sans Arabic', 'Geeza Pro', 'Segoe UI', 'Tahoma', 'Arial'],
  hebrew: ['Noto Sans Hebrew', 'Arial Hebrew', 'Segoe UI', 'Arial'],
  devanagari: ['Noto Sans Devanagari', 'Kohinoor Devanagari', 'Nirmala UI', 'Mangal'],
  bengali: ['Noto Sans Bengali', 'Kohinoor Bangla', 'Nirmala UI', 'Vrinda'],
  gurmukhi: ['Noto Sans Gurmukhi', 'Kohinoor Gurmukhi', 'Nirmala UI', 'Raavi'],
  gujarati: ['Noto Sans Gujarati', 'Nirmala UI', 'Shruti'],
  tamil: ['Noto Sans Tamil', 'Tamil Sangam MN', 'Nirmala UI', 'Latha'],
  telugu: ['Noto Sans Telugu', 'Kohinoor Telugu', 'Nirmala UI', 'Gautami'],
  kannada: ['Noto Sans Kannada', 'Nirmala UI', 'Tunga'],
  malayalam: ['Noto Sans Malayalam', 'Nirmala UI', 'Kartika'],
  thai: ['Noto Sans Thai', 'Thonburi', 'Leelawadee UI', 'Tahoma'],
  lao: ['Noto Sans Lao', 'Lao Sangam MN', 'Leelawadee UI', 'DokChampa'],
  khmer: ['Noto Sans Khmer', 'Khmer Sangam MN', 'Leelawadee UI', 'DaunPenh'],
  myanmar: ['Noto Sans Myanmar', 'Myanmar Sangam MN', 'Myanmar Text'],
  ethiopic: ['Noto Sans Ethiopic', 'Kefa', 'Nyala'],
  japanese: ['Hiragino Kaku Gothic ProN', 'Yu Gothic UI', 'Yu Gothic', 'Meiryo', 'Noto Sans CJK JP'],
  korean: ['Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans CJK KR'],
  cjk: ['PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', 'Hiragino Sans GB'],
});

const EMOJI_CODEPOINTS = new Set([
  0x23f0, 0x23f3, 0x2614, 0x2615, 0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab,
  0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3,
  0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e,
  0x2757, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55,
]);

export const SYMBOL_INLINE_UNITS = 1;

const graphemeSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

function quotedFontFamily(families) {
  return [...new Set(families)].map((family) => `'${family}'`).join(', ') + ', sans-serif';
}

function inRanges(codePoint, ranges) {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function isFullWidthCharacter(character) {
  return inRanges(character.codePointAt(0) || 0, FULL_WIDTH_RANGES);
}

function isCombiningCharacter(character) {
  const codePoint = character.codePointAt(0) || 0;
  return codePoint === 0x200c
    || codePoint === 0x200d
    || codePoint === 0xfe0e
    || codePoint === 0xfe0f
    || /\p{Mark}/u.test(character);
}

function isRegionalIndicator(codePoint) {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function isEmojiModifier(codePoint) {
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

function isEmojiCodePoint(codePoint) {
  if (codePoint >= 0x1f000 && codePoint <= 0x1faff) return true;
  if (inRanges(codePoint, [
    [0x231a, 0x231b], [0x23e9, 0x23ec], [0x25fd, 0x25fe], [0x2648, 0x2653],
    [0x2753, 0x2755], [0x2795, 0x2797],
  ])) return true;
  return EMOJI_CODEPOINTS.has(codePoint);
}

export function escapeXml(value) {
  const xmlSafe = [...String(value ?? '')].filter((character) => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint === 0x09
      || codePoint === 0x0a
      || codePoint === 0x0d
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
  }).join('');
  return xmlSafe
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

export function fontFamily() {
  return quotedFontFamily(SYSTEM_UI_FONT_FAMILIES);
}

export function fontFamilyForScript(script) {
  if (script === 'symbol') {
    return quotedFontFamily([...SYSTEM_SYMBOL_FONT_FAMILIES, ...SYSTEM_UI_FONT_FAMILIES]);
  }
  return quotedFontFamily([...(SCRIPT_FONT_FAMILIES[script] || []), ...SYSTEM_UI_FONT_FAMILIES]);
}

export function textScript(text) {
  const codePoints = [...String(text ?? '')].map((character) => character.codePointAt(0) || 0);
  const counts = Object.fromEntries(Object.entries(SCRIPT_RANGES).map(([script, ranges]) => [
    script,
    codePoints.filter((codePoint) => inRanges(codePoint, ranges)).length,
  ]));
  if (counts.japanese) return 'japanese';
  if (counts.korean) return 'korean';
  const [script, count] = Object.entries(counts).reduce(
    (best, current) => (current[1] > best[1] ? current : best),
    ['default', 0],
  );
  return count ? script : 'default';
}

export function graphemeClusters(text) {
  const value = String(text ?? '');
  if (graphemeSegmenter) {
    return [...graphemeSegmenter.segment(value)].map(({ segment }) => segment);
  }
  return [...value];
}

export function isEmojiCluster(cluster) {
  const codePoints = [...String(cluster ?? '')].map((character) => character.codePointAt(0) || 0);
  if (!codePoints.length || (codePoints.includes(0xfe0e) && !codePoints.includes(0xfe0f))) return false;
  if (codePoints.some((codePoint) => codePoint === 0xfe0f
    || isEmojiModifier(codePoint)
    || isRegionalIndicator(codePoint)
    || (codePoint >= 0xe0020 && codePoint <= 0xe007f))) return true;
  if (codePoints.includes(0x200d) && codePoints.some(isEmojiCodePoint)) return true;
  if (codePoints.includes(0x20e3)) return true;
  return codePoints.some(isEmojiCodePoint);
}

export function omitEmoji(value) {
  const input = String(value ?? '');
  const clusters = graphemeClusters(input);
  if (!clusters.some(isEmojiCluster)) return input;
  return clusters
    .filter((cluster) => !isEmojiCluster(cluster))
    .join('')
    .replace(/[^\S\r\n]{2,}/gu, ' ')
    .replace(/[^\S\r\n]*\r?\n(?:[^\S\r\n]*\r?\n)+[^\S\r\n]*/gu, '\n')
    .trim();
}

export function isTextSymbolCluster(cluster) {
  const value = String(cluster ?? '');
  if (!value || isEmojiCluster(value)) return false;
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint >= 0x2000 && codePoint <= 0x2bff && /\p{So}/u.test(character);
  });
}

export function textRuns(text) {
  const runs = [];
  let normal = '';
  const flushNormal = () => {
    if (!normal) return;
    runs.push([normal, textScript(normal)]);
    normal = '';
  };
  for (const cluster of graphemeClusters(omitEmoji(text))) {
    const specialScript = isTextSymbolCluster(cluster) ? 'symbol' : '';
    if (!specialScript) {
      normal += cluster;
      continue;
    }
    flushNormal();
    if (runs.at(-1)?.[1] === specialScript) runs.at(-1)[0] += cluster;
    else runs.push([cluster, specialScript]);
  }
  flushNormal();
  return runs.length ? runs : [['', 'default']];
}

export function fontCssRules(texts) {
  const scripts = [...new Set((texts || []).flatMap((value) => textRuns(value).map(([, script]) => script)))];
  return scripts.map((script) => `.font-${script} { font-family: ${fontFamilyForScript(script)}; }`).join(' ');
}

export function charUnits(character) {
  if (character === '\n' || isCombiningCharacter(character)) return 0;
  if (/\s/u.test(character)) return 0.35;
  if (isFullWidthCharacter(character)) return 1;
  if (character === 'W') return 0.96;
  if (character === 'M') return 0.9;
  if (character === 'm') return 0.96;
  if (character === 'w') return 0.86;
  if ('Iilj'.includes(character)) return 0.32;
  if ('ft'.includes(character)) return 0.46;
  if (character === 'r') return 0.48;
  if ('csyz'.includes(character)) return 0.56;
  if (/\p{Lu}/u.test(character)) return 0.74;
  if (/\p{Ll}/u.test(character)) return 0.64;
  if (/\p{Nd}/u.test(character)) return 0.62;
  if (/\p{Lo}/u.test(character)) {
    const codePoint = character.codePointAt(0) || 0;
    if (inRanges(codePoint, [[0xfb50, 0xfdff], [0xfe70, 0xfeff]])) return 2.8;
    for (const [script, units] of Object.entries(SCRIPT_LETTER_UNITS)) {
      if (inRanges(codePoint, SCRIPT_RANGES[script])) return units;
    }
    return 1.2;
  }
  return 0.62;
}

export function clusterUnits(cluster) {
  if (isEmojiCluster(cluster)) return 0;
  if (isTextSymbolCluster(cluster)) return SYMBOL_INLINE_UNITS;
  return [...String(cluster ?? '')].reduce((total, character) => total + charUnits(character), 0);
}

export function textUnits(text) {
  return graphemeClusters(omitEmoji(text))
    .reduce((total, cluster) => total + clusterUnits(cluster), 0);
}

export function clusterCols(cluster) {
  if (isEmojiCluster(cluster)) return 0;
  return [...String(cluster ?? '')].reduce((total, character) => {
    if (character === '\n' || isCombiningCharacter(character)) return total;
    return total + (isFullWidthCharacter(character) ? 2 : 1);
  }, 0);
}

export function displayCols(text) {
  return graphemeClusters(omitEmoji(text))
    .reduce((total, cluster) => total + clusterCols(cluster), 0);
}

export function wrapTokens(paragraph) {
  const tokens = [];
  let current = '';
  const flush = () => {
    if (!current) return;
    tokens.push(current);
    current = '';
  };
  for (const cluster of graphemeClusters(omitEmoji(paragraph))) {
    if (/^\s+$/u.test(cluster)) {
      flush();
      tokens.push(' ');
    } else if (clusterCols(cluster) >= 2) {
      flush();
      tokens.push(cluster);
    } else {
      current += cluster;
    }
  }
  flush();
  return tokens;
}

export function wrapText(text, maxUnits) {
  const lines = [];
  for (const paragraph of omitEmoji(text).split(/\r?\n/)) {
    let current = '';
    let currentUnits = 0;
    for (const token of wrapTokens(paragraph)) {
      if (/^\s+$/u.test(token)) {
        const tokenUnits = textUnits(token);
        if (current && currentUnits + tokenUnits <= maxUnits) {
          current += token;
          currentUnits += tokenUnits;
        }
        continue;
      }
      const tokenUnits = textUnits(token);
      if (current && currentUnits + tokenUnits > maxUnits) {
        lines.push(current.trimEnd());
        current = '';
        currentUnits = 0;
      }
      if (tokenUnits > maxUnits) {
        for (const cluster of graphemeClusters(token)) {
          const units = clusterUnits(cluster);
          if (current && currentUnits + units > maxUnits) {
            lines.push(current.trimEnd());
            current = '';
            currentUnits = 0;
          }
          current += cluster;
          currentUnits += units;
        }
      } else {
        current += token;
        currentUnits += tokenUnits;
      }
    }
    if (current || lines.length === 0) lines.push(current.trimEnd());
  }
  return lines;
}

export function ellipsizeText(text, maxUnits, suffix = '...') {
  const value = omitEmoji(text);
  if (textUnits(value) <= maxUnits) return value;
  const allowed = Math.max(0, maxUnits - textUnits(suffix));
  let kept = '';
  let used = 0;
  for (const cluster of graphemeClusters(value)) {
    const units = clusterUnits(cluster);
    if (used + units > allowed) break;
    kept += cluster;
    used += units;
  }
  return `${kept.trimEnd()}${suffix}`;
}

export function clipDisplay(text, maxCols) {
  const value = omitEmoji(text);
  if (displayCols(value) <= maxCols) return value;
  const suffix = '...';
  const target = Math.max(0, maxCols - suffix.length);
  let kept = '';
  let used = 0;
  for (const cluster of graphemeClusters(value)) {
    const cols = clusterCols(cluster);
    if (used + cols > target) break;
    kept += cluster;
    used += cols;
  }
  return `${kept.trimEnd()}${suffix}`;
}
