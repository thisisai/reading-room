import { expect, test } from 'bun:test';
import { parseJson3Transcript } from './yt-json3-parser';

test('parses json3 captions into plain transcript text without VTT overlap', () => {
  const input = JSON.stringify({
    events: [
      {
        tStartMs: 2000,
        dDurationMs: 3480,
        segs: [
          { utf8: 'Okay,' },
          { utf8: " I'm", tOffsetMs: 440 },
          { utf8: ' excited', tOffsetMs: 680 },
          { utf8: ' to', tOffsetMs: 1000 },
          { utf8: ' introduce', tOffsetMs: 1080 },
          { utf8: ' our', tOffsetMs: 1400 },
          { utf8: ' next', tOffsetMs: 1480 },
        ],
      },
      { tStartMs: 3710, dDurationMs: 1770, segs: [{ utf8: '\n' }] },
      {
        tStartMs: 3720,
        dDurationMs: 3840,
        segs: [
          { utf8: 'speaker.' },
          { utf8: ' Show', tOffsetMs: 520 },
          { utf8: ' of', tOffsetMs: 680 },
          { utf8: ' hands,', tOffsetMs: 800 },
          { utf8: ' who', tOffsetMs: 1160 },
          { utf8: ' here', tOffsetMs: 1280 },
          { utf8: ' uses', tOffsetMs: 1480 },
        ],
      },
      { tStartMs: 5470, dDurationMs: 2090, segs: [{ utf8: '\n' }] },
      {
        tStartMs: 5480,
        dDurationMs: 3720,
        segs: [
          { utf8: 'Claude' },
          { utf8: ' code?', tOffsetMs: 320 },
        ],
      },
    ],
  });

  expect(parseJson3Transcript(input)).toBe(
    "Okay, I'm excited to introduce our next\n" +
      'speaker. Show of hands, who here uses\n' +
      'Claude code?',
  );
});
