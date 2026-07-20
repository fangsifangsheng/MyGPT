const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  sidebar: $("#sidebar"),
  backdrop: $("#sidebarBackdrop"),
  chatList: $("#chatList"),
  newChat: $("#newChatButton"),
  menu: $("#menuButton"),
  closeSidebar: $("#closeSidebarButton"),
  brand: $("#brandButton"),
  conversation: $("#conversation"),
  empty: $("#emptyState"),
  messages: $("#messages"),
  scrollToBottom: $("#scrollToBottomButton"),
  form: $("#composerForm"),
  input: $("#messageInput"),
  send: $("#sendButton"),
  attach: $("#attachButton"),
  fileInput: $("#fileInput"),
  pendingFiles: $("#pendingFiles"),
  filesButton: $("#filesButton"),
  fileCount: $("#fileCountBadge"),
  rename: $("#renameButton"),
  modelButton: $("#modelButton"),
  modelName: $("#topModelName"),
  modelMenu: $("#modelMenu"),
  modelOptions: $("#modelOptions"),
  effortButton: $("#effortButton"),
  effortLabel: $("#effortLabel"),
  effortMenu: $("#effortMenu"),
  searchButton: $("#searchButton"),
  searchLabel: $("#searchLabel"),
  filesDialog: $("#filesDialog"),
  dialogUpload: $("#dialogUploadButton"),
  refreshFiles: $("#refreshFilesButton"),
  fileList: $("#fileList"),
  settingsButton: $("#settingsButton"),
  settingsDialog: $("#settingsDialog"),
  settingsContent: $("#settingsContent"),
  connectionText: $("#connectionText"),
  loginDialog: $("#loginDialog"),
  loginForm: $("#loginForm"),
  role: $("#roleInput"),
  password: $("#passwordInput"),
  passwordField: $("#passwordField"),
  loginError: $("#loginError"),
  toasts: $("#toastRegion"),
};

const effortNames = { low: "快速", medium: "标准", high: "深入", xhigh: "最深" };
const searchModeNames = { on: "开", off: "关" };
const state = {
  config: null,
  chats: [],
  current: null,
  files: [],
  running: false,
  activity: "",
  streamingText: "",
  progress: [],
  runStartedAt: null,
  lastActivityAt: null,
  lastHeartbeatAt: null,
  runStatus: "idle",
  usage: null,
  streamError: "",
  draftModel: "",
  draftEffort: "medium",
  draftSearchMode: "off",
  collapsedChatMonths: new Set(),
  followOutput: true,
  booted: false,
};

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    showLogin();
    throw new Error("需要访问密码");
  }
  if (!response.ok) {
    let error = `请求失败（${response.status}）`;
    try { error = (await response.json()).error || error; } catch {}
    throw new Error(error);
  }
  const type = response.headers.get("content-type") || "";
  return type.includes("application/json") ? response.json() : response;
}

function toast(text, type = "") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = text;
  elements.toasts.append(item);
  setTimeout(() => item.remove(), 3200);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

async function copyText(text) {
  const value = String(text ?? "");
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {}
  }

  const activeElement = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  Object.assign(textarea.style, {
    position: "fixed",
    inset: "0 auto auto 0",
    width: "1px",
    height: "1px",
    padding: "0",
    border: "0",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.append(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  activeElement?.focus?.({ preventScroll: true });
  if (!copied) throw new Error("浏览器未允许复制");
}

function copyCodeButton() {
  return `<button class="copy-code" type="button" title="复制代码" aria-label="复制代码">${icon("copy")}<span>复制</span></button>`;
}

function renderMath(value, displayMode = false) {
  const source = String(value ?? "").trim();
  const tag = displayMode ? "div" : "span";
  const className = displayMode ? "math-display" : "math-inline";
  if (!source) return "";
  try {
    if (window.katex?.renderToString) {
      const html = window.katex.renderToString(source, {
        displayMode,
        throwOnError: false,
        strict: "ignore",
        trust: false,
        output: "htmlAndMathml",
      });
      return `<${tag} class="${className}">${html}</${tag}>`;
    }
  } catch {}
  return `<${tag} class="${className} math-fallback">${escapeHtml(source)}</${tag}>`;
}

function legacyInlineMarkdown(value) {
  const code = [];
  const math = [];
  const links = [];
  let source = String(value ?? "").replace(/`([^`]+)`/g, (_, content) => {
    const key = `LOCALGPTINLINECODE${code.length}TOKEN`;
    code.push(`<code>${escapeHtml(content)}</code>`);
    return key;
  });
  source = source.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const key = `LOCALGPTLINK${links.length}TOKEN`;
    links.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`);
    return key;
  });
  const saveMath = (content) => {
    const key = `LOCALGPTINLINEMATH${math.length}TOKEN`;
    math.push(renderMath(content));
    return key;
  };
  source = source.replace(/\\\((.+?)\\\)/g, (_, content) => saveMath(content));
  let text = escapeHtml(source);
  text = text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/https?:\/\/[^\s<]+/g, (match) => {
      let url = match;
      let suffix = "";
      while (/[.,!?;:，。！？；：）】》]$/.test(url)) {
        suffix = url.slice(-1) + suffix;
        url = url.slice(0, -1);
      }
      while (url.endsWith(")") && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) {
        suffix = `)${suffix}`;
        url = url.slice(0, -1);
      }
      return `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>${suffix}`;
    });
  code.forEach((html, index) => { text = text.replace(`LOCALGPTINLINECODE${index}TOKEN`, html); });
  math.forEach((html, index) => { text = text.replace(`LOCALGPTINLINEMATH${index}TOKEN`, html); });
  links.forEach((html, index) => { text = text.replace(`LOCALGPTLINK${index}TOKEN`, html); });
  return text;
}

function splitTableRow(line) {
  let source = String(line).trim();
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|")) source = source.slice(0, -1);
  const cells = [];
  let current = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\" && source[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function tableAlignments(line) {
  if (!String(line).includes("|")) return null;
  const cells = splitTableRow(line);
  if (!cells.length || !cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")))) return null;
  return cells.map((cell) => {
    const marker = cell.replace(/\s+/g, "");
    if (marker.startsWith(":") && marker.endsWith(":")) return "center";
    if (marker.endsWith(":")) return "right";
    return "left";
  });
}

function renderTable(headers, alignments, rows) {
  const cell = (tag, value, index) => `<${tag} class="align-${alignments[index] || "left"}">${inlineMarkdown(value || "")}</${tag}>`;
  const head = headers.map((value, index) => cell("th", value, index)).join("");
  const body = rows.map((row) => `<tr>${alignments.map((_, index) => cell("td", row[index], index)).join("")}</tr>`).join("");
  return `<div class="table-scroll" role="region" tabindex="0"><table><thead><tr>${head}</tr></thead>${body ? `<tbody>${body}</tbody>` : ""}</table></div>`;
}

function legacyRenderMarkdown(value) {
  const lines = String(value ?? "").replace(/\r\n/g, "\n").split("\n");
  const output = [];
  let code = null;
  let language = "";
  let list = null;
  const closeList = () => {
    if (list) output.push(`</${list}>`);
    list = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^```\s*([\w.+-]*)\s*$/);
    if (fence) {
      if (code) {
        output.push(`<div class="code-block"><div class="code-header"><span>${escapeHtml(language || "code")}</span>${copyCodeButton()}</div><pre><code>${escapeHtml(code.join("\n"))}</code></pre></div>`);
        code = null;
        language = "";
      } else {
        closeList();
        code = [];
        language = fence[1];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    const trimmed = line.trim();
    const singleLineMath = trimmed.match(/^\\\[([\s\S]+)\\\]$/) || trimmed.match(/^\$\$([\s\S]+)\$\$$/);
    if (singleLineMath) {
      closeList();
      output.push(renderMath(singleLineMath[1], true));
      continue;
    }
    if (trimmed === "\\[" || trimmed === "$$") {
      closeList();
      const closing = trimmed === "\\[" ? "\\]" : "$$";
      const math = [];
      index += 1;
      while (index < lines.length && lines[index].trim() !== closing) {
        math.push(lines[index]);
        index += 1;
      }
      output.push(renderMath(math.join("\n"), true));
      continue;
    }
    const alignments = index + 1 < lines.length ? tableAlignments(lines[index + 1]) : null;
    if (alignments) {
      const headers = splitTableRow(line);
      if (headers.length === alignments.length) {
        closeList();
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
          rows.push(splitTableRow(lines[index]));
          index += 1;
        }
        index -= 1;
        output.push(renderTable(headers, alignments, rows));
        continue;
      }
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        list = kind;
        output.push(`<${kind}>`);
      }
      output.push(`<li>${inlineMarkdown((bullet || ordered)[1])}</li>`);
      continue;
    }
    closeList();
    if (/^>\s+/.test(line)) {
      output.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s+/, ""))}</blockquote>`);
    } else {
      output.push(`<p>${inlineMarkdown(line)}</p>`);
    }
  }
  if (code) {
    output.push(`<div class="code-block"><div class="code-header"><span>${escapeHtml(language || "code")}</span>${copyCodeButton()}</div><pre><code>${escapeHtml(code.join("\n"))}</code></pre></div>`);
  }
  closeList();
  return output.join("");
}

const markdownRenderer = typeof window.markdownit === "function"
  ? window.markdownit({ html: false, linkify: true, typographer: false, breaks: false })
  : null;

function renderMarkdownCodeBlock(tokens, index) {
  const token = tokens[index];
  const language = String(token.info || "").trim().split(/\s+/, 1)[0] || "code";
  const code = String(token.content || "").replace(/\n$/, "");
  return `<div class="code-block"><div class="code-header"><span>${escapeHtml(language)}</span>${copyCodeButton()}</div><pre><code>${escapeHtml(code)}</code></pre></div>`;
}

if (markdownRenderer) {
  markdownRenderer.renderer.rules.fence = renderMarkdownCodeBlock;
  markdownRenderer.renderer.rules.code_block = renderMarkdownCodeBlock;
  markdownRenderer.renderer.rules.table_open = () => '<div class="table-scroll" role="region" tabindex="0"><table>';
  markdownRenderer.renderer.rules.table_close = () => "</table></div>";
  markdownRenderer.renderer.rules.link_open = (tokens, index, options, env, self) => {
    tokens[index].attrSet("target", "_blank");
    tokens[index].attrSet("rel", "noreferrer noopener");
    return self.renderToken(tokens, index, options);
  };
  const defaultImageRule = markdownRenderer.renderer.rules.image;
  markdownRenderer.renderer.rules.image = (tokens, index, options, env, self) => {
    tokens[index].attrSet("loading", "lazy");
    tokens[index].attrSet("referrerpolicy", "no-referrer");
    return defaultImageRule(tokens, index, options, env, self);
  };
}

function extractMarkdownMath(value, includeDisplay) {
  let source = String(value ?? "");
  const protectedCode = [];
  source = source.replace(/(```|~~~)[\s\S]*?(?:\1|$)|`[^`\n]*`/g, (segment) => {
    const marker = `LOCALGPTCODE${protectedCode.length}PLACEHOLDER`;
    protectedCode.push(segment);
    return marker;
  });

  const math = [];
  const saveMath = (content, display) => {
    const marker = `LOCALGPTMATH${math.length}PLACEHOLDER`;
    math.push({ marker, content, display });
    return marker;
  };
  if (includeDisplay) {
    source = source.replace(/\\\[([\s\S]*?)\\\]/g, (_, content) => saveMath(content, true));
    source = source.replace(/\$\$([\s\S]*?)\$\$/g, (_, content) => saveMath(content, true));
  }
  source = source.replace(/\\\(([\s\S]*?)\\\)/g, (_, content) => saveMath(content, false));
  protectedCode.forEach((segment, index) => {
    source = source.split(`LOCALGPTCODE${index}PLACEHOLDER`).join(segment);
  });
  return { source, math };
}

function restoreMarkdownMath(html, math) {
  let output = html;
  math.forEach(({ marker, content, display }) => {
    const rendered = renderMath(content, display);
    if (display) output = output.split(`<p>${marker}</p>`).join(rendered);
    output = output.split(marker).join(rendered);
  });
  return output;
}

function inlineMarkdown(value) {
  if (!markdownRenderer) return legacyInlineMarkdown(value);
  const { source, math } = extractMarkdownMath(value, false);
  return restoreMarkdownMath(markdownRenderer.renderInline(source), math);
}

function renderMarkdown(value) {
  if (!markdownRenderer) return legacyRenderMarkdown(value);
  const { source, math } = extractMarkdownMath(value, true);
  return restoreMarkdownMath(markdownRenderer.render(source), math);
}

function icon(name) {
  const paths = {
    copy: '<path d="M9 9h10v10H9z"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    folder: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H10l2 2h5.5A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5v-11Z"/>',
  };
  return `<svg viewBox="0 0 24 24">${paths[name] || ""}</svg>`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatTime(value) {
  try {
    return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  } catch { return ""; }
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function messageDurationMs(messages, index) {
  const item = messages[index];
  if (!item || item.notice) return null;
  const stored = Number(item.durationMs);
  if (Number.isFinite(stored) && stored >= 0) return stored;
  const finishedAt = Date.parse(item.createdAt);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role !== "user") continue;
    const startedAt = Date.parse(messages[cursor].createdAt);
    return Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt
      ? finishedAt - startedAt
      : null;
  }
  return null;
}

function formatMessageDuration(milliseconds) {
  return `${Math.max(0, Math.round(milliseconds / 1000))} s`;
}

function beijingDateParts(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const year = get("year");
  const month = get("month")?.padStart(2, "0");
  const day = get("day")?.padStart(2, "0");
  return year && month && day ? { year, month, day } : null;
}

function formatBeijingDate(value) {
  const parts = beijingDateParts(value);
  return parts ? `${parts.year}年${parts.month}月${parts.day}日` : "";
}

function chatMonth(value) {
  const parts = beijingDateParts(value);
  return parts
    ? { key: `${parts.year}-${parts.month}`, label: `${parts.year}年${Number(parts.month)}月` }
    : { key: "unknown", label: "未知月份" };
}

function chatsByMonth(chats) {
  const groups = new Map();
  for (const chat of chats) {
    const month = chatMonth(chat.updatedAt || chat.createdAt);
    if (!groups.has(month.key)) groups.set(month.key, { ...month, chats: [] });
    groups.get(month.key).chats.push(chat);
  }
  return [...groups.values()];
}

function activityHint() {
  const quietFor = Date.now() - (state.lastActivityAt || Date.now());
  const connectionAlive = state.lastHeartbeatAt && Date.now() - state.lastHeartbeatAt < 25000;
  if (quietFor < 5000) return "刚刚收到新进展";
  if (quietFor < 15000) return `${Math.floor(quietFor / 1000)} 秒前收到进展`;
  if (connectionAlive) return `连接正常，Codex 已继续处理 ${Math.floor(quietFor / 1000)} 秒`;
  if (quietFor < 45000) return `Codex 仍在运行，${Math.floor(quietFor / 1000)} 秒没有新事件`;
  return `较长时间没有新事件，可继续等待或点击停止`;
}

function currentModel() {
  return state.config?.defaultModel || "gpt-5.6-sol";
}

function currentEffort() {
  return state.current?.reasoningEffort || state.draftEffort || "medium";
}

function currentSearchMode() {
  return state.current?.webSearchMode || state.draftSearchMode || "off";
}

function renderChats() {
  if (!state.chats.length) {
    elements.chatList.innerHTML = '<div class="empty-list" style="min-height:100px;font-size:12px">还没有对话</div>';
    return;
  }
  elements.chatList.innerHTML = chatsByMonth(state.chats).map((group, index) => {
    const latest = index === 0;
    const collapsed = !latest && state.collapsedChatMonths.has(group.key);
    const heading = latest
      ? `<div class="chat-month-heading latest"><span class="chat-month-line"></span><span class="chat-month-label">${escapeHtml(group.label)}</span><span class="chat-month-line"></span></div>`
      : `<button class="chat-month-heading" type="button" data-chat-month="${escapeHtml(group.key)}" aria-expanded="${String(!collapsed)}"><span class="chat-month-line"></span><span class="chat-month-label">${escapeHtml(group.label)}</span>${icon("chevron")}<span class="chat-month-line"></span></button>`;
    const chats = collapsed ? "" : group.chats.map((chat) => `
      <div class="chat-item ${state.current?.id === chat.id ? "active" : ""}" data-chat-id="${escapeHtml(chat.id)}" role="button" tabindex="0">
        <span class="chat-item-title">${escapeHtml(chat.title)}</span>
        ${chat.running ? '<span class="chat-item-running"></span>' : ""}
        <button class="chat-item-menu" type="button" data-delete-chat="${escapeHtml(chat.id)}" title="删除对话" aria-label="删除对话">${icon("trash")}</button>
      </div>
    `).join("");
    return heading + chats;
  }).join("");
}

const BOTTOM_THRESHOLD = 72;

function isConversationAtBottom() {
  const { scrollHeight, scrollTop, clientHeight } = elements.conversation;
  return scrollHeight - scrollTop - clientHeight <= BOTTOM_THRESHOLD;
}

function updateScrollToBottomButton() {
  const hasContent = Boolean((state.current?.messages || []).length || state.streamingText || state.running);
  elements.scrollToBottom.hidden = !hasContent || isConversationAtBottom();
}

function scrollConversationToBottom({ smooth = false } = {}) {
  state.followOutput = true;
  elements.conversation.scrollTo({
    top: elements.conversation.scrollHeight,
    behavior: smooth ? "smooth" : "auto",
  });
  elements.scrollToBottom.hidden = true;
}

function renderMessages(scroll = false) {
  const shouldFollow = scroll || state.followOutput || isConversationAtBottom();
  if (scroll) state.followOutput = true;
  const messages = state.current?.messages || [];
  elements.empty.hidden = messages.length > 0 || state.running || Boolean(state.streamingText) || Boolean(state.streamError);
  const html = messages.map((item, index) => {
    if (item.role === "user") {
      return `<article class="message-row user" data-message-id="${escapeHtml(item.id)}"><div class="message-inner"><div class="message-body"><div class="message-content">${inlineMarkdown(item.content).replace(/\n/g, "<br>")}</div></div></div></article>`;
    }
    const durationMs = messageDurationMs(messages, index);
    const beijingDate = formatBeijingDate(item.createdAt);
    const meta = item.notice ? "" : `<div class="message-meta"><button class="message-action copy-message" type="button" title="复制回答">${icon("copy")}</button>${item.model ? `<span>${escapeHtml(item.model)}</span>` : ""}${durationMs !== null ? `<span class="message-duration">总计耗时：${formatMessageDuration(durationMs)}</span>` : ""}${beijingDate ? `<span class="message-date">日期:${escapeHtml(beijingDate)}</span>` : ""}</div>`;
    return `<article class="message-row assistant" data-message-id="${escapeHtml(item.id)}"><div class="message-inner"><img class="message-avatar logo-avatar" src="/GPT%20logo.png" alt="MyGPT" /><div class="message-body"><div class="message-content">${renderMarkdown(item.content)}</div>${meta}</div></div></article>`;
  }).join("");
  const streaming = state.streamingText ? `<article class="message-row assistant streaming-message"><div class="message-inner"><img class="message-avatar logo-avatar" src="/GPT%20logo.png" alt="MyGPT" /><div class="message-body"><div class="message-content">${renderMarkdown(state.streamingText)}<span class="stream-cursor" aria-hidden="true"></span></div></div></div></article>` : "";
  const progressRows = state.progress.slice(-4).map((item) => `<div class="progress-row ${escapeHtml(item.status || "running")}"><span class="progress-mark"></span><div><strong>${escapeHtml(item.label)}</strong>${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ""}</div></div>`).join("");
  const activity = state.running ? `<article class="message-row assistant run-row"><div class="message-inner"><div class="message-avatar run-avatar"><span class="thinking-dot"></span></div><div class="message-body run-status"><div class="run-status-head"><strong>${escapeHtml(state.activity || "Codex 正在处理")}</strong><span class="run-elapsed">${formatElapsed(Date.now() - (state.runStartedAt || Date.now()))}</span></div><div class="run-status-hint">${escapeHtml(activityHint())}</div>${progressRows ? `<div class="progress-timeline">${progressRows}</div>` : ""}</div></div></article>` : "";
  const error = state.streamError ? `<article class="message-row assistant"><div class="message-inner"><div class="message-avatar">!</div><div class="message-body error-message">${escapeHtml(state.streamError)}</div></div></article>` : "";
  elements.messages.innerHTML = html + streaming + activity + error;
  requestAnimationFrame(() => {
    if (shouldFollow) scrollConversationToBottom();
    else updateScrollToBottomButton();
  });
}

function renderHeader() {
  const searchEnabled = currentSearchMode() === "on";
  elements.modelName.textContent = currentModel();
  elements.effortLabel.textContent = effortNames[currentEffort()] || currentEffort();
  elements.searchLabel.textContent = `联网搜索：${searchModeNames[currentSearchMode()] || "关"}`;
  elements.searchButton.classList.toggle("active", searchEnabled);
  elements.searchButton.setAttribute("aria-pressed", String(searchEnabled));
  elements.fileCount.textContent = String(state.files.length);
  elements.filesButton.disabled = !state.current;
  elements.rename.disabled = !state.current;
  elements.send.classList.toggle("running", state.running);
  updateSendButton();
}

function renderModelMenu() {
  const models = state.config?.suggestedModels || [];
  elements.modelOptions.innerHTML = models.map((model) => `
    <button class="model-option ${currentModel() === model ? "active" : ""}" type="button" data-model="${escapeHtml(model)}">${escapeHtml(model)}</button>
  `).join("");
}

function renderEffortMenu() {
  $$("#effortMenu [data-effort]").forEach((button) => button.classList.toggle("active", button.dataset.effort === currentEffort()));
  elements.effortButton.setAttribute("aria-expanded", String(!elements.effortMenu.hidden));
}

function renderFiles() {
  elements.fileCount.textContent = String(state.files.length);
  if (!state.files.length) {
    elements.fileList.innerHTML = `<div class="empty-list">${icon("folder")}<span>这个会话还没有文件</span></div>`;
    return;
  }
  elements.fileList.innerHTML = state.files.map((file) => `
    <div class="file-row">
      <div class="file-icon">${icon("file")}</div>
      <div class="file-info"><strong title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</strong><small>${formatBytes(file.size)} · ${formatTime(file.updatedAt)}</small></div>
      <div class="file-actions">
        <a class="icon-button" href="/api/chats/${encodeURIComponent(state.current.id)}/file?path=${encodeURIComponent(file.path)}" title="下载">${icon("download")}</a>
        <button class="icon-button" type="button" data-delete-file="${escapeHtml(file.path)}" title="删除">${icon("trash")}</button>
      </div>
    </div>
  `).join("");
}

function renderSettings() {
  if (!state.config) return;
  const address = location.origin;
  elements.settingsContent.innerHTML = `
    <div class="setting-row"><label>当前地址</label><div class="setting-value"><code>${escapeHtml(address)}</code></div></div>
    <div class="setting-row"><label>当前用户名</label><div class="setting-value"><code>${escapeHtml(state.config.userRole || "")}</code></div></div>
    <div class="setting-row"><label>访问模式</label><div class="setting-value">${state.config.lanMode ? "局域网（密码保护）" : "仅限本机"}</div></div>
    <div class="setting-row"><label>会话目录</label><div class="setting-value"><code>${escapeHtml(state.config.dataRoot)}</code></div></div>
    <div class="setting-row"><label>默认模型</label><div class="setting-value">${escapeHtml(state.config.defaultModel || "由 Codex 自动选择")}</div></div>
    <div class="setting-row"><label>单文件上限</label><div class="setting-value">${state.config.maxUploadMb} MB</div></div>
    <div class="settings-help">手机访问时，请确保手机和电脑连接同一 Wi‑Fi，并使用服务器启动后终端显示的局域网地址。如果无法打开，请在 Windows 防火墙中允许 Node.js 访问“专用网络”。</div>
    <button id="switchRoleButton" class="secondary-button" type="button">切换登录用户名</button>
  `;
}

function renderAll(scroll = false) {
  renderChats();
  renderMessages(scroll);
  renderHeader();
  renderModelMenu();
  renderEffortMenu();
  renderFiles();
  renderSettings();
}

function updateSendButton() {
  elements.send.disabled = !state.running && !elements.input.value.trim();
  elements.send.title = state.running ? "停止生成" : "发送";
}

function resizeInput() {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 190)}px`;
  updateSendButton();
}

let streamRenderTimer = null;
function scheduleMessageRender() {
  if (streamRenderTimer) return;
  streamRenderTimer = setTimeout(() => {
    streamRenderTimer = null;
    renderMessages();
  }, 45);
}

function addProgress(event) {
  state.activity = event.label || "Codex 正在处理";
  state.lastActivityAt = Date.now();
  const previous = state.progress.at(-1);
  if (previous && previous.stage === event.stage && previous.label === event.label) {
    Object.assign(previous, event);
  } else {
    state.progress.push(event);
    if (state.progress.length > 20) state.progress.shift();
  }
}

setInterval(() => {
  if (!state.running) return;
  const elapsed = document.querySelector(".run-elapsed");
  const hint = document.querySelector(".run-status-hint");
  if (elapsed) elapsed.textContent = formatElapsed(Date.now() - (state.runStartedAt || Date.now()));
  if (hint) hint.textContent = activityHint();
}, 1000);

function openSidebar() { document.body.classList.add("sidebar-open"); }
function closeSidebar() { document.body.classList.remove("sidebar-open"); }

function closePopovers(except = null) {
  [elements.modelMenu, elements.effortMenu].forEach((menu) => {
    if (menu !== except) menu.hidden = true;
  });
  elements.effortButton.setAttribute("aria-expanded", String(!elements.effortMenu.hidden));
}

function showLogin() {
  if (!elements.loginDialog.open) elements.loginDialog.showModal();
  setTimeout(() => elements.role.focus(), 20);
}

async function loadChats() {
  state.chats = await api("/api/chats");
}

let backgroundPoll = null;
function stopBackgroundPoll() {
  if (backgroundPoll) clearInterval(backgroundPoll);
  backgroundPoll = null;
}

function startBackgroundPoll(chatId) {
  stopBackgroundPoll();
  backgroundPoll = setInterval(async () => {
    if (!state.current || state.current.id !== chatId || !state.running) return stopBackgroundPoll();
    try {
      const latest = await api(`/api/chats/${encodeURIComponent(chatId)}`);
      if (!latest.running) {
        state.current = latest;
        state.running = false;
        state.activity = "";
        state.runStartedAt = null;
        state.lastActivityAt = null;
        state.progress = [];
        state.streamingText = "";
        stopBackgroundPoll();
        await loadChats();
        await refreshFiles();
        renderAll();
      }
    } catch {}
  }, 2500);
}

async function refreshFiles() {
  if (!state.current) {
    state.files = [];
  } else {
    state.files = await api(`/api/chats/${encodeURIComponent(state.current.id)}/files`);
  }
  renderFiles();
  renderHeader();
}

async function selectChat(id, { closeMobile = true } = {}) {
  state.current = await api(`/api/chats/${encodeURIComponent(id)}`);
  state.running = Boolean(state.current.running);
  state.activity = state.running ? "任务正在后台运行…" : "";
  state.streamingText = "";
  state.progress = state.running ? [{ stage: "reconnect", label: "正在等待后台任务完成", detail: "页面会自动同步最终回答", status: "running" }] : [];
  state.runStartedAt = state.running ? Date.now() : null;
  state.lastActivityAt = state.running ? Date.now() : null;
  state.lastHeartbeatAt = state.running ? Date.now() : null;
  state.streamError = "";
  await refreshFiles();
  renderAll(true);
  if (state.running) startBackgroundPoll(state.current.id);
  else stopBackgroundPoll();
  if (closeMobile) closeSidebar();
}

let createChatPromise = null;
async function createChat() {
  if (state.running) throw new Error("请先停止当前回答，再新建对话");
  if (createChatPromise) return createChatPromise;

  createChatPromise = (async () => {
    elements.newChat.disabled = true;
    elements.newChat.setAttribute("aria-busy", "true");
    const latest = state.chats[0];
    if (latest && latest.messageCount === 0 && !latest.running) {
      if (state.current?.id !== latest.id) await selectChat(latest.id);
      else closeSidebar();
      return state.current;
    }

    const chat = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({ model: currentModel(), reasoningEffort: currentEffort(), webSearchMode: currentSearchMode() }),
    });
    await loadChats();
    await selectChat(chat.id);
    return state.current;
  })();

  try {
    return await createChatPromise;
  } finally {
    createChatPromise = null;
    elements.newChat.disabled = false;
    elements.newChat.removeAttribute("aria-busy");
  }
}

async function ensureChat() {
  return state.current || createChat();
}

async function updateChat(values) {
  if (!state.current) return;
  state.current = await api(`/api/chats/${encodeURIComponent(state.current.id)}`, { method: "PATCH", body: JSON.stringify(values) });
  await loadChats();
  renderAll();
}

async function chooseModel(model) {
  if (state.running) throw new Error("请等待当前回答结束后再切换模型");
  if (String(model || "").trim() !== currentModel()) return;
  elements.modelMenu.hidden = true;
  renderAll();
}

async function chooseEffort(effort) {
  if (state.running) throw new Error("请等待当前回答结束后再调整推理强度");
  if (!effortNames[effort]) return;
  if (state.current) await updateChat({ reasoningEffort: effort });
  else state.draftEffort = effort;
  elements.effortMenu.hidden = true;
  renderAll();
}

async function chooseSearchMode(mode) {
  if (state.running) throw new Error("请等待当前回答结束后再调整联网搜索");
  if (!searchModeNames[mode]) return;
  if (state.current) await updateChat({ webSearchMode: mode });
  else state.draftSearchMode = mode;
  renderAll();
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  elements.pendingFiles.innerHTML = files.map((file) => `<div class="pending-file">${icon("file")}<span>${escapeHtml(file.name)}</span></div>`).join("");
  try {
    const chat = await ensureChat();
    const form = new FormData();
    files.forEach((file) => form.append("files", file));
    const response = await fetch(`/api/chats/${encodeURIComponent(chat.id)}/files`, { method: "POST", body: form });
    if (response.status === 401) { showLogin(); throw new Error("需要访问密码"); }
    if (!response.ok) {
      let error = `上传失败（${response.status}）`;
      try { error = (await response.json()).error || error; } catch {}
      throw new Error(error);
    }
    await refreshFiles();
    toast(`已上传 ${files.length} 个文件（${formatBytes(total)}）`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    elements.pendingFiles.innerHTML = "";
    elements.fileInput.value = "";
  }
}

async function stopGeneration() {
  if (!state.current || !state.running) return;
  state.activity = "正在停止…";
  state.lastActivityAt = Date.now();
  state.lastHeartbeatAt = Date.now();
  renderMessages();
  try {
    await api(`/api/chats/${encodeURIComponent(state.current.id)}/stop`, { method: "POST" });
  } catch (error) {
    toast(error.message, "error");
  }
}

async function sendMessage() {
  const content = elements.input.value.trim();
  if (!content || state.running) return;
  const chat = await ensureChat();
  state.running = true;
  state.streamError = "";
  state.activity = "正在连接 Codex…";
  state.streamingText = "";
  state.progress = [];
  state.runStartedAt = Date.now();
  state.lastActivityAt = Date.now();
  state.runStatus = "running";
  state.usage = null;
  stopBackgroundPoll();
  const optimistic = { id: `temp-${Date.now()}`, role: "user", content, createdAt: new Date().toISOString() };
  state.current.messages.push(optimistic);
  elements.input.value = "";
  resizeInput();
  renderAll(true);

  try {
    const response = await fetch(`/api/chats/${encodeURIComponent(chat.id)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, model: currentModel(), reasoningEffort: currentEffort(), webSearchMode: currentSearchMode() }),
    });
    if (response.status === 401) { showLogin(); throw new Error("需要访问密码"); }
    if (!response.ok || !response.body) {
      let error = `发送失败（${response.status}）`;
      try { error = (await response.json()).error || error; } catch {}
      throw new Error(error);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let persistedUser = false;
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "user.saved") {
          const index = state.current.messages.findIndex((item) => item.id === optimistic.id);
          if (index >= 0) state.current.messages[index] = event.message;
          persistedUser = true;
          if (event.chat?.title) state.current.title = event.chat.title;
        } else if (event.type === "progress") {
          addProgress(event);
        } else if (event.type === "activity") {
          state.activity = event.text;
          state.lastActivityAt = Date.now();
        } else if (event.type === "assistant.delta") {
          state.streamingText += event.delta || "";
          state.activity = "正在生成回答";
          state.lastActivityAt = Date.now();
        } else if (event.type === "assistant.replace") {
          state.streamingText = event.text || "";
          state.activity = "正在生成回答";
          state.lastActivityAt = Date.now();
        } else if (event.type === "assistant.message") {
          if (!state.current.messages.some((item) => item.id === event.message.id)) state.current.messages.push(event.message);
          state.streamingText = "";
          state.lastActivityAt = Date.now();
        } else if (event.type === "usage") {
          state.usage = event.usage;
        } else if (event.type === "heartbeat") {
          state.lastHeartbeatAt = Date.now();
          state.activity = event.text || "连接正常，Codex 仍在处理";
        } else if (event.type === "error") {
          state.streamError = event.error;
        } else if (event.type === "stopped") {
          state.activity = event.partial ? "已停止，已保留生成内容" : "已停止";
          state.runStatus = "interrupted";
        } else if (event.type === "done") {
          state.runStatus = event.status || "completed";
        }
        scheduleMessageRender();
      }
      if (done) break;
    }
    if (!persistedUser) {
      const latest = await api(`/api/chats/${encodeURIComponent(chat.id)}`);
      state.current = latest;
    }
  } catch (error) {
    state.streamError = error.message;
    const latest = await api(`/api/chats/${encodeURIComponent(chat.id)}`).catch(() => null);
    if (latest) state.current = latest;
  } finally {
    state.running = false;
    state.progress = [];
    state.streamingText = "";
    await loadChats().catch(() => {});
    const latest = state.current ? await api(`/api/chats/${encodeURIComponent(state.current.id)}`).catch(() => null) : null;
    if (latest) {
      state.current = latest;
      state.running = Boolean(latest.running);
    }
    if (state.running) {
      state.streamError = "";
      state.activity = "实时连接已断开，后台任务仍在运行";
      state.progress = [{ stage: "reconnect", label: "正在后台同步", detail: "完成后会自动显示最终回答", status: "warning" }];
      state.runStartedAt = Date.now();
      state.lastActivityAt = Date.now();
      state.lastHeartbeatAt = Date.now();
      startBackgroundPoll(state.current.id);
    } else {
      state.activity = "";
      state.runStartedAt = null;
      state.lastActivityAt = null;
      state.lastHeartbeatAt = null;
      stopBackgroundPoll();
    }
    await refreshFiles().catch(() => {});
    renderAll();
  }
}

async function deleteFile(relative) {
  if (!state.current || !confirm(`删除文件“${relative}”？`)) return;
  try {
    await api(`/api/chats/${encodeURIComponent(state.current.id)}/file?path=${encodeURIComponent(relative)}`, { method: "DELETE" });
    await refreshFiles();
  } catch (error) { toast(error.message, "error"); }
}

async function deleteChat(id) {
  const chat = state.chats.find((item) => item.id === id);
  if (!chat || !confirm(`删除对话“${chat.title}”及其中的全部文件？此操作无法撤销。`)) return;
  try {
    await api(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (state.current?.id === id) {
      state.current = null;
      state.files = [];
      state.running = false;
    }
    await loadChats();
    if (!state.current && state.chats.length) await selectChat(state.chats[0].id, { closeMobile: false });
    else renderAll();
  } catch (error) { toast(error.message, "error"); }
}

async function bootstrap() {
  const status = await fetch("/api/auth/status").then((response) => response.json());
  if (status.required && !status.authenticated) {
    elements.passwordField.hidden = false;
    elements.passwordField.querySelector("span").textContent = status.passwordRequired ? "访问密码" : "访问密码（本机模式可留空）";
    elements.password.required = Boolean(status.passwordRequired);
    showLogin();
    return;
  }
  state.config = await api("/api/config");
  state.draftModel = state.config.defaultModel || state.config.suggestedModels[0] || "";
  state.draftEffort = state.config.defaultReasoningEffort || "medium";
  state.draftSearchMode = state.config.defaultWebSearchMode || "off";
  elements.connectionText.textContent = `${state.config.userRole} · ${state.config.lanMode ? "局域网安全连接" : `127.0.0.1:${state.config.port}`}`;
  await loadChats();
  if (state.chats.length) await selectChat(state.chats[0].id, { closeMobile: false });
  else renderAll();
  state.booted = true;
}

elements.input.addEventListener("input", resizeInput);
elements.conversation.addEventListener("scroll", () => {
  state.followOutput = isConversationAtBottom();
  updateScrollToBottomButton();
}, { passive: true });
elements.scrollToBottom.addEventListener("click", () => scrollConversationToBottom({ smooth: true }));
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!elements.send.disabled) state.running ? stopGeneration() : sendMessage();
  }
});
elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  state.running ? stopGeneration() : sendMessage();
});
function focusComposerOnDesktop() {
  if (!window.matchMedia("(max-width: 760px)").matches) elements.input.focus();
}

elements.newChat.addEventListener("click", async () => {
  try { await createChat(); focusComposerOnDesktop(); } catch (error) { toast(error.message, "error"); }
});
elements.brand.addEventListener("click", () => {
  if (state.running) { toast("请先停止当前回答，再离开当前对话", "error"); return; }
  state.current = null; state.files = []; state.running = false; renderAll(); closeSidebar();
});
elements.menu.addEventListener("click", openSidebar);
elements.closeSidebar.addEventListener("click", closeSidebar);
elements.backdrop.addEventListener("click", closeSidebar);
elements.attach.addEventListener("click", () => elements.fileInput.click());
elements.dialogUpload.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => uploadFiles(elements.fileInput.files));
elements.refreshFiles.addEventListener("click", () => refreshFiles().catch((error) => toast(error.message, "error")));
elements.filesButton.addEventListener("click", async () => { await refreshFiles(); elements.filesDialog.showModal(); });
elements.settingsButton.addEventListener("click", () => { renderSettings(); elements.settingsDialog.showModal(); closeSidebar(); });
document.addEventListener("click", async (event) => {
  if (!event.target.closest("#switchRoleButton")) return;
  if (state.running) { toast("请先停止当前回答，再切换登录用户名", "error"); return; }
  try {
    await fetch("/api/auth/logout", { method: "POST" });
    elements.settingsDialog.close();
    state.current = null;
    state.chats = [];
    state.files = [];
    renderAll();
    await bootstrap();
  } catch (error) { toast(error.message, "error"); }
});
elements.rename.addEventListener("click", async () => {
  if (!state.current) return;
  const title = prompt("对话名称", state.current.title);
  if (title?.trim()) await updateChat({ title: title.trim() });
});
elements.modelButton.addEventListener("click", (event) => {
  event.stopPropagation();
  renderModelMenu();
  elements.modelMenu.hidden = !elements.modelMenu.hidden;
  closePopovers(elements.modelMenu.hidden ? null : elements.modelMenu);
});
elements.effortButton.addEventListener("click", (event) => {
  event.stopPropagation();
  renderEffortMenu();
  const rect = elements.effortButton.getBoundingClientRect();
  elements.effortMenu.style.left = `${Math.max(10, rect.left)}px`;
  elements.effortMenu.hidden = !elements.effortMenu.hidden;
  elements.effortButton.setAttribute("aria-expanded", String(!elements.effortMenu.hidden));
  closePopovers(elements.effortMenu.hidden ? null : elements.effortMenu);
});
elements.searchButton.addEventListener("click", () => {
  const nextMode = currentSearchMode() === "on" ? "off" : "on";
  chooseSearchMode(nextMode).catch((error) => toast(error.message, "error"));
});
elements.modelOptions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-model]");
  if (button) chooseModel(button.dataset.model).catch((error) => toast(error.message, "error"));
});
elements.effortMenu.addEventListener("click", (event) => {
  const button = event.target.closest("[data-effort]");
  if (button) chooseEffort(button.dataset.effort).catch((error) => toast(error.message, "error"));
});
elements.chatList.addEventListener("click", (event) => {
  const monthButton = event.target.closest("[data-chat-month]");
  if (monthButton) {
    const key = monthButton.dataset.chatMonth;
    if (state.collapsedChatMonths.has(key)) state.collapsedChatMonths.delete(key);
    else state.collapsedChatMonths.add(key);
    renderChats();
    return;
  }
  const deleteButton = event.target.closest("[data-delete-chat]");
  if (deleteButton) { event.stopPropagation(); deleteChat(deleteButton.dataset.deleteChat); return; }
  const item = event.target.closest("[data-chat-id]");
  if (item) {
    if (state.running && state.current?.id !== item.dataset.chatId) {
      toast("请先停止当前回答，再切换对话", "error");
      return;
    }
    selectChat(item.dataset.chatId).catch((error) => toast(error.message, "error"));
  }
});
elements.fileList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-file]");
  if (button) deleteFile(button.dataset.deleteFile);
});
elements.messages.addEventListener("click", async (event) => {
  const codeButton = event.target.closest(".copy-code");
  if (codeButton) {
    const code = codeButton.closest(".code-block")?.querySelector("code")?.textContent || "";
    try {
      await copyText(code);
      codeButton.innerHTML = `${icon("check")}<span>已复制</span>`;
      codeButton.setAttribute("aria-label", "代码已复制");
      setTimeout(() => {
        if (!codeButton.isConnected) return;
        codeButton.innerHTML = `${icon("copy")}<span>复制</span>`;
        codeButton.setAttribute("aria-label", "复制代码");
      }, 1400);
    } catch {
      toast("复制失败，请长按选择代码", "error");
    }
    return;
  }
  const messageButton = event.target.closest(".copy-message");
  if (messageButton) {
    const id = messageButton.closest("[data-message-id]")?.dataset.messageId;
    const item = state.current?.messages.find((message) => message.id === id);
    if (item) {
      try {
        await copyText(item.content);
        toast("回答已复制");
      } catch {
        toast("复制失败，请长按选择内容", "error");
      }
    }
  }
});
elements.form.addEventListener("dragover", (event) => { event.preventDefault(); elements.form.classList.add("drag-over"); });
elements.form.addEventListener("dragleave", () => elements.form.classList.remove("drag-over"));
elements.form.addEventListener("drop", (event) => { event.preventDefault(); elements.form.classList.remove("drag-over"); uploadFiles(event.dataTransfer.files); });
elements.input.addEventListener("paste", (event) => { if (event.clipboardData?.files?.length) uploadFiles(event.clipboardData.files); });
$$('.close-dialog').forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
document.addEventListener("click", (event) => {
  if (!event.target.closest(".popover") && !event.target.closest("#modelButton") && !event.target.closest("#effortButton")) closePopovers();
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    createChat().then(focusComposerOnDesktop).catch((error) => toast(error.message, "error"));
  }
});

function syncVisualViewport() {
  const viewport = window.visualViewport;
  const layoutHeight = document.documentElement.clientHeight;
  const keyboardOffset = viewport ? Math.max(0, layoutHeight - viewport.height - viewport.offsetTop) : 0;
  document.documentElement.style.setProperty("--keyboard-offset", `${Math.round(keyboardOffset)}px`);
}

window.visualViewport?.addEventListener("resize", syncVisualViewport);
window.visualViewport?.addEventListener("scroll", syncVisualViewport);
window.addEventListener("orientationchange", syncVisualViewport);
document.addEventListener("gesturestart", (event) => event.preventDefault(), { passive: false });
document.addEventListener("touchmove", (event) => {
  if (event.touches.length > 1) event.preventDefault();
}, { passive: false });
elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.loginError.textContent = "";
  try {
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: elements.role.value, password: elements.password.value }) });
    if (!response.ok) throw new Error((await response.json()).error || "连接失败");
    elements.loginDialog.close();
    elements.password.value = "";
    elements.role.value = "";
    await bootstrap();
  } catch (error) { elements.loginError.textContent = error.message; }
});

resizeInput();
syncVisualViewport();
bootstrap().catch((error) => {
  console.error(error);
  toast(error.message, "error");
});
