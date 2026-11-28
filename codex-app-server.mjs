import fs from "node:fs";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";

export class CodexAppServerClient {
  constructor({
    node,
    cli,
    workspace,
    threadFile,
    effort = "high",
    baseInstructions = "",
    onFinal,
    onProgress,
    onError,
  }) {
    this.node = node;
    this.cli = cli;
    this.workspace = workspace;
    this.threadFile = threadFile;
    this.effort = effort;
    this.baseInstructions = baseInstructions;
    this.onFinal = onFinal;
    this.onProgress = onProgress;
    this.onError = onError;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.threadId = "";
    this.activeTurnId = "";
    this.pendingInputs = [];
    this.ready = false;
    this.stopping = false;
  }

  async start() {
    this.child = spawn(
      this.node,
      this.cli
        ? [this.cli, "app-server", "--stdio", "-c", "notify=[]"]
        : ["app-server", "--stdio", "-c", "notify=[]"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32" && !this.cli,
      },
    );
    dispatchLines(this.child.stdout, (message) => this.handleMessage(message));
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.onError?.(text.slice(0, 1000));
    });
    this.child.on("exit", (code) => {
      this.ready = false;
      if (!this.stopping) {
        this.onError?.(`app-server exited code=${code}`);
      }
    });

    await this.request("initialize", {
      clientInfo: { name: "weixin-codex", version: "0.3.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");

    const savedThreadId = this.loadThreadId();
    if (savedThreadId) {
      try {
        const resumed = await this.request("thread/resume", {
          threadId: savedThreadId,
        });
        this.threadId = resumed.thread?.id || savedThreadId;
      } catch (err) {
        this.onError?.(`thread resume failed: ${String(err)}`);
      }
    }
    if (!this.threadId) {
      const thread = await this.request("thread/start", {
        cwd: this.workspace,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        baseInstructions: this.baseInstructions || null,
      });
      this.threadId = thread.thread?.id || "";
      if (!this.threadId) throw new Error("app-server did not return a thread id");
      this.saveThreadId(this.threadId);
    }
    this.ready = true;
    return { threadId: this.threadId };
  }

  async sendInput(input) {
    if (!this.ready) throw new Error("app-server is not ready");
    if (this.activeTurnId) {
      try {
        await this.request("turn/steer", {
          threadId: this.threadId,
          expectedTurnId: this.activeTurnId,
          input,
          clientUserMessageId: crypto.randomUUID(),
        });
        return { mode: "steered", turnId: this.activeTurnId };
      } catch (err) {
        this.pendingInputs.push(input);
        setTimeout(() => {
          if (!this.activeTurnId) this.startPendingInputs();
        }, 250).unref?.();
        return { mode: "queued", error: String(err) };
      }
    }
    return this.startTurn(input);
  }

  async startTurn(input) {
    const result = await this.request("turn/start", {
      threadId: this.threadId,
      input,
      clientUserMessageId: crypto.randomUUID(),
      effort: this.effort,
    });
    this.activeTurnId = result.turn?.id || this.activeTurnId;
    return { mode: "started", turnId: this.activeTurnId };
  }

  handleMessage(message) {
    if (message.id != null && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === "turn/started") {
      this.activeTurnId = message.params?.turn?.id || this.activeTurnId;
      return;
    }
    if (message.method === "item/completed") {
      const item = message.params?.item;
      if (item?.type === "agentMessage" && item.phase === "commentary" && item.text?.trim()) {
        void this.onProgress?.(item.text.trim(), message.params);
      }
      return;
    }
    if (message.method === "turn/completed") {
      this.activeTurnId = "";
      const turn = message.params?.turn;
      const messages = (turn?.items || [])
        .filter((item) => item?.type === "agentMessage" && item.text?.trim())
        .filter((item) => !item.phase || item.phase === "final_answer");
      const text = messages.map((item) => item.text.trim()).join("\n\n").trim();
      void Promise.resolve(
        this.onFinal?.({
          text,
          status: turn?.status || "unknown",
          error: turn?.error || null,
          threadId: this.threadId,
          turnId: turn?.id || "",
        }),
      ).finally(() => this.startPendingInputs());
    }
  }

  startPendingInputs() {
    if (this.activeTurnId || !this.pendingInputs.length || !this.ready) return;
    const inputs = this.pendingInputs.splice(0);
    const combined = inputs.flat();
    void this.startTurn(combined).catch((err) => {
      this.onError?.(`queued turn failed: ${String(err)}`);
    });
  }

  request(method, params) {
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    this.child.stdin.write(`${line}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  loadThreadId() {
    try {
      return JSON.parse(fs.readFileSync(this.threadFile, "utf-8")).threadId || "";
    } catch {
      return "";
    }
  }

  saveThreadId(threadId) {
    fs.writeFileSync(this.threadFile, JSON.stringify({ threadId }));
  }

  stop() {
    this.stopping = true;
    try {
      this.child?.kill();
    } catch {}
  }
}

function dispatchLines(stream, onMessage) {
  const lines = readline.createInterface({ input: stream });
  lines.on("line", (line) => {
    try {
      onMessage(JSON.parse(line));
    } catch {}
  });
}
