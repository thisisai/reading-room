import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJson3Transcript } from './yt-json3-parser';
import { parseVttTranscript } from './yt-vtt-parser';

const SUB_EXTS = ['json3', 'vtt'] as const;
type SubExt = (typeof SUB_EXTS)[number];

// 注意：絕對不要用 '.*' wildcard。yt-dlp 會展開成 YouTube 所有自動翻譯語言（~210 個），
// 每個獨立打 timedtext API，第 2 個就觸發 429（auto-translated 端點 rate limit 很嚴）。
// 一旦撞到，IP 還會被擴散限流一段時間。永遠明確列出語言代碼。
const LANG_GROUPS = [
  'en-orig,en',
  'zh-Hant,zh-Hans,zh,zh-TW,zh-CN,zh-HK,yue,yue-HK',
];

async function spawnYtDlp(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn(['yt-dlp', ...args], { stdout: 'pipe', stderr: 'pipe' });
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('yt-dlp 未安裝或不在 PATH 上。請執行 brew install yt-dlp 後重試。');
    }
    throw err;
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export async function getVideoId(url: string): Promise<string> {
  const result = await spawnYtDlp(['--print', 'id', '--skip-download', url]);
  if (result.exitCode !== 0) {
    const msg = (result.stderr || result.stdout).trim();
    if (msg.includes('Private video') || msg.includes('This video is private')) {
      throw new Error('這是私人影片，無法存取字幕。');
    }
    if (msg.includes('age') || msg.includes('Sign in') || msg.includes('age-restricted')) {
      throw new Error('這部影片需要年齡驗證，無法自動存取字幕。');
    }
    throw new Error(`無法取得影片 ID：${msg.slice(0, 300)}`);
  }
  return result.stdout.trim().split('\n').at(-1) ?? 'unknown-video';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getDownloadedLanguage(stderr: string): string {
  const match = stderr.match(/Downloading subtitles: ([^\n,]+)/);
  return match ? match[1].trim() : 'unknown';
}

function isSubtitleFile(name: string): boolean {
  return SUB_EXTS.some((ext) => name.endsWith(`.${ext}`));
}

function getSubtitleExt(path: string): SubExt | undefined {
  return SUB_EXTS.find((ext) => path.endsWith(`.${ext}`));
}

function findDownloadedSubtitle(outputDir: string, stderr: string): string | undefined {
  const files = readdirSync(outputDir).filter(isSubtitleFile);

  const langs = stderr.match(/Downloading subtitles: ([^\n]+)/)?.[1]
    .split(',').map((l) => l.trim()) ?? [];

  // Prefer json3 (richer, faster to parse), fall back to vtt.
  for (const ext of SUB_EXTS) {
    for (const lang of langs) {
      const exact = `subtitle.${lang}.${ext}`;
      if (files.includes(exact)) return join(outputDir, exact);

      const pat = new RegExp(
        `^subtitle\\.${escapeRegExp(lang)}\\..+\\.${ext}$`,
      );
      const hit = files.find((f) => pat.test(f));
      if (hit) return join(outputDir, hit);
    }
  }

  // Fallback: any subtitle file, json3 first.
  for (const ext of SUB_EXTS) {
    const hit = files.find((f) => f.endsWith(`.${ext}`));
    if (hit) return join(outputDir, hit);
  }
  return undefined;
}

export type FetchTranscriptResult = {
  videoId: string;
  langUsed: string;
  text: string;
};

async function tryDownloadLangs(
  url: string,
  langs: string,
  outputDir: string,
  outputTemplate: string,
  manualOnly: boolean,
): Promise<{ subtitlePath: string; langUsed: string } | null> {
  const maxAttempts = 3;
  const retryDelaysMs = [8_000, 20_000, 45_000];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // clean any leftover files from a previous attempt
    for (const f of readdirSync(outputDir).filter(isSubtitleFile)) {
      try { rmSync(join(outputDir, f), { force: true }); } catch {}
    }

    const result = await spawnYtDlp([
      '--skip-download',
      manualOnly ? '--write-subs' : '--write-auto-subs',
      '--sub-langs', langs,
      // Some YouTube subtitles only ship as vtt (manual captions often omit
      // json3); fall back to vtt so we don't false-negative.
      '--sub-format', 'json3/vtt/best',
      '--extractor-args', 'youtube:player_client=tv,web_safari',
      '--sleep-requests', '2',
      '--output', outputTemplate,
      url,
    ]);

    if (result.exitCode !== 0) {
      const errorLines = result.stderr
        .split('\n')
        .filter((l) => l.startsWith('ERROR:'))
        .join('\n')
        .trim();
      const msg = errorLines || result.stderr.trim() || result.stdout.trim();

      const is429 = msg.includes('429') || msg.toLowerCase().includes('too many requests');
      if (is429 && attempt < maxAttempts - 1) {
        await Bun.sleep(retryDelaysMs[attempt]);
        continue;
      }

      throw new Error(`下載字幕失敗：${msg.slice(0, 800)}`);
    }

    const subtitlePath = findDownloadedSubtitle(outputDir, result.stderr);
    if (!subtitlePath) return null;

    return { subtitlePath, langUsed: getDownloadedLanguage(result.stderr) };
  }

  return null;
}

export async function fetchYouTubeTranscript(
  url: string,
  opts: { langs?: string; manualOnly?: boolean } = {},
): Promise<FetchTranscriptResult> {
  const manualOnly = opts.manualOnly ?? false;
  const langGroups = opts.langs ? [opts.langs] : LANG_GROUPS;

  const videoId = await getVideoId(url);
  const outputDir = join(tmpdir(), 'reading-room-yt', videoId);
  const outputTemplate = join(outputDir, 'subtitle.%(ext)s');

  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true, force: true });
  }
  mkdirSync(outputDir, { recursive: true });

  try {
    for (const langs of langGroups) {
      const hit = await tryDownloadLangs(url, langs, outputDir, outputTemplate, manualOnly);
      if (!hit) continue;

      const ext = getSubtitleExt(hit.subtitlePath);
      const raw = readFileSync(hit.subtitlePath, 'utf8');
      const text = ext === 'vtt'
        ? parseVttTranscript(raw)
        : parseJson3Transcript(raw);
      if (!text.trim()) continue;

      return { videoId, langUsed: hit.langUsed, text };
    }

    throw new Error('找不到字幕。這部影片可能沒有提供任何語言的字幕。');
  } finally {
    try { rmSync(outputDir, { recursive: true, force: true }); } catch {}
  }
}
