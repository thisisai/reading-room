# Talk to Doc — Agent Guide

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
  youtube.ts           # fetchYouTubeTranscript()：spawn yt-dlp 抓字幕
  yt-json3-parser.ts   # parseJson3Transcript()：解析 yt-dlp 的 json3 格式
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

## 常見問題

- **YouTube 字幕 429 錯誤**：yt-dlp 一次抓太多語言 → 預設只抓 `en-orig,en`，不要增加太多語言
- **字幕 ERROR：找不到**：影片沒有英文字幕，目前不自動 fallback 其他語言
- **重啟後 session 消失**：設計如此，需重新上傳文件
- **yt-dlp 未安裝**：server 會回傳 `{ error: "yt-dlp 未安裝或不在 PATH 上…" }`
