import { createInterface } from "readline";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type Handler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

export class McpStdio {
  private handlers = new Map<string, Handler>();
  private useNdjson = false;
  private serverName: string;
  private serverVersion: string;
  private debugLogPath?: string;

  constructor(serverName: string, serverVersion = "1.0.0") {
    this.serverName = serverName;
    this.serverVersion = serverVersion;
  }

  onRequest(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  private debugLog(message: string): void {
    if (!this.debugLogPath) return;
    try {
      const fs = require("fs");
      const path = require("path");
      const dir = path.dirname(this.debugLogPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.debugLogPath, message + "\n", "utf-8");
    } catch {}
  }

  private sendResponse(response: JsonRpcResponse): void {
    const payload = JSON.stringify(response);
    this.debugLog(`SEND ${payload}`);
    if (this.useNdjson) {
      process.stdout.write(payload + "\n");
    } else {
      const header = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n`;
      process.stdout.write(header + payload);
    }
  }

  private sendResult(id: string | number | undefined, result: unknown): void {
    this.sendResponse({ jsonrpc: "2.0", id, result });
  }

  private sendError(id: string | number | undefined, code: number, message: string, data?: unknown): void {
    this.sendResponse({ jsonrpc: "2.0", id, error: { code, message, data } });
  }

  async run(): Promise<void> {
    // Read from stdin - detect format from first bytes
    const buf = Buffer.alloc(0);
    let buffer = "";

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      this.processBuffer(buffer).then(remaining => {
        buffer = remaining;
      });
    });

    process.stdin.on("end", () => {
      process.exit(0);
    });
  }

  private async processBuffer(buffer: string): Promise<string> {
    while (buffer.length > 0) {
      // Try NDJSON first (newline-delimited)
      const nlIndex = buffer.indexOf("\n");
      if (nlIndex === -1 && !buffer.startsWith("Content-Length:")) break;

      if (buffer.startsWith("Content-Length:")) {
        // LSP-style Content-Length framing
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;
        const header = buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/);
        if (!match) break;
        const length = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + length) break;
        const body = buffer.slice(bodyStart, bodyStart + length);
        buffer = buffer.slice(bodyStart + length);
        await this.handleMessage(body);
      } else if (nlIndex !== -1) {
        // NDJSON
        this.useNdjson = true;
        const line = buffer.slice(0, nlIndex).trim();
        buffer = buffer.slice(nlIndex + 1);
        if (line) await this.handleMessage(line);
      } else {
        break;
      }
    }
    return buffer;
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.sendError(undefined, -32700, "Parse error");
      return;
    }

    this.debugLog(`RECV ${raw}`);

    // Handle initialize
    if (msg.method === "initialize") {
      this.sendResult(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: this.serverName, version: this.serverVersion },
      });
      return;
    }

    if (msg.method === "notifications/initialized") return;

    const handler = this.handlers.get(msg.method);
    if (!handler) {
      this.sendError(msg.id, -32601, `Method not found: ${msg.method}`);
      return;
    }

    try {
      const result = await handler(msg.params ?? {});
      this.sendResult(msg.id, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendError(msg.id, -32000, message);
    }
  }
}
