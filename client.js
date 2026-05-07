// reading-room client. Vanilla ES module.

// ----- State -----
const state = {
  auth: null, // last /api/auth/status payload
  sessionId: sessionStorage.getItem("rr.sessionId") || null,
  filename: null,
  charCount: 0,
  armedQuote: null, // string or null
  streaming: false,
  abortController: null,
  loginPollTimer: null,
  loginPollDeadline: 0,
  docContent: null,
};

// ----- DOM refs -----
const $ = (id) => document.getElementById(id);
const els = {
  body: document.body,
  loginBtn: $("loginBtn"),
  loginHint: $("loginHint"),
  userInfo: $("userInfo"),
  newDocBtn: $("newDocBtn"),
  dropzone: $("dropzone"),
  fileInput: $("fileInput"),
  uploadStatus: $("uploadStatus"),
  uploadError: $("uploadError"),
  docFilename: $("docFilename"),
  docCharCount: $("docCharCount"),
  docBody: $("docBody"),
  chatMessages: $("chatMessages"),
  chatInput: $("chatInput"),
  sendBtn: $("sendBtn"),
  quotePill: $("quotePill"),
  quotePillText: $("quotePillText"),
  quotePillRemove: $("quotePillRemove"),
  selectionBtn: $("selectionBtn"),
  paneDivider: $("paneDivider"),
  pasteTextarea: $("pasteTextarea"),
  pasteCount: $("pasteCount"),
  pasteSubmit: $("pasteSubmit"),
  ytUrlInput: $("ytUrlInput"),
  ytHint: $("ytHint"),
  ytSubmit: $("ytSubmit"),
  docFontSmaller: $("docFontSmaller"),
  docFontLarger: $("docFontLarger"),
  docMarginSmaller: $("docMarginSmaller"),
  docMarginLarger: $("docMarginLarger"),
  docPrefsReset: $("docPrefsReset"),
  docMdToggle: $("docMdToggle"),
};

// ----- Helpers -----
function setState(s) {
  els.body.dataset.state = s;
}

function setUserInfo(auth) {
  if (!auth) {
    els.userInfo.textContent = "";
    return;
  }
  const parts = [];
  if (auth.email) parts.push(auth.email);
  if (auth.orgName) parts.push(auth.orgName);
  els.userInfo.textContent = parts.join(" · ");
}

function showError(el, msg) {
  el.textContent = msg;
  el.hidden = !msg;
}

function fmtNumber(n) {
  return n.toLocaleString("en-US");
}

// ----- Auth flow -----
async function fetchAuthStatus() {
  try {
    const r = await fetch("/api/auth/status");
    if (!r.ok) return { loggedIn: false };
    return await r.json();
  } catch {
    return { loggedIn: false };
  }
}

async function bootApp() {
  setState("loading");
  const auth = await fetchAuthStatus();
  state.auth = auth;
  if (auth && auth.loggedIn) {
    setUserInfo(auth);
    enterLoggedInState();
  } else {
    setState("a");
  }
}

function enterLoggedInState() {
  setUserInfo(state.auth);
  els.newDocBtn.hidden = true;
  if (state.sessionId) {
    // try to restore by fetching the file
    restoreSessionOrFallback();
  } else {
    setState("b");
  }
}

async function restoreSessionOrFallback() {
  try {
    const r = await fetch(`/api/file/${state.sessionId}`);
    if (!r.ok) throw new Error("no session");
    const data = await r.json();
    state.filename = data.filename;
    state.charCount = (data.content || "").length;
    renderDoc(data.filename, data.content);
    enterChatState();
  } catch {
    sessionStorage.removeItem("rr.sessionId");
    state.sessionId = null;
    setState("b");
  }
}

async function startLoginFlow() {
  showError(els.uploadError, "");
  els.loginBtn.disabled = true;
  els.loginBtn.textContent = "正在啟動登入…";
  try {
    await fetch("/api/auth/login", { method: "POST" });
  } catch {
    // ignore - we still poll, user may still complete login
  }
  els.loginHint.hidden = false;
  els.loginBtn.textContent =
    "登入中…請於新分頁完成";
  state.loginPollDeadline = Date.now() + 5 * 60 * 1000;
  pollAuth();
}

function pollAuth() {
  clearTimeout(state.loginPollTimer);
  state.loginPollTimer = setTimeout(async () => {
    const auth = await fetchAuthStatus();
    if (auth && auth.loggedIn) {
      state.auth = auth;
      els.loginBtn.disabled = false;
      els.loginBtn.textContent = "以 Claude.ai 登入";
      els.loginHint.hidden = true;
      enterLoggedInState();
      return;
    }
    if (Date.now() > state.loginPollDeadline) {
      els.loginBtn.disabled = false;
      els.loginBtn.textContent = "重試登入";
      els.loginHint.hidden = true;
      return;
    }
    pollAuth();
  }, 1000);
}

// ----- Upload flow -----
async function handleUpload(file) {
  showError(els.uploadError, "");
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".txt")) {
    showError(els.uploadError, "請選擇 .txt 檔案");
    return;
  }
  els.uploadStatus.hidden = false;
  els.uploadStatus.textContent = "上傳中…";
  const fd = new FormData();
  fd.append("file", file);
  try {
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await r.json();
    if (!r.ok) {
      showError(
        els.uploadError,
        data.error || `上傳失敗 (${r.status})`,
      );
      els.uploadStatus.hidden = true;
      return;
    }
    state.sessionId = data.sessionId;
    state.filename = data.filename;
    state.charCount = data.charCount;
    sessionStorage.setItem("rr.sessionId", state.sessionId);
    // fetch full content to render
    const fr = await fetch(`/api/file/${state.sessionId}`);
    const fdata = await fr.json();
    renderDoc(fdata.filename, fdata.content);
    els.uploadStatus.hidden = true;
    enterChatState();
  } catch (err) {
    showError(
      els.uploadError,
      "上傳失敗：" + (err?.message || err),
    );
    els.uploadStatus.hidden = true;
  }
}

function stripExt(name) {
  return (name || "").replace(/\.[^.\/]+$/, "");
}

function renderDoc(filename, content) {
  els.docFilename.textContent = stripExt(filename);
  els.docCharCount.textContent = `${fmtNumber((content || "").length)} 字元`;
  state.docContent = content || "";
  rerenderDoc();
}

function enterChatState() {
  setState("c");
  applySavedPaneWidth();
  els.newDocBtn.hidden = false;
  // clear chat
  els.chatMessages.innerHTML = "";
  clearArmedQuote();
  els.chatInput.value = "";
  updateSendButton();
  setTimeout(() => els.chatInput.focus(), 0);
}

function resetToUploadState() {
  // cancel any in-flight stream
  if (state.abortController) {
    try {
      state.abortController.abort();
    } catch {}
  }
  state.abortController = null;
  state.streaming = false;
  state.sessionId = null;
  state.filename = null;
  state.charCount = 0;
  sessionStorage.removeItem("rr.sessionId");
  els.chatMessages.innerHTML = "";
  els.docBody.innerHTML = "";
  els.docBody.classList.remove("is-markdown", "markdown-body");
  state.docContent = null;
  clearArmedQuote();
  els.newDocBtn.hidden = true;
  els.fileInput.value = "";
  els.pasteTextarea.value = "";
  updatePasteSubmitState();
  showError(els.uploadError, "");
  els.uploadStatus.hidden = true;
  setState("b");
}

function updatePasteSubmitState() {
  const len = els.pasteTextarea.value.length;
  els.pasteCount.textContent = `${fmtNumber(len)} 字元`;
  els.pasteSubmit.disabled = els.pasteTextarea.value.trim().length === 0;
}

function updateYtSubmitState() {
  const val = (els.ytUrlInput?.value ?? "").trim();
  const isYt = /youtu(?:be\.com|\.be)\//i.test(val);
  if (els.ytSubmit) els.ytSubmit.disabled = !isYt;
}

async function handleYouTubeSubmit() {
  const url = (els.ytUrlInput?.value ?? "").trim();
  if (!url) return;
  showError(els.uploadError, "");
  els.ytSubmit.disabled = true;
  els.ytHint.textContent = "抓取字幕中（首次可能需要 5–10 秒）…";
  try {
    const r = await fetch("/api/import/youtube", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!r.ok) {
      let errMsg = `抓取失敗 (${r.status})`;
      try { errMsg = (await r.json()).error || errMsg; } catch {}
      showError(els.uploadError, errMsg);
      return;
    }
    const data = await r.json();
    state.sessionId = data.sessionId;
    state.filename = data.filename;
    state.charCount = data.charCount;
    sessionStorage.setItem("rr.sessionId", state.sessionId);
    const fr = await fetch(`/api/file/${state.sessionId}`);
    const fdata = await fr.json();
    renderDoc(fdata.filename, fdata.content);
    enterChatState();
  } catch (err) {
    showError(els.uploadError, "抓取字幕失敗：" + (err?.message || err));
  } finally {
    els.ytSubmit.disabled = false;
    els.ytHint.textContent = "支援 watch / youtu.be / shorts";
  }
}

function handlePasteSubmit() {
  const text = els.pasteTextarea.value;
  if (!text.trim()) return;
  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, "-")
    .replace(/\..+$/, "");
  const filename = `貼上文字-${stamp}.txt`;
  const file = new File([text], filename, { type: "text/plain" });
  handleUpload(file);
}

// ----- Doc pane prefs (font size + horizontal padding) -----
const DOC_FONT = { MIN: 12, MAX: 22, STEP: 1, DEFAULT: 15, KEY: "tdoc.docFontSize" };
const DOC_PAD  = { MIN: 0,  MAX: 64, STEP: 8, DEFAULT: 24, KEY: "tdoc.docPaddingX" };
const DOC_MD   = { DEFAULT: true, KEY: "tdoc.docMarkdown" };

function clampToStep(value, spec) {
  const n = Number(value);
  if (!Number.isFinite(n)) return spec.DEFAULT;
  const stepped = Math.round((n - spec.MIN) / spec.STEP) * spec.STEP + spec.MIN;
  return Math.max(spec.MIN, Math.min(spec.MAX, stepped));
}

const docPrefs = { font: DOC_FONT.DEFAULT, pad: DOC_PAD.DEFAULT, markdown: DOC_MD.DEFAULT };

function applyDocFontSize(px) {
  docPrefs.font = px;
  document.documentElement.style.setProperty("--doc-font-size", px + "px");
  try { localStorage.setItem(DOC_FONT.KEY, String(px)); } catch {}
}
function applyDocPaddingX(px) {
  docPrefs.pad = px;
  document.documentElement.style.setProperty("--doc-padding-x", px + "px");
  try { localStorage.setItem(DOC_PAD.KEY, String(px)); } catch {}
}
function bumpDocFont(delta) {
  applyDocFontSize(clampToStep(docPrefs.font + delta * DOC_FONT.STEP, DOC_FONT));
  updateDocControlsState();
}
function bumpDocPad(delta) {
  applyDocPaddingX(clampToStep(docPrefs.pad + delta * DOC_PAD.STEP, DOC_PAD));
  updateDocControlsState();
}
function resetDocPrefs() {
  applyDocFontSize(DOC_FONT.DEFAULT);
  applyDocPaddingX(DOC_PAD.DEFAULT);
  updateDocControlsState();
}
function updateDocControlsState() {
  if (els.docFontSmaller) els.docFontSmaller.disabled = docPrefs.font <= DOC_FONT.MIN;
  if (els.docFontLarger)  els.docFontLarger.disabled  = docPrefs.font >= DOC_FONT.MAX;
  if (els.docMarginSmaller) els.docMarginSmaller.disabled = docPrefs.pad <= DOC_PAD.MIN;
  if (els.docMarginLarger)  els.docMarginLarger.disabled  = docPrefs.pad >= DOC_PAD.MAX;
  if (els.docMdToggle) {
    els.docMdToggle.setAttribute("aria-pressed", String(docPrefs.markdown));
    els.docMdToggle.classList.toggle("is-active", docPrefs.markdown);
  }
}
function rerenderDoc() {
  const content = state.docContent || "";
  if (docPrefs.markdown) {
    els.docBody.innerHTML = renderMarkdown(content);
    els.docBody.classList.add("is-markdown", "markdown-body");
  } else {
    els.docBody.textContent = content;
    els.docBody.classList.remove("is-markdown", "markdown-body");
  }
}

function applyDocMarkdown(enabled) {
  docPrefs.markdown = enabled;
  try { localStorage.setItem(DOC_MD.KEY, String(enabled)); } catch {}
  rerenderDoc();
}

function loadDocPrefs() {
  const f = clampToStep(localStorage.getItem(DOC_FONT.KEY) ?? DOC_FONT.DEFAULT, DOC_FONT);
  const p = clampToStep(localStorage.getItem(DOC_PAD.KEY)  ?? DOC_PAD.DEFAULT,  DOC_PAD);
  const raw = localStorage.getItem(DOC_MD.KEY);
  docPrefs.markdown = raw === null ? DOC_MD.DEFAULT : raw !== "false";
  applyDocFontSize(f);
  applyDocPaddingX(p);
  updateDocControlsState();
}

// ----- Selection logic -----
function isInDocPane(node) {
  if (!node) return false;
  const el = node.nodeType === 1 ? node : node.parentNode;
  return !!(el && els.docBody.contains(el));
}

function handleDocMouseUp() {
  // defer to allow selection to settle
  setTimeout(updateSelectionButton, 0);
}

function updateSelectionButton() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    els.selectionBtn.hidden = true;
    return;
  }
  const text = sel.toString().trim();
  if (!text) {
    els.selectionBtn.hidden = true;
    return;
  }
  if (!isInDocPane(sel.anchorNode) || !isInDocPane(sel.focusNode)) {
    els.selectionBtn.hidden = true;
    return;
  }
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    els.selectionBtn.hidden = true;
    return;
  }
  // Show first so we can measure size, then position.
  els.selectionBtn.hidden = false;
  const btnRect = els.selectionBtn.getBoundingClientRect();
  const margin = 8;
  let top = rect.bottom + margin;
  let left = rect.left + rect.width / 2 - btnRect.width / 2;
  // clamp
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (left < margin) left = margin;
  if (left + btnRect.width > vw - margin) left = vw - margin - btnRect.width;
  if (top + btnRect.height > vh - margin) {
    top = rect.top - margin - btnRect.height;
    if (top < margin) top = margin;
  }
  els.selectionBtn.style.top = `${top}px`;
  els.selectionBtn.style.left = `${left}px`;
}

function handleSelectionBtnClick() {
  const sel = window.getSelection();
  if (!sel) return;
  const text = sel.toString();
  if (!text.trim()) return;
  setArmedQuote(text);
  els.selectionBtn.hidden = true;
  // clear selection
  try {
    sel.removeAllRanges();
  } catch {}
  els.chatInput.focus();
}

function setArmedQuote(text) {
  state.armedQuote = text;
  const trimmed = text.replace(/\s+/g, " ").trim();
  const display = trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed;
  els.quotePillText.textContent = `「${display}」`;
  els.quotePill.hidden = false;
}

function clearArmedQuote() {
  state.armedQuote = null;
  els.quotePill.hidden = true;
  els.quotePillText.textContent = "";
}

// ----- Chat / streaming -----
function updateSendButton() {
  if (state.streaming) {
    els.sendBtn.disabled = false;
    els.sendBtn.textContent = "停止";
    els.chatInput.disabled = true;
    return;
  }
  els.chatInput.disabled = false;
  els.sendBtn.textContent = "送出";
  els.sendBtn.disabled = !els.chatInput.value.trim();
}

function autoResizeTextarea() {
  els.chatInput.style.height = "auto";
  const next = Math.min(els.chatInput.scrollHeight, 200);
  els.chatInput.style.height = next + "px";
}

function appendMessage(role, text, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = `msg msg-${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";

  let quoteEl = null;
  if (opts.quote) {
    quoteEl = document.createElement("div");
    quoteEl.className = "bubble-quote";
    quoteEl.textContent = opts.quote;
    if (role !== "user") {
      bubble.appendChild(quoteEl);
    }
  }

  // Use a div for assistant bubbles so block-level markdown elements
  // (headings, lists, pre, blockquote, etc.) are valid children.
  // User bubbles stay as span and use plain text only.
  const body =
    role === "assistant"
      ? document.createElement("div")
      : document.createElement("span");
  body.className = role === "assistant" ? "bubble-body markdown-body" : "bubble-body";
  body.textContent = text || "";
  bubble.appendChild(body);

  if (opts.quote && role === "user") {
    const stack = document.createElement("div");
    stack.className = "msg-user-stack";
    stack.appendChild(quoteEl);
    stack.appendChild(bubble);
    wrap.appendChild(stack);
  } else {
    wrap.appendChild(bubble);
  }

  els.chatMessages.appendChild(wrap);
  scrollChatToBottom();
  return { wrap, bubble, body };
}

// ----- Markdown rendering (assistant messages only) -----
// Self-contained, XSS-safe markdown -> HTML transformer. The whole input
// is HTML-escaped first; subsequent regex passes only ever produce HTML
// from that escaped string, so attacker-controlled markup is inert.

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeUrl(url) {
  // Allow http(s), mailto, and relative/anchor URLs. Reject javascript:,
  // data:, vbscript:, file:, etc.
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (/^[#/?]/.test(trimmed)) return true; // anchor or path-only
  // RFC 3986 scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
  const m = /^([a-zA-Z][a-zA-Z0-9+\-.]*):/.exec(trimmed);
  if (!m) return true; // no scheme -> treat as relative
  const scheme = m[1].toLowerCase();
  return scheme === "http" || scheme === "https" || scheme === "mailto";
}

function renderInline(s) {
  // Input is already HTML-escaped. Order matters: extract code spans first
  // so their contents are not touched by other passes. The placeholder
  // sentinel uses "<<MDCODE_N>>"; since "<" and ">" are HTML-escaped in
  // the input, this literal sentinel cannot appear in user content.
  const codeSpans = [];
  s = s.replace(/`([^`\n]+)`/g, function (_m, code) {
    codeSpans.push("<code>" + code + "</code>");
    return "<<MDCODE_" + (codeSpans.length - 1) + ">>";
  });

  // Links: [text](url). Validate scheme before emitting.
  s = s.replace(
    /\[([^\]\n]+)\]\(([^()\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    function (whole, text, url) {
      // Decode the entities we care about for scheme validation.
      const decoded = url
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      if (!isSafeUrl(decoded)) return whole;
      return (
        '<a href="' +
        url +
        '" target="_blank" rel="noopener noreferrer">' +
        text +
        "</a>"
      );
    },
  );

  // Bold: **text** or __text__
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");

  // Italic: *text* or _text_ (no whitespace adjacent to markers).
  s = s.replace(/(^|[^*])\*([^*\s][^*\n]*?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, "$1<em>$2</em>");

  // Restore code spans.
  s = s.replace(/<<MDCODE_(\d+)>>/g, function (_m, i) {
    return codeSpans[Number(i)];
  });
  return s;
}

function renderMarkdown(src) {
  if (!src) return "";
  // 1. Escape everything so any raw HTML in the source becomes inert text.
  const escaped = escapeHtml(src);

  // 2. Process block-level constructs line-by-line.
  const lines = escaped.split("\n");
  const out = [];
  let i = 0;
  let listStack = []; // [{ type: 'ul'|'ol', indent: number }]

  function flushListStack() {
    while (listStack.length) {
      out.push("</" + listStack.pop().type + ">");
    }
  }
  function closeListsToIndent(indent) {
    while (
      listStack.length &&
      listStack[listStack.length - 1].indent > indent
    ) {
      out.push("</" + listStack.pop().type + ">");
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: ``` or ```lang
    const fenceOpen = /^\s*```(\s*[\w+\-]*)\s*$/.exec(line);
    if (fenceOpen) {
      flushListStack();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      out.push("<pre><code>" + buf.join("\n") + "</code></pre>");
      continue;
    }

    // Horizontal rule
    if (/^\s*-{3,}\s*$/.test(line) || /^\s*\*{3,}\s*$/.test(line)) {
      flushListStack();
      out.push("<hr>");
      i++;
      continue;
    }

    // Heading: # .. ######
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushListStack();
      const level = heading[1].length;
      out.push(
        "<h" +
          level +
          ">" +
          renderInline(heading[2].trim()) +
          "</h" +
          level +
          ">",
      );
      i++;
      continue;
    }

    // Blockquote: collect consecutive "> " lines (escaped: "&gt; ").
    if (/^\s*&gt;\s?/.test(line)) {
      flushListStack();
      const buf = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*&gt;\s?/, ""));
        i++;
      }
      const inner = buf
        .map((l) => (l.length ? renderInline(l) : ""))
        .join("<br>");
      out.push("<blockquote>" + inner + "</blockquote>");
      continue;
    }

    // Lists (unordered or ordered). One nesting level supported.
    const ulMatch = /^(\s*)[-*]\s+(.*)$/.exec(line);
    const olMatch = /^(\s*)\d+\.\s+(.*)$/.exec(line);
    if (ulMatch || olMatch) {
      const indent = (ulMatch || olMatch)[1].length;
      const content = (ulMatch || olMatch)[2];
      const type = ulMatch ? "ul" : "ol";

      closeListsToIndent(indent);
      const top = listStack[listStack.length - 1];
      if (!top || top.indent < indent) {
        out.push("<" + type + ">");
        listStack.push({ type, indent });
      } else if (top.type !== type) {
        out.push("</" + listStack.pop().type + ">");
        out.push("<" + type + ">");
        listStack.push({ type, indent });
      }
      out.push("<li>" + renderInline(content) + "</li>");
      i++;
      continue;
    }

    // Blank line: closes any open list and separates paragraphs.
    if (/^\s*$/.test(line)) {
      flushListStack();
      i++;
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-special lines.
    flushListStack();
    const para = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (/^\s*$/.test(next)) break;
      if (/^\s*```/.test(next)) break;
      if (/^(#{1,6})\s+/.test(next)) break;
      if (/^\s*-{3,}\s*$/.test(next) || /^\s*\*{3,}\s*$/.test(next)) break;
      if (/^\s*&gt;\s?/.test(next)) break;
      if (/^\s*[-*]\s+/.test(next) || /^\s*\d+\.\s+/.test(next)) break;
      para.push(next);
      i++;
    }
    out.push("<p>" + para.map((l) => renderInline(l)).join("<br>") + "</p>");
  }
  flushListStack();
  return out.join("");
}

function appendSystemError(text) {
  const wrap = document.createElement("div");
  wrap.className = "msg msg-system";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  els.chatMessages.appendChild(wrap);
  scrollChatToBottom();
}

function scrollChatToBottom() {
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

async function sendMessage() {
  if (state.streaming) return;
  const message = els.chatInput.value.trim();
  if (!message) return;
  if (!state.sessionId) {
    appendSystemError("尚未上傳文件");
    return;
  }

  const quote = state.armedQuote;
  appendMessage("user", message, { quote: quote || null });

  els.chatInput.value = "";
  autoResizeTextarea();
  clearArmedQuote();

  // assistant placeholder
  const asst = appendMessage("assistant", "");
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "▍";
  asst.bubble.appendChild(caret);

  state.streaming = true;
  state.abortController = new AbortController();
  updateSendButton();

  let aborted = false;
  let acc = "";

  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        message,
        ...(quote ? { selection: quote } : {}),
      }),
      signal: state.abortController.signal,
    });

    if (!r.ok || !r.body) {
      let errMsg = `請求失敗 (${r.status})`;
      try {
        const j = await r.json();
        if (j?.error) errMsg = j.error;
      } catch {}
      caret.remove();
      asst.body.textContent = "";
      asst.wrap.remove();
      appendSystemError(errMsg);
      return;
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const ev of events) {
        const parsed = parseSSE(ev);
        if (!parsed) continue;
        if (parsed.event === "delta") {
          const t = parsed.data?.text || "";
          if (t) {
            acc += t;
            asst.body.innerHTML = renderMarkdown(acc);
            scrollChatToBottom();
          }
        } else if (parsed.event === "done") {
          caret.remove();
        } else if (parsed.event === "error") {
          caret.remove();
          const msg = parsed.data?.message || "發生錯誤";
          appendSystemError(`錯誤：${msg}`);
        }
      }
    }
  } catch (err) {
    if (err && err.name === "AbortError") {
      aborted = true;
      caret.remove();
      const meta = document.createElement("span");
      meta.className = "bubble-meta";
      meta.textContent = "（已停止）";
      asst.bubble.appendChild(meta);
    } else {
      caret.remove();
      appendSystemError(
        "連線錯誤：" + (err?.message || String(err)),
      );
    }
  } finally {
    if (caret.isConnected) caret.remove();
    state.streaming = false;
    state.abortController = null;
    updateSendButton();
    els.chatInput.focus();
    if (!acc && !aborted) {
      // empty assistant bubble looks weird; remove if no content and no error attached
      if (asst.body.textContent === "" && asst.bubble.children.length <= 1) {
        asst.wrap.remove();
      }
    }
  }
}

function parseSSE(block) {
  const lines = block.split("\n");
  let event = "message";
  let dataLines = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join("\n");
  let data = null;
  try {
    data = JSON.parse(dataStr);
  } catch {
    data = { raw: dataStr };
  }
  return { event, data };
}

function stopStreaming() {
  if (state.abortController) {
    try {
      state.abortController.abort();
    } catch {}
  }
}

// ----- Pane resize -----
const PANE = {
  DOC_MIN: 280,
  CHAT_MIN: 320,
  DIVIDER: 6,
  STORAGE_KEY: "tdoc.paneDocWidth",
  MOBILE_BP: 900,
};

function paneIsMobile() {
  return window.innerWidth <= PANE.MOBILE_BP;
}

function clampDocPaneWidth(width, layoutWidth) {
  const max = Math.max(PANE.DOC_MIN, layoutWidth - PANE.CHAT_MIN - PANE.DIVIDER);
  return Math.max(PANE.DOC_MIN, Math.min(max, width));
}

function applyDocPaneWidth(width) {
  const docPane = els.docBody.closest(".pane-doc");
  if (!docPane) return;
  docPane.style.flex = `0 0 ${width}px`;
}

function clearDocPaneWidth() {
  const docPane = els.docBody.closest(".pane-doc");
  if (!docPane) return;
  docPane.style.flex = "";
}

function applySavedPaneWidth() {
  if (paneIsMobile()) {
    clearDocPaneWidth();
    return;
  }
  const layout = els.chatMessages.closest(".chat-layout");
  if (!layout || layout.offsetWidth === 0) return;
  const raw = localStorage.getItem(PANE.STORAGE_KEY);
  if (!raw) return;
  const w = Number(raw);
  if (!Number.isFinite(w)) return;
  applyDocPaneWidth(clampDocPaneWidth(w, layout.offsetWidth));
}

function initPaneResize() {
  const divider = els.paneDivider;
  if (!divider) return;
  const layout = divider.closest(".chat-layout");
  const docPane = layout?.querySelector(".pane-doc");
  if (!layout || !docPane) return;

  let drag = null;

  divider.addEventListener("pointerdown", (e) => {
    if (paneIsMobile()) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth: docPane.offsetWidth,
    };
    try {
      divider.setPointerCapture(e.pointerId);
    } catch {}
    divider.classList.add("dragging");
    document.body.classList.add("resizing-panes");
    els.selectionBtn.hidden = true;
  });

  divider.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const w = clampDocPaneWidth(
      drag.startWidth + (e.clientX - drag.startX),
      layout.offsetWidth,
    );
    applyDocPaneWidth(w);
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    try {
      divider.releasePointerCapture(e.pointerId);
    } catch {}
    divider.classList.remove("dragging");
    document.body.classList.remove("resizing-panes");
    localStorage.setItem(PANE.STORAGE_KEY, String(docPane.offsetWidth));
    drag = null;
  }
  divider.addEventListener("pointerup", endDrag);
  divider.addEventListener("pointercancel", endDrag);

  divider.addEventListener("keydown", (e) => {
    if (paneIsMobile()) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = (e.shiftKey ? 40 : 10) * (e.key === "ArrowLeft" ? -1 : 1);
    const w = clampDocPaneWidth(docPane.offsetWidth + step, layout.offsetWidth);
    applyDocPaneWidth(w);
    localStorage.setItem(PANE.STORAGE_KEY, String(w));
  });

  window.addEventListener("resize", () => {
    if (paneIsMobile()) {
      clearDocPaneWidth();
    } else {
      applySavedPaneWidth();
    }
  });
}

// ----- Wire up events -----
function init() {
  // Login
  els.loginBtn.addEventListener("click", startLoginFlow);

  // New doc
  els.newDocBtn.addEventListener("click", resetToUploadState);

  // Upload (click + drag)
  els.fileInput.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) handleUpload(f);
  });
  ["dragenter", "dragover"].forEach((evt) => {
    els.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      els.dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "dragend", "drop"].forEach((evt) => {
    els.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      els.dropzone.classList.remove("dragover");
    });
  });
  els.dropzone.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) handleUpload(f);
  });

  // Paste-text alternative
  els.pasteTextarea.addEventListener("input", updatePasteSubmitState);
  els.pasteSubmit.addEventListener("click", handlePasteSubmit);
  els.pasteTextarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      handlePasteSubmit();
    }
  });
  updatePasteSubmitState();

  // YouTube URL import
  if (els.ytUrlInput) {
    els.ytUrlInput.addEventListener("input", updateYtSubmitState);
    els.ytUrlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        if (!els.ytSubmit.disabled) handleYouTubeSubmit();
      }
    });
  }
  if (els.ytSubmit) {
    els.ytSubmit.addEventListener("click", handleYouTubeSubmit);
  }

  // Doc selection
  els.docBody.addEventListener("mouseup", handleDocMouseUp);
  els.docBody.addEventListener("keyup", handleDocMouseUp);
  document.addEventListener("mousedown", (e) => {
    if (e.target === els.selectionBtn) return;
    if (!isInDocPane(e.target)) {
      // clicking outside the doc pane hides the floating button
      els.selectionBtn.hidden = true;
    }
  });
  window.addEventListener(
    "scroll",
    () => {
      els.selectionBtn.hidden = true;
    },
    true,
  );
  window.addEventListener("resize", () => {
    els.selectionBtn.hidden = true;
  });
  els.selectionBtn.addEventListener("click", handleSelectionBtnClick);

  // Quote pill
  els.quotePillRemove.addEventListener("click", clearArmedQuote);

  // Chat input
  els.chatInput.addEventListener("input", () => {
    autoResizeTextarea();
    updateSendButton();
  });
  els.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (state.streaming) return;
      if (els.chatInput.value.trim()) sendMessage();
    }
  });
  els.sendBtn.addEventListener("click", () => {
    if (state.streaming) {
      stopStreaming();
    } else {
      sendMessage();
    }
  });

  // Pane resize
  initPaneResize();

  // Doc pane prefs
  loadDocPrefs();
  if (els.docFontSmaller) els.docFontSmaller.addEventListener("click", () => bumpDocFont(-1));
  if (els.docFontLarger)  els.docFontLarger.addEventListener("click",  () => bumpDocFont(+1));
  if (els.docMarginSmaller) els.docMarginSmaller.addEventListener("click", () => bumpDocPad(-1));
  if (els.docMarginLarger)  els.docMarginLarger.addEventListener("click",  () => bumpDocPad(+1));
  if (els.docPrefsReset) els.docPrefsReset.addEventListener("click", resetDocPrefs);
  if (els.docMdToggle) els.docMdToggle.addEventListener("click", () => {
    applyDocMarkdown(!docPrefs.markdown);
    updateDocControlsState();
  });

  // Boot
  bootApp();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
