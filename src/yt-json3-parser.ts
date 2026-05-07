type Json3Segment = {
  utf8?: string;
};

type Json3Event = {
  segs?: Json3Segment[];
};

type Json3Caption = {
  events?: Json3Event[];
};

function decodeHtml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

export function parseJson3Transcript(input: string): string {
  const parsed = JSON.parse(input) as Json3Caption;
  const rawText =
    parsed.events
      ?.flatMap((event) => event.segs ?? [])
      .map((segment) => segment.utf8 ?? '')
      .join('') ?? '';

  return decodeHtml(rawText)
    .replaceAll(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replaceAll(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
