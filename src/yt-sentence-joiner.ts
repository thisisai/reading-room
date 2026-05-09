const SENTENCE_END = /[.?!…。？！]+["'"“”」』）)\]]*$/;
const CJK_RANGE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
const MAX_BUFFER_CHARS = 200;

const endsCJK = (s: string) => CJK_RANGE.test(s.slice(-1));
const startsCJK = (s: string) => CJK_RANGE.test(s.charAt(0));

export function joinCueLines(text: string): string {
  const lines = text.split('\n').filter(Boolean);
  const paragraphs: string[] = [];
  let buf = '';

  for (const line of lines) {
    if (!buf) {
      buf = line;
    } else {
      const sep = endsCJK(buf) || startsCJK(line) ? '' : ' ';
      buf = buf + sep + line;
    }

    if (SENTENCE_END.test(buf) || buf.length >= MAX_BUFFER_CHARS) {
      paragraphs.push(buf);
      buf = '';
    }
  }

  if (buf) paragraphs.push(buf);
  return paragraphs.join('\n');
}
