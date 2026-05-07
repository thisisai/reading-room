# Reading Room — Agent Guide

## 專案簡介

本機 web app：把文件（`.txt` 或 YouTube 字幕）丟進來，用 Claude AI 對話討論內容。
**Bun + vanilla JS + Claude Code CLI**，零框架、零資料庫、零 build step。

## 環境前置條件

執行以下指令確認三個依賴都已安裝：

```bash
bun --version        # 需要 Bun runtime
yt-dlp --version     # 需要 yt-dlp（brew install yt-dlp）
claude --version     # 需要 Claude Code CLI（npm install -g @anthropic-ai/claude-code）
```

若缺少任一項，安裝方式：

```bash
# Bun
curl -fsSL https://bun.sh/install | bash

# yt-dlp
brew install yt-dlp

# Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude auth login --claudeai   # 需要 Claude.ai 帳號
```

## 安裝與啟動

```bash
bun install          # 安裝 dev deps（只有 @types/bun）
bun run dev          # 開發模式（hot reload），預設 http://localhost:3000
bun run start        # 生產模式
```

## 測試

```bash
bun test             # 跑所有測試（目前只有 src/yt-json3-parser.test.ts）
```

## 專案結構

```
server.ts              # HTTP server（Bun.serve），所有 API 路由都在這
client.js              # 前端邏輯（vanilla ES module，無 build step）
index.html             # 單頁 HTML，三個 state（loading / 上傳 / 對話）
styles.css             # 所有樣式
src/
  youtube.ts             # fetchYouTubeTranscript()：spawn yt-dlp 抓字幕
  yt-json3-parser.ts     # parseJson3Transcript()：解析 yt-dlp 的 json3 格式
  yt-vtt-parser.ts       # parseVttTranscript()：解析 vtt 格式（fallback 用）
  yt-json3-parser.test.ts
```

## 架構重點

- **Session 存在記憶體**：`const sessions = new Map<string, Session>()` in `server.ts:9`，重啟即清空
- **文件傳給 AI 的方式**：整份內容塞進 Claude CLI 第一條 user message（`buildStdin` in `server.ts`），不用 RAG
- **AI 對話引擎**：`Bun.spawn(["claude", "-p", ...])` 直接呼叫本機 Claude Code CLI，不用 API key
- **三種輸入來源**：YouTube URL → `/api/import/youtube`、檔案上傳 → `/api/upload`、貼上文字 → 包成 File 走 `/api/upload`

## API

| 方法 | 路徑 | 用途 |
|------|------|------|
| POST | `/api/import/youtube` | 給 URL，server 抓字幕，回傳 `{ sessionId, filename, charCount, videoId, langUsed }` |
| POST | `/api/upload` | 上傳 `.txt` 檔（multipart），回傳 `{ sessionId, filename, charCount }` |
| GET  | `/api/file/:sessionId` | 取得文件全文 `{ filename, content }` |
| POST | `/api/chat` | 送訊息，回傳 SSE stream（`delta` / `done` / `error` events） |
| GET  | `/api/auth/status` | 確認 Claude CLI 登入狀態 |

## YouTube 字幕抓取（坑點集中區）

`src/youtube.ts` 的 `LANG_GROUPS` 是按優先序排的多組 fallback：先英文，再中文家族（含粵語）。**永遠明確列出語言代碼，絕對不要用 `.*` wildcard**——`.*` 是 yt-dlp 的 regex，會展開成 YouTube 對該影片提供的全部 ~210 個語言代碼（含 `ab-zh, aa-zh, ...` 自動翻譯變體），yt-dlp 會逐一打 YouTube `timedtext` API，**第 2 個就觸發 429**，而且會被 IP 級擴散限流一段時間。詳情見 yt-dlp issue #13831 / #13770。

字幕格式：`--sub-format` 用 `'json3/vtt/best'`。json3 是首選（structured，乾淨好 parse），但**手動字幕常常只給 vtt**——例如台灣中文字幕只標 `zh-TW` 且只有 vtt。所以兩種格式都要支援，依檔名選對應 parser：

- `.json3` → `parseJson3Transcript`
- `.vtt`   → `parseVttTranscript`（會處理 inline `<00:00:00.000>` 時間戳、`<c>` styling tag、auto-caption 滾動式重複 cue）

其他選項：
- `--extractor-args youtube:player_client=tv,web_safari`：`tv` client 目前限流最寬鬆
- `--sleep-requests 2`：降低觸發 rate limit 機率
- 撞到 429 會自動指數退避重試（8s → 20s → 45s）

未做但已調研：`--impersonate chrome`（要 curl_cffi，brew yt-dlp 預設無）、`--cookies-from-browser`（需 OS 整合）。需要再強化時可加，但移除 `.*` 之後一般已足夠。

## 常見問題

- **重啟後 session 消失**：設計如此，需重新上傳文件
- **yt-dlp 未安裝**：server 會回傳 `{ error: "yt-dlp 未安裝或不在 PATH 上…" }`
- **字幕找不到**：影片可能完全無字幕；或語言代碼不在 `LANG_GROUPS` 內（例如日文、韓文影片），可在 `src/youtube.ts` 補上對應代碼
