import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.resolve(process.env.LOCALGPT_DATA_DIR || path.join(__dirname, "chats"));
const PORT = Number(process.env.LOCALGPT_PORT || 4317);
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
const CODEX_PREFIX_ARGS = process.platform === "win32" && CODEX_COMMAND === process.execPath ? [CODEX_JS] : [];

await fs.mkdir(DATA_ROOT, { recursive: true });

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

function makeAuthToken() {
  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const signature = crypto.createHmac("sha256", authSecret).update(String(expires)).digest("base64url");
  return `${expires}.${signature}`;
}

function hasValidAuth(req) {
  if (!accessPassword) return true;
  const token = parseCookies(req.headers.cookie).localgpt_auth;
  if (!token) return false;
  const [expires, signature] = token.split(".");
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  const expected = crypto.createHmac("sha256", authSecret).update(expires).digest("base64url");
  return safeEqual(signature, expected);
}

function requireAuth(req, res, next) {
  if (hasValidAuth(req)) return next();
  res.status(401).json({ error: "需要访问密码" });
}

app.get("/api/auth/status", (req, res) => {
  res.json({ required: Boolean(accessPassword), authenticated: hasValidAuth(req), lanMode: LAN_MODE });
});

app.post("/api/auth/login", (req, res) => {
  if (!accessPassword || safeEqual(req.body.password || "", accessPassword)) {
    res.setHeader(
      "Set-Cookie",
      `localgpt_auth=${makeAuthToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 60 * 60}`,
    );
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "密码不正确" });
});

app.use("/api", requireAuth);

function chatDir(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("无效的会话 ID");
  const resolved = path.resolve(DATA_ROOT, id);
  if (path.dirname(resolved) !== DATA_ROOT) throw new Error("路径超出数据目录");
  return resolved;
}

function metaPath(id) {
  return path.join(chatDir(id), ".localgpt", "chat.json");
}

async function readMeta(id) {
  return JSON.parse(await fs.readFile(metaPath(id), "utf8"));
}

async function writeMeta(meta) {
  meta.updatedAt = new Date().toISOString();
  const destination = metaPath(meta.id);
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

async function listChats() {
  const entries = await fs.readdir(DATA_ROOT, { withFileTypes: true });
  const chats = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        const meta = await readMeta(entry.name);
        return {
          id: meta.id,
          title: meta.title,
          model: meta.model,
          reasoningEffort: meta.reasoningEffort,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          messageCount: meta.messages?.length || 0,
          running: activeRuns.has(meta.id),
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
  return { model: get("model") || "", reasoningEffort: get("model_reasoning_effort") || "medium" };
}

const codexDefaults = readCodexDefaults();
const suggestedModels = [...new Set([
  codexDefaults.model,
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
].filter(Boolean))];

app.get("/api/config", (req, res) => {
  res.json({
    dataRoot: DATA_ROOT,
    host: HOST,
    port: PORT,
    lanMode: LAN_MODE,
    defaultModel: codexDefaults.model,
    defaultReasoningEffort: codexDefaults.reasoningEffort,
    suggestedModels,
    maxUploadMb: MAX_UPLOAD_MB,
  });
});

app.get("/api/chats", async (req, res, next) => {
  try {
    res.json(await listChats());
  } catch (error) { next(error); }
});

app.post("/api/chats", async (req, res, next) => {
  try {
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const id = `chat-${stamp}-${crypto.randomBytes(2).toString("hex")}`;
    const meta = {
      version: 1,
      id,
      title: cleanTitle(req.body.title),
      model: String(req.body.model || codexDefaults.model || ""),
      reasoningEffort: String(req.body.reasoningEffort || codexDefaults.reasoningEffort || "medium"),
      codexThreadId: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      messages: [],
    };
    await fs.mkdir(chatDir(id), { recursive: true });
    await writeMeta(meta);
    res.status(201).json(meta);
  } catch (error) { next(error); }
});

app.get("/api/chats/:id", async (req, res, next) => {
  try {
    const meta = await readMeta(req.params.id);
    res.json({ ...meta, running: activeRuns.has(meta.id) });
  } catch (error) { next(error); }
});

app.patch("/api/chats/:id", async (req, res, next) => {
  try {
    const meta = await readMeta(req.params.id);
    if (req.body.title !== undefined) meta.title = cleanTitle(req.body.title);
    if (req.body.model !== undefined) meta.model = String(req.body.model).trim();
    if (req.body.reasoningEffort !== undefined) meta.reasoningEffort = normalizeEffort(req.body.reasoningEffort);
    if (req.body.resetThread === true && !activeRuns.has(meta.id)) meta.codexThreadId = null;
    await writeMeta(meta);
    res.json(meta);
  } catch (error) { next(error); }
});

app.delete("/api/chats/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (activeRuns.has(id)) return res.status(409).json({ error: "请先停止这个会话中的任务" });
    const directory = chatDir(id);
    await readMeta(id);
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
    res.json(await walkFiles(chatDir(req.params.id)));
  } catch (error) { next(error); }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 30 },
});

function safeFileName(original) {
  const base = path.basename(String(original || ""));
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

app.post("/api/chats/:id/files", upload.array("files", 30), async (req, res, next) => {
  try {
    const directory = chatDir(req.params.id);
    await readMeta(req.params.id);
    const saved = [];
    for (const file of req.files || []) {
      const destination = await availablePath(directory, safeFileName(file.originalname));
      await fs.writeFile(destination, file.buffer, { flag: "wx" });
      saved.push({ name: path.basename(destination), size: file.size });
    }
    res.status(201).json(saved);
  } catch (error) { next(error); }
});

function resolveChatFile(id, relative) {
  const root = chatDir(id);
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
    const root = chatDir(req.params.id);
    const file = await assertRealChatFile(root, resolveChatFile(req.params.id, req.query.path));
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error("不是文件");
    res.download(file);
  } catch (error) { next(error); }
});

app.delete("/api/chats/:id/file", async (req, res, next) => {
  try {
    const root = chatDir(req.params.id);
    const file = await assertRealChatFile(root, resolveChatFile(req.params.id, req.query.path));
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error("不是文件");
    await fs.unlink(file);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

function ndjson(res, payload) {
  if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(payload)}\n`);
}

function activityFromEvent(event) {
  const item = event.item || {};
  if (event.type === "turn.started") return "Codex 正在思考…";
  if (event.type === "item.started" && item.type === "command_execution") return "正在执行命令…";
  if (event.type === "item.completed" && item.type === "command_execution") return "命令执行完成";
  if (event.type === "item.started" && item.type === "mcp_tool_call") return "正在调用工具…";
  if (event.type === "item.completed" && item.type === "mcp_tool_call") return "工具调用完成";
  if (event.type === "item.completed" && item.type === "reasoning") return "推理完成，正在组织回答…";
  return null;
}

function normalizeEffort(value) {
  const effort = String(value || "medium").toLowerCase();
  return ["low", "medium", "high", "xhigh"].includes(effort) ? effort : "medium";
}

function codexArgs(meta, prompt) {
  const common = ["--json", "--skip-git-repo-check", "-c", 'approval_policy="never"'];
  if (meta.model) common.push("-m", meta.model);
  if (meta.reasoningEffort) common.push("-c", `model_reasoning_effort="${normalizeEffort(meta.reasoningEffort)}"`);
  if (meta.codexThreadId) {
    return ["exec", "resume", ...common, meta.codexThreadId, "-"];
  }
  return ["exec", ...common, "-s", "workspace-write", "-C", chatDir(meta.id), "-"];
}

app.post("/api/chats/:id/messages", async (req, res, next) => {
  let meta;
  try {
    meta = await readMeta(req.params.id);
    if (activeRuns.has(meta.id)) return res.status(409).json({ error: "这个会话已有任务在运行" });
    const content = String(req.body.content || "").trim();
    if (!content) return res.status(400).json({ error: "消息不能为空" });
    if (content.length > 100_000) return res.status(413).json({ error: "消息过长" });

    if (req.body.model !== undefined) meta.model = String(req.body.model).trim();
    if (req.body.reasoningEffort !== undefined) meta.reasoningEffort = normalizeEffort(req.body.reasoningEffort);
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

    const child = spawn(CODEX_COMMAND, [...CODEX_PREFIX_ARGS, ...codexArgs(meta, content)], {
      cwd: chatDir(meta.id),
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    const run = { child, stopping: false };
    activeRuns.set(meta.id, run);
    child.stdin.end(content);

    let finalText = "";
    let stderr = "";
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", async (line) => {
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started" && event.thread_id && !meta.codexThreadId) {
          meta.codexThreadId = event.thread_id;
          await writeMeta(meta);
          ndjson(res, { type: "thread.started", threadId: event.thread_id });
        }
        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          finalText += `${event.item.text || ""}\n`;
        }
        const activity = activityFromEvent(event);
        if (activity) ndjson(res, { type: "activity", text: activity });
        if (event.type === "turn.completed") {
          run.usage = event.usage || null;
          ndjson(res, { type: "usage", usage: run.usage });
        }
      } catch {
        // Ignore non-JSON diagnostic output on stdout.
      }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.on("error", (error) => { stderr += `\n${error.message}`; });
    child.on("close", async (code) => {
      activeRuns.delete(meta.id);
      finalText = finalText.trim();
      if (finalText) {
        const assistantMessage = message("assistant", finalText, {
          model: meta.model || null,
          usage: run.usage || null,
        });
        meta.messages.push(assistantMessage);
        await writeMeta(meta);
        ndjson(res, { type: "assistant.message", message: assistantMessage });
      }
      if (run.stopping) {
        ndjson(res, { type: "stopped" });
      } else if (code !== 0) {
        ndjson(res, { type: "error", error: stderr.trim() || `Codex 异常退出（代码 ${code}）` });
      }
      ndjson(res, { type: "done", code, usage: run.usage || null });
      res.end();
    });
  } catch (error) {
    if (res.headersSent) {
      ndjson(res, { type: "error", error: error.message });
      res.end();
    } else next(error);
  }
});

app.post("/api/chats/:id/stop", async (req, res, next) => {
  try {
    const run = activeRuns.get(req.params.id);
    if (!run) return res.json({ ok: true, running: false });
    run.stopping = true;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(run.child.pid), "/T", "/F"], { windowsHide: true });
      killer.on("error", () => run.child.kill());
    } else {
      run.child.kill("SIGTERM");
    }
    res.json({ ok: true, running: true });
  } catch (error) { next(error); }
});

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
  console.log(`\nLocalGPT 已启动`);
  console.log(`本机访问: http://127.0.0.1:${PORT}`);
  if (LAN_MODE) {
    for (const address of localAddresses()) console.log(`手机访问: http://${address}:${PORT}`);
    console.log(`访问密码: ${accessPassword}`);
    if (!configuredPassword) console.log("提示: 本次密码为随机生成，重启后会变化。可设置 LOCALGPT_PASSWORD 固定密码。");
  }
  console.log(`会话目录: ${DATA_ROOT}\n`);
});
