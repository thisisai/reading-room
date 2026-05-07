// Decode WebVTT into plain transcript text. Handles both manual subtitles
// (clean cue blocks) and YouTube auto-caption rolling format (inline
// <00:00:00.000> timestamps + <c> tags + duplicate cues for the rolling
// effect). Output matches parseJson3Transcript: lines joined by '\n',
// whitespace collapsed, blank lines dropped.

function decodeHtml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function stripInlineTags(value: string): string {
  // Remove <00:00:00.000> timestamp tags and <c>/<c.colorXXX>/</c> styling tags.
  return value.replace(/<\/?[^>]+>/g, '');
}

function isCueTimingLine(line: string): boolean {
  return line.includes('-->');
}

export function parseVttTranscript(input: string): string {
  const normalized = input.replaceAll(/\r\n?/g, '\n');
  const lines = normalized.split('\n');

  const out: string[] = [];
  let prev = '';
  let inHeader = true;

  for (const raw of lines) {
    const line = raw.trim();

    if (inHeader) {
      // Header ends at the first blank line after WEBVTT.
      if (line === '' && out.length === 0 && prev !== '') {
        inHeader = false;
      }
      // Skip header lines: WEBVTT, Kind:, Language:, NOTE, STYLE, etc.
      if (line.startsWith('WEBVTT') || /^[A-Z][a-zA-Z-]*:/.test(line) ||
          line.startsWith('NOTE') || line.startsWith('STYLE')) {
        prev = line;
        continue;
      }
      if (line === '') {
        prev = line;
        continue;
      }
      // First non-header content reached.
      inHeader = false;
    }

    if (line === '') continue;
    if (isCueTimingLine(line)) continue;
    // Cue identifiers (numeric or short labels on their own line) — skip when
    // the next line is a timing line. Cheap heuristic: skip pure-digit lines.
    if (/^\d+$/.test(line)) continue;

    const cleaned = stripInlineTags(decodeHtml(line))
      .replaceAll(/\s+/g, ' ')
      .trim();
    if (!cleaned) continue;

    // Auto-caption rolling: each cue repeats the previous line plus a new
    // word. De-dupe consecutive identical lines and skip lines that are
    // strict prefixes of the previous (rolling growth).
    const last = out[out.length - 1];
    if (last === cleaned) continue;
    if (last && cleaned.startsWith(last)) {
      out[out.length - 1] = cleaned;
      continue;
    }

    out.push(cleaned);
  }

  return out.join('\n');
}
