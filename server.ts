import { serve } from "bun";
import { fetchYouTubeTranscript } from "./src/youtube";

type Session = {
  filename: string;
  content: string;
  started: boolean;
};

const sessions = new Map<string, Session>();
let loginInFlight = false;

const UUID_RE = /^[0-9a-f-]{36}$/i;
const PORT = Number(process.env.PORT ?? 3000);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const SYSTEM_PROMPT =
  "你是文件學習助手。使用者已上傳一份 txt 文件，將在第一條訊息中提供全文。後續對話請以這份文件為主題協助使用者理解、討論、提問。請用繁體中文回答。直接回答問題，不要描述自己的思考流程、技能判斷或工具決策。";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function getAuthStatus(): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(["claude", "auth", "status", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    const parsed = JSON.parse(out);
    // Lazy-clear the in-flight gate once login has actually succeeded, so a
    // subsequent logout→login round trip isn't blocked by the 5-min timer.
    if (parsed?.loggedIn) loginInFlight = false;
    return parsed;
  } catch {
    return { loggedIn: false, error: "auth status parse failed" };
  }
}

function startLogin(): void {
  Bun.spawn(["claude", "auth", "login", "--claudeai"], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
}

async function logout(): Promise<{ ok: boolean; error?: string }> {
  const proc = Bun.spawn(["claude", "auth", "logout"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) return { ok: false, error: stderr.trim().slice(0, 300) };
  return { ok: true };
}

function buildChatArgs(sid: string, session: Session): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--tools",
    "",
    "--model",
    "sonnet",
    // 關掉 skills，避免 user-level 的 using-superpowers 等規則
    // 讓模型在回答前先輸出「skill 檢查」的思考流程。
    "--disable-slash-commands",
  ];
  if (!session.started) {
    args.push("--session-id", sid, "--append-system-prompt", SYSTEM_PROMPT);
  } else {
    args.push("--resume", sid);
  }
  return args;
}

function buildStdin(session: Session, message: string, selection?: string): string {
  if (!session.started) {
    return `以下是要討論的文件「${session.filename}」全文：\n\n---\n${session.content}\n---\n\n我的第一個問題：${message}`;
  }
  if (selection?.trim()) {
    const quoted = selection.trim().replace(/\n/g, "\n> ");
    return `針對文件中的這段：\n> ${quoted}\n\n我的問題：${message}`;
  }
  return message;
}

function chatStream(sid: string, message: string, selection?: string): Response {
  const session = sessions.get(sid);
  if (!session) return json({ error: "Session not found" }, 404);

  const args = buildChatArgs(sid, session);
  const proc = Bun.spawn(["claude", ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdinText = buildStdin(session, message, selection);
  proc.stdin.write(stdinText);
  proc.stdin.end();

  const encoder = new TextEncoder();
  const sse = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      const decoder = new TextDecoder();
      let buffer = "";
      let stderrBuffer = "";

      const stderrPromise = (async () => {
        const dec = new TextDecoder();
        for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
          stderrBuffer += dec.decode(chunk, { stream: true });
        }
      })();

      try {
        for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            let obj: any;
            try {
              obj = JSON.parse(line);
            } catch {
              continue;
            }

            if (
              obj.type === "stream_event" &&
              obj.event?.type === "content_block_delta" &&
              obj.event?.delta?.type === "text_delta" &&
              typeof obj.event.delta.text === "string"
            ) {
              send("delta", { text: obj.event.delta.text });
            } else if (obj.type === "result") {
              if (obj.is_error) {
                send("error", {
                  message: obj.result ?? "claude returned an error",
                });
              } else {
                if (!session.started) session.started = true;
                send("done", {
                  usage: obj.usage,
                  cost_usd: obj.total_cost_usd,
                });
              }
            }
          }
        }

        const code = await proc.exited;
        await stderrPromise;
        if (code !== 0) {
          send("error", {
            message: `claude exited with code ${code}`,
            stderr: stderrBuffer.slice(0, 2000),
          });
        }
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send("error", { message: msg });
        controller.close();
      }
    },
    cancel() {
      try {
        proc.kill();
      } catch {}
    },
  });

  return new Response(sse, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function staticFile(path: string, contentType: string): Response {
  const file = Bun.file(`./${path}`);
  return new Response(file, {
    headers: { "Content-Type": contentType },
  });
}

serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return staticFile("index.html", "text/html; charset=utf-8");
    }
    if (req.method === "GET" && pathname === "/client.js") {
      return staticFile("client.js", "application/javascript; charset=utf-8");
    }
    if (req.method === "GET" && pathname === "/styles.css") {
      return staticFile("styles.css", "text/css; charset=utf-8");
    }
    if (req.method === "GET" && pathname === "/favicon.ico") {
      return staticFile("favicon.ico", "image/x-icon");
    }
    if (req.method === "GET" && pathname === "/favicon.svg") {
      return staticFile("favicon.svg", "image/svg+xml");
    }
    if (req.method === "GET" && pathname === "/favicon-32x32.png") {
      return staticFile("favicon-32x32.png", "image/png");
    }
    if (req.method === "GET" && pathname === "/favicon-16x16.png") {
      return staticFile("favicon-16x16.png", "image/png");
    }

    if (req.method === "GET" && pathname === "/api/auth/status") {
      return json(await getAuthStatus());
    }

    if (req.method === "POST" && pathname === "/api/auth/login") {
      if (loginInFlight) return json({ queued: true }, 202);
      loginInFlight = true;
      startLogin();
      setTimeout(() => {
        loginInFlight = false;
      }, 5 * 60 * 1000);
      return json({ started: true }, 202);
    }

    if (req.method === "POST" && pathname === "/api/auth/logout") {
      // Drop all in-memory sessions — chat without auth would fail anyway.
      sessions.clear();
      const result = await logout();
      if (!result.ok) {
        return json({ error: result.error || "登出失敗" }, 500);
      }
      // Clear the login-in-flight gate so the next /api/auth/login starts
      // a fresh `claude auth login` instead of being deduped.
      loginInFlight = false;
      return json({ ok: true });
    }

    if (req.method === "POST" && pathname === "/api/upload") {
      let form: FormData;
      try {
        form = await req.formData();
      } catch {
        return json({ error: "Invalid multipart body" }, 400);
      }
      const file = form.get("file");
      if (!(file instanceof File)) return json({ error: "No file uploaded" }, 400);
      if (file.size === 0) return json({ error: "Empty file" }, 400);
      if (file.size > MAX_FILE_BYTES) {
        return json({ error: `File too large (max ${MAX_FILE_BYTES} bytes)` }, 400);
      }
      if (!file.name.toLowerCase().endsWith(".txt")) {
        return json({ error: "Only .txt files are supported" }, 400);
      }
      const content = await file.text();
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, {
        filename: file.name,
        content,
        started: false,
      });
      return json({
        sessionId,
        filename: file.name,
        charCount: content.length,
      });
    }

    if (req.method === "POST" && pathname === "/api/import/youtube") {
      let body: { url?: string };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const url = (body.url ?? "").trim();
      if (!url) return json({ error: "缺少 url" }, 400);
      try {
        const { videoId, videoTitle, langUsed, text } = await fetchYouTubeTranscript(url);
        if (text.length > MAX_FILE_BYTES) {
          return json({ error: "字幕長度超過 5MB 上限" }, 413);
        }
        const filename = videoTitle?.trim() ? `${videoTitle.trim()}.txt` : `yt-${videoId}.txt`;
        const sessionId = crypto.randomUUID();
        sessions.set(sessionId, { filename, content: text, started: false });
        return json({ sessionId, filename, charCount: text.length, videoId, langUsed });
      } catch (e: any) {
        return json({ error: e?.message ?? "抓取字幕失敗" }, 502);
      }
    }

    const fileMatch = pathname.match(/^\/api\/file\/([^\/]+)$/);
    if (req.method === "GET" && fileMatch) {
      const sid = fileMatch[1];
      if (!UUID_RE.test(sid)) return json({ error: "Invalid sessionId" }, 400);
      const s = sessions.get(sid);
      if (!s) return json({ error: "Session not found" }, 404);
      return json({ filename: s.filename, content: s.content });
    }

    if (req.method === "POST" && pathname === "/api/chat") {
      let body: { sessionId?: string; message?: string; selection?: string };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      const { sessionId, message, selection } = body;
      if (!sessionId || !UUID_RE.test(sessionId)) {
        return json({ error: "Invalid sessionId" }, 400);
      }
      if (!sessions.has(sessionId)) {
        return json({ error: "Session not found (server may have restarted)" }, 404);
      }
      if (!message || !message.trim()) {
        return json({ error: "Empty message" }, 400);
      }
      return chatStream(sessionId, message, selection);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`reading-room listening on http://localhost:${PORT}`);
