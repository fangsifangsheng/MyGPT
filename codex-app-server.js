import { EventEmitter } from "node:events";
import readline from "node:readline";
import { spawn } from "node:child_process";

export class CodexAppServer extends EventEmitter {
  constructor({ command, prefixArgs = [], cwd, env = process.env }) {
    super();
    this.command = command;
    this.prefixArgs = prefixArgs;
    this.cwd = cwd;
    this.env = env;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.startPromise = null;
    this.stderr = "";
  }

  async start() {
    if (this.child && !this.child.killed) return;
    if (!this.startPromise) this.startPromise = this.#launch();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #launch() {
    const child = spawn(this.command, [...this.prefixArgs, "app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
    });
    this.child = child;
    this.stderr = "";

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-12000);
    });
    child.on("error", (error) => this.#handleExit(error));
    child.on("close", (code) => this.#handleExit(new Error(
      this.stderr.trim() || `Codex app-server exited with code ${code}`,
    )));

    await this.#sendRequest("initialize", {
      clientInfo: { name: "mygpt", title: "MyGPT", version: "0.2.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [
          "command/exec/outputDelta",
          "item/commandExecution/outputDelta",
          "item/fileChange/outputDelta",
          "item/reasoning/textDelta",
        ],
      },
    }, 30000);
    this.notify("initialized");
  }

  #handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "Codex request failed"));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      this.#write({
        id: message.id,
        error: { code: -32601, message: `MyGPT does not support server request: ${message.method}` },
      });
      return;
    }

    if (message.method) this.emit("notification", message);
  }

  #handleExit(error) {
    if (!this.child) return;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("exit", error);
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #sendRequest(method, params, timeoutMs = 30000) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.#write({ id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async request(method, params, timeoutMs = 30000) {
    await this.start();
    return this.#sendRequest(method, params, timeoutMs);
  }

  notify(method, params) {
    this.#write(params === undefined ? { method } : { method, params });
  }

  async close() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
}
