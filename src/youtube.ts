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

const LANG_GROUPS = ['en-orig,en', 'zh-Hant,zh-Hans,zh', '.*'];

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

function findDownloadedJson3(outputDir: string, stderr: string): string | undefined {
  const files = readdirSync(outputDir).filter((f) => f.endsWith('.json3'));

  const langs = stderr.match(/Downloading subtitles: ([^\n]+)/)?.[1]
    .split(',').map((l) => l.trim()) ?? [];

  for (const lang of langs) {
    const exact = `subtitle.${lang}.json3`;
    if (files.includes(exact)) return join(outputDir, exact);

    const pat = new RegExp(`^subtitle\\.${escapeRegExp(lang)}\\..+\\.json3$`);
    const hit = files.find((f) => pat.test(f));
    if (hit) return join(outputDir, hit);
  }

  return files.map((f) => join(outputDir, f)).at(0);
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
): Promise<{ json3Path: string; langUsed: string } | null> {
  // clean any leftover files from a previous attempt
  for (const f of readdirSync(outputDir).filter((f) => f.endsWith('.json3'))) {
    try { rmSync(join(outputDir, f), { force: true }); } catch {}
  }

  const result = await spawnYtDlp([
    '--skip-download',
    manualOnly ? '--write-subs' : '--write-auto-subs',
    '--sub-langs', langs,
    '--sub-format', 'json3',
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
    throw new Error(`下載字幕失敗：${msg.slice(0, 800)}`);
  }

  const json3Path = findDownloadedJson3(outputDir, result.stderr);
  if (!json3Path) return null;

  return { json3Path, langUsed: getDownloadedLanguage(result.stderr) };
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

      const text = parseJson3Transcript(readFileSync(hit.json3Path, 'utf8'));
      if (!text.trim()) continue;

      return { videoId, langUsed: hit.langUsed, text };
    }

    throw new Error('找不到字幕。這部影片可能沒有提供任何語言的字幕。');
  } finally {
    try { rmSync(outputDir, { recursive: true, force: true }); } catch {}
  }
}
