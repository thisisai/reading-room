# Talk to Doc

把文件丟進來，直接跟 Claude AI 對話討論內容。支援上傳 `.txt`、貼上文字，或直接貼 YouTube 連結自動抓字幕。支援 Markdown 渲染、選取引用提問。

## 事前準備

需要安裝兩個東西：

**1. Bun**（執行環境）

```bash
curl -fsSL https://bun.sh/install | bash
```

**2. yt-dlp**（YouTube 字幕抓取）

```bash
brew install yt-dlp
```

**3. Claude Code CLI**（AI 對話引擎）

```bash
npm install -g @anthropic-ai/claude-code
```

安裝後登入帳號：

```bash
claude auth login --claudeai
```

> 需要有 Claude.ai 帳號（claude.ai/code）。

## 啟動

```bash
bun run server.ts
```

打開瀏覽器前往 [http://localhost:3000](http://localhost:3000)。

預設 port 是 3000，可以用環境變數覆蓋：

```bash
PORT=8080 bun run server.ts
```

## 使用方式

1. **YouTube 字幕**：貼上 YouTube 連結（支援 watch / youtu.be / shorts），自動下載英文字幕作為對話來源
2. **上傳文件**：把 `.txt` 檔案拖曳到上傳區
3. **貼上文字**：直接貼上文字內容開始對話
4. **開始對話**：在右側輸入框輸入問題，Enter 送出
5. **引用提問**：在左側文件區選取一段文字，點擊「💬 針對這段提問」，可以針對特定段落發問
6. **切換 Markdown**：標題列右上角的 `MD` 按鈕，可以在 Markdown 渲染模式和純文字模式之間切換

## 注意事項

- 上傳檔案僅支援 `.txt` 格式，最大 5 MB；YouTube 字幕同樣受此上限限制（一般影片遠小於此）
- YouTube 字幕預設抓英文（`en-orig,en`），若影片無英文字幕會回報錯誤
- 對話 session 存在記憶體裡，重啟伺服器後需要重新上傳文件
- 伺服器預設只監聽 `127.0.0.1`（本機），不對外開放
