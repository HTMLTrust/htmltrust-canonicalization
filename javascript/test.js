import { normalizeText } from './index.js';

const tests = [
  // [inputA, inputB, shouldMatch, description]
  ['\u201CHello\u201D', '"Hello"', true, 'Curly double quotes → straight'],
  ['caf\u00E9', 'cafe\u0301', true, 'Precomposed vs combining (NFKC)'],
  ['\uFB01nd', 'find', true, 'fi ligature (NFKC)'],
  ['word \u2014 word', 'word - word', true, 'Em dash → hyphen-minus'],
  ['\u00ABBonjour\u00BB', '"Bonjour"', true, 'Guillemets → double quotes'],
  ['\u300C\u6771\u4EAC\u300D', '"\u6771\u4EAC"', true, 'CJK corner brackets → double quotes'],
  ['\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645', '\u0645\u06CC\u062E\u0648\u0627\u0647\u0645', false, 'ZWNJ is semantic (Persian)'],
  ['\u0643\u062A\u0640\u0640\u0640\u0627\u0628', '\u0643\u062A\u0627\u0628', true, 'Arabic tatweel stripped'],
  ['\uFF21\uFF11', 'A1', true, 'Fullwidth ASCII (NFKC)'],
  ['\u2460', '1', true, 'Circled digit (NFKC)'],
  ['word\u200Bword', 'wordword', true, 'ZWSP stripped'],
  ['word\u200Cword', 'wordword', false, 'ZWNJ preserved (different)'],
  ['Hello\u2026', 'Hello...', true, 'Ellipsis → three dots'],
  ['\u2018Hello\u2019', "'Hello'", true, 'Curly single quotes → straight'],
  ['\u201AGerman\u201C', '"German"', true, 'Low-9 quotes → straight'],
  ['a\u00A0b', 'a b', true, 'No-break space → space'],
  ['a\u3000b', 'a b', true, 'Ideographic space → space'],
  ['a  \t  b', 'a b', true, 'Whitespace collapse'],
];

let passed = 0;
let failed = 0;

for (const [inputA, inputB, shouldMatch, desc] of tests) {
  const a = normalizeText(inputA);
  const b = normalizeText(inputB);
  const match = a === b;

  if (match === shouldMatch) {
    passed++;
    console.log(`  ✓ ${desc}`);
  } else {
    failed++;
    console.log(`  ✗ ${desc}`);
    console.log(`    A: ${JSON.stringify(a)}`);
    console.log(`    B: ${JSON.stringify(b)}`);
    console.log(`    Expected ${shouldMatch ? 'same' : 'different'}, got ${match ? 'same' : 'different'}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
