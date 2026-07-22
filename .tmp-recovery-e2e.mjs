const baseUrl = "http://127.0.0.1:4317";
const role = `recovery_test_${Date.now()}`;
const password = process.env.LOCALGPT_TEST_PASSWORD || "";
let cookie = "";
let chatId = "";

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set("Cookie", cookie);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
}

function log(event, detail = "") {
  process.stdout.write(`${new Date().toISOString()}\t${event}\t${String(detail).replace(/\s+/g, " ").slice(0, 500)}\n`);
}

try {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, password }),
  });
  if (!login.ok) throw new Error(`login: ${login.status} ${await login.text()}`);
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  log("login", role);

  const created = await request("/api/chats", {
    method: "POST",
    body: JSON.stringify({ title: "recovery e2e", reasoningEffort: "low", webSearchMode: "on" }),
  });
  const chat = await created.json();
  chatId = chat.id;
  log("chat", chatId);

  const response = await request(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: "和我说说chatgpt最新版本5.6，里面sol terra luna区别，简要说说",
      reasoningEffort: "low",
      webSearchMode: "on",
    }),
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneEvent = null;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "progress") log("progress", `${event.label} | ${event.detail || ""}`);
      else if (event.type === "assistant.delta") log("delta", event.delta);
      else if (event.type === "assistant.replace") log("replace", event.text);
      else if (event.type === "assistant.message") log("message", event.message?.content || "");
      else if (event.type === "error") log("error", event.error || "");
      else if (event.type === "done") {
        doneEvent = event;
        log("done", event.status || "");
      }
    }
  }
  if (!doneEvent) throw new Error("stream ended without done event");
  if (doneEvent.status !== "completed") throw new Error(`run finished with ${doneEvent.status}`);
} catch (error) {
  log("fatal", error.stack || error.message || error);
  process.exitCode = 1;
} finally {
  if (chatId) {
    try { await request(`/api/chats/${encodeURIComponent(chatId)}/stop`, { method: "POST", body: "{}" }); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      await request(`/api/chats/${encodeURIComponent(chatId)}`, { method: "DELETE" });
      log("cleanup", chatId);
    } catch (error) {
      log("cleanup_failed", error.message);
    }
  }
}
