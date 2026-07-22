import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { CodexAppServer } from "./codex-app-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.resolve(process.env.LOCALGPT_DATA_DIR || path.join(__dirname, "chats"));
const USERS_ROOT = path.join(DATA_ROOT, "users");
const PORT = Number(process.env.LOCALGPT_PORT || 4317);
const MODEL_ID = "gpt-5.6-sol";
const LAN_MODE = process.argv.includes("--lan") || process.env.LOCALGPT_LAN === "1";
const HOST = process.env.LOCALGPT_HOST || (LAN_MODE ? "0.0.0.0" : "127.0.0.1");
const MAX_UPLOAD_MB = Number(process.env.LOCALGPT_MAX_UPLOAD_MB || 100);
const configuredPassword = process.env.LOCALGPT_PASSWORD?.trim();
const accessPassword = LAN_MODE
  ? configuredPassword || crypto.randomBytes(9).toString("base64url")
  : configuredPassword || "";
const authSecret = crypto.randomBytes(32);
const activeRuns = new Map();
const CODEX_JS = process.platform === "win32"
  ? path.join(process.env.APPDATA || "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
  : null;
const CODEX_COMMAND = process.platform === "win32" && fsSync.existsSync(CODEX_JS) ? process.execPath : "codex";
const CODEX_PREFIX_ARGS = [
  ...(process.platform === "win32" && CODEX_COMMAND === process.execPath ? [CODEX_JS] : []),
  "-c",
  "sandbox_workspace_write.network_access=true",
  "-c",
  "shell_environment_policy.inherit=all",
];

function makeCodexEnvironment() {
  const proxyUrl = String(
    process.env.LOCALGPT_PROXY_URL
      || process.env.PROXY_URL
      || process.env.HTTPS_PROXY
      || process.env.HTTP_PROXY
      || "",
  ).trim();
  const noProxy = String(process.env.NO_PROXY || process.env.no_proxy || "localhost,127.0.0.1,::1").trim();
  const env = {
    ...process.env,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY || "1",
  };
  if (proxyUrl) {
    Object.assign(env, {
      PROXY_URL: proxyUrl,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      ALL_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      all_proxy: proxyUrl,
    });
  }
  return { env, proxyUrl };
}

function proxyLabel(value) {
  if (!value) return "未配置";
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "已配置";
  }
}

function normalizeWebSearchMode(value) {
  const mode = String(value || "off").toLowerCase();
  return ["on", "off"].includes(mode) ? mode : "off";
}

const codexEnvironment = makeCodexEnvironment();
const CHAT_DEVELOPER_INSTRUCTIONS = `You are being used through MyGPT as a general chat assistant.
Always provide a complete, self-contained final answer in the chat, even when you used tools or changed files.
Honor the per-turn [MyGPT search mode] input. Mode off overrides all later search instructions: do not use any network command. Mode on allows network research when the request needs current or external information; do not search when it is unnecessary.
When the user asks for code, include the complete requested code in fenced code blocks in the final answer. Never replace the answer with only a statement that code was written to a file.
Prefer answering in chat. Do not create or modify files unless the user explicitly asks for file changes or file creation.
Uploaded files in the workspace may be read when relevant. Summarize findings and results in the final answer.
Use concise progress updates during longer work, then give the full result. Respond in the user's language.
When search mode is on and current or external information is needed, invoke Node.js 24's built-in global fetch through the shell with the configured proxy to retrieve and cross-check reliable public sources. Set NODE_USE_ENV_PROXY=1 and pass HTTP_PROXY, HTTPS_PROXY, and ALL_PROXY from PROXY_URL (or http://127.0.0.1:10809 when PROXY_URL is empty) in the same command. Do not use web_search, PowerShell, curl, or another HTTP client. Cite useful source links. Do not claim that live lookup is unavailable before attempting this Node.js path.
On Windows, use the native PowerShell host directly. Do not wrap commands in cmd.exe /c or another powershell.exe -Command unless a .cmd/.bat file or CMD built-in genuinely requires it. Keep command syntax consistently PowerShell so quotes, pipes, dollar signs, and parentheses are parsed only once.
When a shell command must make an HTTP(S) request, use only Node.js 24's built-in global fetch with the configured proxy. Do not use PowerShell, curl, undici, ProxyAgent, proxy-agent, or another HTTP client.
Use standard Markdown tables without blank lines between table rows. Write math with LaTeX delimiters \\( ... \\) for inline formulas and \\[ ... \\] for display formulas so MyGPT can render it cleanly.`;
const codexAppServer = new CodexAppServer({
  command: CODEX_COMMAND,
  prefixArgs: CODEX_PREFIX_ARGS,
  cwd: __dirname,
  env: codexEnvironment.env,
});

await fs.mkdir(USERS_ROOT, { recursive: true });

async function migrateLegacyChats() {
  const legacyRoleRoot = path.join(USERS_ROOT, "default");
  await fs.mkdir(legacyRoleRoot, { recursive: true });
  const entries = await fs.readdir(DATA_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "users" || !/^chat-[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
    const source = path.join(DATA_ROOT, entry.name);
    const destination = path.join(legacyRoleRoot, entry.name);
    try { await fs.access(destination); } catch { await fs.rename(source, destination); }
  }
}

await migrateLegacyChats();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const at = part.indexOf("=");
      return [decodeURIComponent(part.slice(0, at)), decodeURIComponent(part.slice(at + 1))];
    }),
  );
}

function normalizeRole(value) {
  const role = String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .toLowerCase()
    .slice(0, 64);
  if (!role || role === "." || role === "..") throw new Error("请输入有效的登录用户名");
  return role;
}

function encodeRole(role) {
  return Buffer.from(role, "utf8").toString("base64url");
}

function decodeRole(value) {
  try { return normalizeRole(Buffer.from(value, "base64url").toString("utf8")); } catch { return ""; }
}

function makeAuthToken(role) {
  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const encodedRole = encodeRole(role);
  const signature = crypto.createHmac("sha256", authSecret).update(`${expires}.${encodedRole}`).digest("base64url");
  return `${expires}.${encodedRole}.${signature}`;
}

function authSession(req) {
  const token = parseCookies(req.headers.cookie).localgpt_auth;
  if (!token) return null;
  const [expires, encodedRole, signature] = token.split(".");
  const role = decodeRole(encodedRole || "");
  if (!expires || !encodedRole || !signature || !role || Number(expires) < Date.now()) return null;
  const expected = crypto.createHmac("sha256", authSecret).update(`${expires}.${encodedRole}`).digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  return { role, expires: Number(expires) };
}

function hasValidAuth(req) {
  return Boolean(authSession(req));
}

function requestRole(req) {
  const session = authSession(req);
  if (!session) throw new Error("需要先登录用户名");
  return session.role;
}

function requireAuth(req, res, next) {
  if (hasValidAuth(req)) return next();
  res.status(401).json({ error: "需要先登录用户名" });
}

app.get("/api/auth/status", (req, res) => {
  const session = authSession(req);
  res.json({
    required: true,
    passwordRequired: Boolean(accessPassword),
    authenticated: Boolean(session),
    role: session?.role || "",
    lanMode: LAN_MODE,
  });
});

app.post("/api/auth/login", (req, res) => {
  let role;
  try { role = normalizeRole(req.body.role); } catch (error) { return res.status(400).json({ error: error.message }); }
  if (accessPassword && !safeEqual(req.body.password || "", accessPassword)) {
    return res.status(401).json({ error: "密码不正确" });
  }
  res.setHeader(
    "Set-Cookie",
    `localgpt_auth=${makeAuthToken(role)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 60 * 60}`,
  );
  return res.json({ ok: true, role });
});

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", "localgpt_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.use("/api", requireAuth);

function roleDir(role) {
  const normalized = normalizeRole(role);
  const resolved = path.resolve(USERS_ROOT, normalized);
  if (path.dirname(resolved) !== USERS_ROOT) throw new Error("角色路径超出数据目录");
  return resolved;
}

function chatDir(id, role) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("无效的会话 ID");
  const resolved = path.resolve(roleDir(role), id);
  if (path.dirname(resolved) !== roleDir(role)) throw new Error("路径超出数据目录");
  return resolved;
}

function metaPath(id, role) {
  return path.join(chatDir(id, role), ".localgpt", "chat.json");
}

function collapseRepeatedAssistantTail(value) {
  let lines = String(value || "").replace(/\r\n?/g, "\n").trim().split("\n");
  let collapsed = true;
  while (collapsed && lines.length >= 8) {
    collapsed = false;
    for (let secondStart = Math.ceil(lines.length / 2); secondStart < lines.length; secondStart += 1) {
      const blockLength = lines.length - secondStart;
      for (let gap = 0; gap <= 2; gap += 1) {
        const firstEnd = secondStart - gap;
        const firstStart = firstEnd - blockLength;
        if (firstStart < 0) continue;
        if (gap && lines.slice(firstEnd, secondStart).some((line) => line.trim())) continue;
        const first = lines.slice(firstStart, firstEnd).join("\n").trim();
        const second = lines.slice(secondStart).join("\n").trim();
        if (first.length < 500 || first !== second) continue;
        lines = lines.slice(0, secondStart);
        collapsed = true;
        break;
      }
      if (collapsed) break;
    }
  }
  return lines.join("\n").trim();
}

function responseMessages(messages = []) {
  return messages.map((item) => item.role === "assistant"
    ? { ...item, content: collapseRepeatedAssistantTail(item.content) }
    : item);
}

async function readMeta(id, role) {
  const meta = JSON.parse(await fs.readFile(metaPath(id, role), "utf8"));
  meta.model = MODEL_ID;
  meta.webSearchMode = normalizeWebSearchMode(meta.webSearchMode);
  return meta;
}

async function writeMeta(meta) {
  meta.updatedAt = new Date().toISOString();
  const destination = metaPath(meta.id, meta.userRole);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, JSON.stringify(meta, null, 2), "utf8");
}

function cleanTitle(value) {
  const title = String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 80);
  return title || "新对话";
}

function message(role, content, extra = {}) {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

function runKey(role, id) { return `${normalizeRole(role)}:${id}`; }

async function listChats(role) {
  const root = roleDir(role);
  await fs.mkdir(root, { recursive: true });
  const entries = await fs.readdir(root, { withFileTypes: true });
  const chats = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        const meta = await readMeta(entry.name, role);
        return {
          id: meta.id,
          title: meta.title,
          model: meta.model,
          reasoningEffort: meta.reasoningEffort,
          webSearchMode: normalizeWebSearchMode(meta.webSearchMode),
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          messageCount: meta.messages?.length || 0,
          running: activeRuns.has(runKey(role, meta.id)),
        };
      } catch {
        return null;
      }
    }),
  );
  return chats.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function readCodexDefaults() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");
  let config = "";
  try {
    config = fsSync.readFileSync(configPath, "utf8");
  } catch {
    // Codex will choose its own defaults.
  }
  const get = (key) => config.match(new RegExp(`^\\s*${key}\\s*=\\s*\"([^\"]+)\"`, "m"))?.[1];
  return { model: MODEL_ID, reasoningEffort: get("model_reasoning_effort") || "medium" };
}

const codexDefaults = { ...readCodexDefaults(), model: MODEL_ID, reasoningEffort: "medium" };
const suggestedModels = [MODEL_ID];

app.get("/api/config", (req, res) => {
  res.json({
    dataRoot: DATA_ROOT,
    userRole: requestRole(req),
    host: HOST,
    port: PORT,
    lanMode: LAN_MODE,
    defaultModel: MODEL_ID,
    defaultReasoningEffort: codexDefaults.reasoningEffort,
    defaultWebSearchMode: "off",
    suggestedModels,
    maxUploadMb: MAX_UPLOAD_MB,
  });
});

app.get("/api/chats", async (req, res, next) => {
  try {
    res.json(await listChats(requestRole(req)));
  } catch (error) { next(error); }
});

app.post("/api/chats", async (req, res, next) => {
  try {
    const userRole = requestRole(req);
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const id = `chat-${stamp}-${crypto.randomBytes(2).toString("hex")}`;
    const meta = {
      version: 1,
      id,
      userRole,
      title: cleanTitle(req.body.title),
      model: MODEL_ID,
      reasoningEffort: String(req.body.reasoningEffort || codexDefaults.reasoningEffort || "medium"),
      webSearchMode: normalizeWebSearchMode(req.body.webSearchMode),
      codexThreadId: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      messages: [],
    };
    await fs.mkdir(chatDir(id, userRole), { recursive: true });
    await writeMeta(meta);
    res.status(201).json(meta);
  } catch (error) { next(error); }
});

app.get("/api/chats/:id", async (req, res, next) => {
  try {
    const userRole = requestRole(req);
    const meta = await readMeta(req.params.id, userRole);
    res.json({ ...meta, messages: responseMessages(meta.messages), running: activeRuns.has(runKey(userRole, meta.id)) });
  } catch (error) { next(error); }
});

app.patch("/api/chats/:id", async (req, res, next) => {
  try {
    const userRole = requestRole(req);
    const meta = await readMeta(req.params.id, userRole);
    if (req.body.title !== undefined) meta.title = cleanTitle(req.body.title);
    meta.model = MODEL_ID;
    if (req.body.reasoningEffort !== undefined) meta.reasoningEffort = normalizeEffort(req.body.reasoningEffort);
    if (req.body.webSearchMode !== undefined) meta.webSearchMode = normalizeWebSearchMode(req.body.webSearchMode);
    if (req.body.resetThread === true && !activeRuns.has(runKey(userRole, meta.id))) meta.codexThreadId = null;
    await writeMeta(meta);
    res.json({ ...meta, messages: responseMessages(meta.messages) });
  } catch (error) { next(error); }
});

app.delete("/api/chats/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const userRole = requestRole(req);
    if (activeRuns.has(runKey(userRole, id))) return res.status(409).json({ error: "请先停止这个会话中的任务" });
    const directory = chatDir(id, userRole);
    await readMeta(id, userRole);
    await fs.rm(directory, { recursive: true, force: false });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

async function walkFiles(root, current = root, results = []) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (current === root && entry.name === ".localgpt") continue;
    const full = path.join(current, entry.name);
    const relative = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      await walkFiles(root, full, results);
    } else if (entry.isFile()) {
      const stat = await fs.stat(full);
      results.push({ name: entry.name, path: relative, size: stat.size, updatedAt: stat.mtime.toISOString() });
    }
    if (results.length >= 1000) break;
  }
  return results;
}

app.get("/api/chats/:id/files", async (req, res, next) => {
  try {
    res.json(await walkFiles(chatDir(req.params.id, requestRole(req))));
  } catch (error) { next(error); }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 30 },
});

function decodeMultipartFileName(value) {
  const original = String(value || "");
  if (!original || [...original].some((char) => char.codePointAt(0) > 0xff)) return original;
  const decoded = Buffer.from(original, "latin1").toString("utf8");
  if (decoded.includes("\ufffd")) return original;
  return Buffer.from(decoded, "utf8").toString("latin1") === original ? decoded : original;
}

function safeFileName(original) {
  const base = path.basename(decodeMultipartFileName(original));
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().slice(0, 180) || "file";
}

async function availablePath(directory, filename) {
  const parsed = path.parse(filename);
  let candidate = path.join(directory, filename);
  let index = 2;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(directory, `${parsed.name} (${index++})${parsed.ext}`);
    } catch {
      return candidate;
    }
  }
}

async function repairMojibakeFileNames(directory = USERS_ROOT) {
  let repaired = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".localgpt") continue;
    const source = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      repaired += await repairMojibakeFileNames(source);
      continue;
    }
    if (!entry.isFile()) continue;
    const decoded = safeFileName(entry.name);
    if (decoded === entry.name) continue;
    const destination = await availablePath(directory, decoded);
    await fs.rename(source, destination);
    repaired += 1;
  }
  return repaired;
}

const repairedFileNames = await repairMojibakeFileNames();

app.post("/api/chats/:id/files", upload.array("files", 30), async (req, res, next) => {
  try {
    const userRole = requestRole(req);
    const directory = chatDir(req.params.id, userRole);
    await readMeta(req.params.id, userRole);
    const saved = [];
    for (const file of req.files || []) {
      const destination = await availablePath(directory, safeFileName(file.originalname));
      await fs.writeFile(destination, file.buffer, { flag: "wx" });
      saved.push({ name: path.basename(destination), size: file.size });
    }
    res.status(201).json(saved);
  } catch (error) { next(error); }
});

function resolveChatFile(id, role, relative) {
  const root = chatDir(id, role);
  const resolved = path.resolve(root, String(relative || ""));
  if (resolved === root || !resolved.startsWith(root + path.sep) || resolved.startsWith(path.join(root, ".localgpt"))) {
    throw new Error("无效的文件路径");
  }
  return resolved;
}

async function assertRealChatFile(root, file) {
  const realRoot = await fs.realpath(root);
  const realFile = await fs.realpath(file);
  if (!realFile.startsWith(realRoot + path.sep) || realFile.startsWith(path.join(realRoot, ".localgpt") + path.sep)) {
    throw new Error("文件路径超出会话目录");
  }
  return realFile;
}

app.get("/api/chats/:id/file", async (req, res, next) => {
  try {
    const role = requestRole(req);
    const root = chatDir(req.params.id, role);
    const file = await assertRealChatFile(root, resolveChatFile(req.params.id, role, req.query.path));
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error("不是文件");
    res.download(file);
  } catch (error) { next(error); }
});

app.delete("/api/chats/:id/file", async (req, res, next) => {
  try {
    const role = requestRole(req);
    const root = chatDir(req.params.id, role);
    const file = await assertRealChatFile(root, resolveChatFile(req.params.id, role, req.query.path));
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error("不是文件");
    await fs.unlink(file);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

function ndjson(res, payload) {
  if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(payload)}\n`);
}

function normalizeEffort(value) {
  const effort = String(value || "medium").toLowerCase();
  return ["low", "medium", "high", "xhigh"].includes(effort) ? effort : "medium";
}

function shortText(value, max = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function runProgress(run, stage, label, detail = "", status = "running") {
  run.lastActivityAt = Date.now();
  ndjson(run.res, {
    type: "progress",
    stage,
    label,
    detail: shortText(detail),
    status,
    at: new Date().toISOString(),
  });
}

function startRunHeartbeat(run) {
  run.heartbeatTimer = setInterval(() => {
    const quietForMs = Date.now() - run.lastActivityAt;
    if (quietForMs < 8000) return;
    ndjson(run.res, {
      type: "heartbeat",
      quietForMs,
      text: "连接正常，Codex 仍在处理",
      at: new Date().toISOString(),
    });
  }, 10000);
  run.heartbeatTimer.unref?.();
}

function stopRunHeartbeat(run) {
  if (run?.heartbeatTimer) clearInterval(run.heartbeatTimer);
  if (run) run.heartbeatTimer = null;
}

function runForEvent(params = {}) {
  for (const run of activeRuns.values()) {
    if (run.threadId && params.threadId === run.threadId && (!run.turnId || !params.turnId || params.turnId === run.turnId)) return run;
  }
  return null;
}

function finalTextForRun(run) {
  const items = [...run.agentItems.values()];
  const explicitFinalItems = items.filter((item) => item.phase === "final_answer" && item.text?.trim());
  const candidates = explicitFinalItems.length
    ? explicitFinalItems
    : items.filter((item) => item.phase === null && item.text?.trim()).slice(-1);
  const seen = new Set();
  return collapseRepeatedAssistantTail(candidates
    .map((item) => item.text.trim())
    .filter((text) => {
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    })
    .join("\n")
    .trim());
}

function syncFinalText(run) {
  const text = finalTextForRun(run);
  if (text === run.sentText) return;
  if (text.startsWith(run.sentText)) {
    ndjson(run.res, { type: "assistant.delta", delta: text.slice(run.sentText.length) });
  } else {
    ndjson(run.res, { type: "assistant.replace", text });
  }
  run.sentText = text;
  run.lastActivityAt = Date.now();
}

async function finishRun(run, status, turnError = null, durationMs = null) {
  if (run.finishPromise) return run.finishPromise;
  run.finishPromise = (async () => {
    stopRunHeartbeat(run);
    activeRuns.delete(run.key);
    const finalText = finalTextForRun(run) || run.sentText.trim();
    const reportedDurationMs = Number(durationMs);
    const totalDurationMs = Number.isFinite(reportedDurationMs) && reportedDurationMs >= 0
      ? reportedDurationMs
      : Math.max(0, Date.now() - run.startedAt);
    const completedMessages = [];
    if (finalText) {
      completedMessages.push(message("assistant", finalText, {
        model: run.meta.model || null,
        durationMs: totalDurationMs,
        usage: run.usage || null,
        interrupted: status === "interrupted",
      }));
    }
    if (status === "interrupted") {
      completedMessages.push(message("assistant", "记录已保存，继续即可", {
        interrupted: true,
        notice: true,
      }));
    }
    if (completedMessages.length) {
      run.meta.messages.push(...completedMessages);
      await writeMeta(run.meta);
      for (const assistantMessage of completedMessages) {
        ndjson(run.res, { type: "assistant.message", message: assistantMessage });
      }
    }

    if (status === "interrupted") {
      ndjson(run.res, { type: "stopped", partial: Boolean(finalText) });
    } else if (status === "failed") {
      ndjson(run.res, { type: "error", error: turnError || "Codex 本轮执行失败，请重试。" });
    } else if (!finalText) {
      ndjson(run.res, {
        type: "error",
        error: "Codex 已结束本轮，但没有返回可展示的回答正文。请重试，或换一种更明确的提问方式。",
      });
    }
    ndjson(run.res, { type: "done", status, durationMs: totalDurationMs, usage: run.usage || null });
    run.res.end();
  })().catch((error) => {
    ndjson(run.res, { type: "error", error: error.message });
    run.res.end();
  });
  return run.finishPromise;
}

codexAppServer.on("notification", (event) => {
  const params = event.params || {};
  const run = runForEvent(params);
  if (!run) return;

  if (event.method === "turn/started") {
    run.turnId ||= params.turn?.id;
    runProgress(run, "thinking", "Codex 已接收问题，正在分析");
    return;
  }

  if (event.method === "item/started") {
    const item = params.item || {};
    if (item.type === "agentMessage") {
      run.agentItems.set(item.id, { phase: item.phase ?? null, text: item.text || "" });
      if (item.phase === "final_answer") runProgress(run, "answering", "正在生成回答");
    } else if (item.type === "reasoning") {
      runProgress(run, "thinking", "正在分析问题");
    } else if (item.type === "commandExecution") {
      runProgress(run, "tool", "正在执行命令", item.command);
    } else if (item.type === "fileChange") {
      runProgress(run, "file", "正在处理文件");
    } else if (item.type === "mcpToolCall") {
      runProgress(run, "tool", "正在调用工具", `${item.server || ""} ${item.tool || ""}`);
    } else if (item.type === "webSearch") {
      runProgress(run, "search", "正在搜索信息");
    }
    return;
  }

  if (event.method === "item/agentMessage/delta") {
    const item = run.agentItems.get(params.itemId) || { phase: null, text: "" };
    item.text += params.delta || "";
    run.agentItems.set(params.itemId, item);
    if (item.phase === "commentary") {
      const now = Date.now();
      if (!run.lastCommentaryAt || now - run.lastCommentaryAt > 300 || item.text.endsWith("\n")) {
        run.lastCommentaryAt = now;
        runProgress(run, "update", "Codex 进度", item.text.slice(-220));
      }
    } else {
      syncFinalText(run);
    }
    return;
  }

  if (event.method === "item/completed") {
    const item = params.item || {};
    if (item.type === "agentMessage") {
      const state = run.agentItems.get(item.id) || { phase: item.phase ?? null, text: "" };
      state.phase = item.phase ?? state.phase;
      state.text = item.text || state.text;
      run.agentItems.set(item.id, state);
      if (state.phase === "commentary") runProgress(run, "update", "进度更新", state.text, "completed");
      else syncFinalText(run);
    } else if (item.type === "commandExecution") {
      const ok = item.exitCode === 0 || item.status === "completed";
      const detail = ok
        ? "命令结果已返回，连接正常，Codex 正在继续分析"
        : `命令已结束${item.exitCode !== null ? `，退出码 ${item.exitCode}` : ""}，Codex 正在处理结果`;
      runProgress(run, "tool", detail, item.command, ok ? "completed" : "warning");
    } else if (item.type === "fileChange") {
      runProgress(run, "file", "文件处理完成，正在组织回答", "", "completed");
    } else if (item.type === "mcpToolCall") {
      runProgress(run, "tool", "工具调用完成，正在继续处理", item.tool, "completed");
    } else if (item.type === "reasoning") {
      runProgress(run, "thinking", "分析完成，正在生成回答", "", "completed");
    }
    return;
  }

  if (event.method === "item/reasoning/summaryTextDelta") {
    runProgress(run, "thinking", "正在深入分析");
    return;
  }

  if (event.method === "thread/tokenUsage/updated") {
    run.usage = params.tokenUsage || null;
    ndjson(run.res, { type: "usage", usage: run.usage });
    return;
  }

  if (event.method === "warning" || event.method === "configWarning") {
    runProgress(run, "warning", "Codex 提示", params.message || params.warning || "", "warning");
    return;
  }

  if (event.method === "error") {
    runProgress(run, "warning", "Codex 遇到问题，正在尝试恢复", params.message || "", "warning");
    return;
  }

  if (event.method === "turn/completed") {
    const status = params.turn?.status || "failed";
    const error = params.turn?.error?.message || params.turn?.error?.additionalDetails || null;
    finishRun(run, status, error, params.turn?.durationMs || null);
  }
});

codexAppServer.on("exit", (error) => {
  console.error(`Codex app-server 连接中断: ${error.message}`);
  for (const run of activeRuns.values()) finishRun(run, "failed", error.message);
});

async function openCodexThread(run) {
  const cwd = chatDir(run.meta.id, run.role);
  const common = {
    model: run.meta.model || null,
    cwd,
    runtimeWorkspaceRoots: [cwd],
    approvalPolicy: "never",
    sandbox: "workspace-write",
    developerInstructions: CHAT_DEVELOPER_INSTRUCTIONS,
    config: {
      model_reasoning_effort: normalizeEffort(run.meta.reasoningEffort),
      web_search: "disabled",
    },
  };
  let result;
  if (run.meta.codexThreadId) {
    try {
      result = await codexAppServer.request("thread/resume", {
        threadId: run.meta.codexThreadId,
        ...common,
        excludeTurns: true,
      }, 60000);
    } catch (error) {
      runProgress(run, "reconnect", "旧会话无法恢复，正在创建新的 Codex 会话", error.message, "warning");
      run.meta.codexThreadId = null;
    }
  }
  if (!result) result = await codexAppServer.request("thread/start", { ...common, ephemeral: false }, 60000);
  run.threadId = result.thread.id;
  if (run.meta.codexThreadId !== run.threadId) {
    run.meta.codexThreadId = run.threadId;
    await writeMeta(run.meta);
  }
  ndjson(run.res, { type: "thread.started", threadId: run.threadId });
}

app.post("/api/chats/:id/messages", async (req, res, next) => {
  let meta;
  try {
    const userRole = requestRole(req);
    meta = await readMeta(req.params.id, userRole);
    meta.userRole = userRole;
    if (activeRuns.has(runKey(userRole, meta.id))) return res.status(409).json({ error: "这个会话已有任务在运行" });
    const content = String(req.body.content || "").trim();
    if (!content) return res.status(400).json({ error: "消息不能为空" });
    if (content.length > 100_000) return res.status(413).json({ error: "消息过长" });

    meta.model = MODEL_ID;
    if (req.body.reasoningEffort !== undefined) meta.reasoningEffort = normalizeEffort(req.body.reasoningEffort);
    if (req.body.webSearchMode !== undefined) meta.webSearchMode = normalizeWebSearchMode(req.body.webSearchMode);
    if (meta.messages.length === 0 && meta.title === "新对话") meta.title = cleanTitle(content.slice(0, 42));
    const userMessage = message("user", content);
    meta.messages.push(userMessage);
    await writeMeta(meta);

    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    ndjson(res, { type: "user.saved", message: userMessage, chat: { title: meta.title } });

    const key = runKey(userRole, meta.id);
    const run = {
      key,
      role: userRole,
      meta,
      res,
      threadId: null,
      turnId: null,
      agentItems: new Map(),
      sentText: "",
      usage: null,
      stopping: false,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      heartbeatTimer: null,
      finishPromise: null,
    };
    activeRuns.set(key, run);
    startRunHeartbeat(run);
    runProgress(run, "connecting", "正在连接本地 Codex");

    await openCodexThread(run);
    runProgress(run, "ready", "Codex 已连接，正在提交问题");
    const result = await codexAppServer.request("turn/start", {
      threadId: run.threadId,
      clientUserMessageId: userMessage.id,
      input: [
        { type: "text", text: content, text_elements: [] },
        { type: "text", text: `[MyGPT search mode: ${meta.webSearchMode}] ${meta.webSearchMode === "on" ? "允许联网；请自行判断当前问题是否需要实时或外部信息。需要时只通过已配置代理的 Node.js global fetch 检索并交叉核验可靠公开来源，引用实际使用的来源链接。不要调用 web_search、PowerShell 或 curl。" : "禁止联网搜索以及 PowerShell/curl/Node 网络请求；仅使用已有知识和本地文件。"}`, text_elements: [] },
      ],
      cwd: chatDir(meta.id, userRole),
      approvalPolicy: "never",
      model: MODEL_ID,
      effort: normalizeEffort(meta.reasoningEffort),
    }, 60000);
    run.turnId = result.turn.id;
    if (run.stopping) {
      await codexAppServer.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
    }
  } catch (error) {
    if (meta) {
      const failedRun = activeRuns.get(runKey(meta.userRole, meta.id));
      stopRunHeartbeat(failedRun);
      activeRuns.delete(runKey(meta.userRole, meta.id));
    }
    if (res.headersSent) {
      ndjson(res, { type: "error", error: error.message });
      ndjson(res, { type: "done", status: "failed" });
      res.end();
    } else next(error);
  }
});

app.post("/api/chats/:id/stop", async (req, res, next) => {
  try {
    const run = activeRuns.get(runKey(requestRole(req), req.params.id));
    if (!run) return res.json({ ok: true, running: false });
    run.stopping = true;
    runProgress(run, "stopping", "正在停止当前回答");
    if (run.threadId && run.turnId) {
      await codexAppServer.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId }, 30000);
    }
    res.json({ ok: true, running: true });
  } catch (error) { next(error); }
});

app.use("/vendor/katex", express.static(path.join(__dirname, "node_modules", "katex", "dist")));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((error, req, res, next) => {
  console.error(error);
  const status = error.code === "ENOENT" ? 404 : error.code === "LIMIT_FILE_SIZE" ? 413 : 500;
  res.status(status).json({ error: error.message || "服务器发生错误" });
});

function localAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter(
    (item) => item && item.family === "IPv4" && !item.internal,
  ).map((item) => item.address);
}

app.listen(PORT, HOST, () => {
  console.log(`\nMyGPT 已启动`);
  console.log(`本机访问: http://127.0.0.1:${PORT}`);
  if (LAN_MODE) {
    for (const address of localAddresses()) console.log(`手机访问: http://${address}:${PORT}`);
    console.log(`访问密码: ${accessPassword}`);
    if (!configuredPassword) console.log("提示: 本次密码为随机生成，重启后会变化。可设置 LOCALGPT_PASSWORD 固定密码。");
  }
  console.log(`会话目录: ${DATA_ROOT}\n`);
  if (repairedFileNames) console.log(`已修复乱码文件名: ${repairedFileNames} 个`);
  console.log(`Codex 网络: 由会话开关控制，按需使用代理网络请求，代理: ${proxyLabel(codexEnvironment.proxyUrl)}\n`);
});
