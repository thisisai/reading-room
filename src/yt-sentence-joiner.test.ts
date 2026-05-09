import { expect, test } from 'bun:test';
import { joinCueLines } from './yt-sentence-joiner';

test('空字串 → 空字串', () => {
  expect(joinCueLines('')).toBe('');
});

test('英文：斷句的 cue 合成完整句子', () => {
  const input = [
    'Cortex can now help with almost',
    'everything.',
    'But only if it can work where actual',
    'work happens.',
  ].join('\n');
  expect(joinCueLines(input)).toBe(
    'Cortex can now help with almost everything.\n' +
    'But only if it can work where actual work happens.',
  );
});

test('中文：鄰接不插空格', () => {
  const input = ['你好', '世界。'].join('\n');
  expect(joinCueLines(input)).toBe('你好世界。');
});

test('中英混排：英文間有空格，CJK 鄰接無空格', () => {
  const input = ['這是一個', '測試 test', 'case.'].join('\n');
  expect(joinCueLines(input)).toBe('這是一個測試 test case.');
});

test('句末引號也算句末，正確 flush', () => {
  const input = ['He said', '"goodbye."', 'See you later.'].join('\n');
  expect(joinCueLines(input)).toBe(
    'He said "goodbye."\n' +
    'See you later.',
  );
});

test('句末問號與驚嘆號', () => {
  const input = ['Are you sure?', 'Yes,', 'I am!'].join('\n');
  expect(joinCueLines(input)).toBe('Are you sure?\nYes, I am!');
});

test('中文句號 & 問號', () => {
  const input = ['這樣做', '對嗎？', '完全沒問題。'].join('\n');
  expect(joinCueLines(input)).toBe('這樣做對嗎？\n完全沒問題。');
});

test('無標點超過 200 字觸發軟上限斷行', () => {
  const longCue = 'word '.repeat(10).trim(); // ~49 chars per cue
  const cues = Array.from({ length: 6 }, () => longCue);
  const input = cues.join('\n');
  const result = joinCueLines(input);
  const resultLines = result.split('\n');
  // 每行都不應超過 200 + 最後一個 cue 的長度（加入時若已 >= 200 才 flush）
  for (const line of resultLines) {
    expect(line.length).toBeLessThan(400);
  }
  // 應有超過 1 行（代表有斷行）
  expect(resultLines.length).toBeGreaterThan(1);
});

test('單一 cue 超過 200 字直接輸出不截斷', () => {
  const longLine = 'a'.repeat(250);
  expect(joinCueLines(longLine)).toBe(longLine);
});

test('每個 cue 本身就是完整句子：各自一行，no-op', () => {
  const input = ['Hello world.', 'How are you?', 'I am fine!'].join('\n');
  expect(joinCueLines(input)).toBe('Hello world.\nHow are you?\nI am fine!');
});
