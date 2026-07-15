import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const APP_ID = process.env["FEISHU_APP_ID"] ?? "";
const APP_SECRET = process.env["FEISHU_APP_SECRET"] ?? "";
const USER_ID = process.env["FEISHU_USER_ID"] ?? "";
const PORT = Number(process.env["BRIDGE_PORT"] ?? "5000");

if (!APP_ID || !APP_SECRET) {
  process.stderr.write("Error: FEISHU_APP_ID and FEISHU_APP_SECRET are required\n");
  process.exit(1);
}

if (!USER_ID) {
  process.stderr.write(
    "Warning: FEISHU_USER_ID not set — /send will require user_id in request body\n",
  );
}

let tenantAccessToken = "";
let tokenExpiresAt = 0;

async function getTenantToken(): Promise<string> {
  if (tenantAccessToken && Date.now() < tokenExpiresAt) {
    return tenantAccessToken;
  }

  const response = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
    },
  );

  const data = (await response.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };

  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Failed to get tenant token: ${data.msg}`);
  }

  tenantAccessToken = data.tenant_access_token;
  tokenExpiresAt = Date.now() + (data.expire ?? 7200) * 1000 - 60_000;
  return tenantAccessToken;
}

type ReplySlot = {
  resolve: (text: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

const replySlots = new Map<string, ReplySlot>();

async function sendCard(
  userId: string,
  title: string,
  body: string,
  color: string = "blue",
): Promise<Record<string, unknown>> {
  const token = await getTenantToken();
  const card = JSON.stringify({
    header: {
      title: { tag: "plain_text", content: title },
      template: color,
    },
    elements: [{ tag: "markdown", content: body }],
  });

  const response = await fetch(
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: userId,
        msg_type: "interactive",
        content: card,
      }),
    },
  );

  const data = (await response.json()) as {
    code: number;
    msg: string;
    data?: { message_id?: string };
  };

  if (data.code !== 0) {
    return { error: data.msg, code: data.code };
  }

  const messageId = data.data?.message_id;
  if (!messageId) {
    return { error: "No message_id in response" };
  }

  return { ok: true, message_id: messageId };
}

async function sendText(userId: string, text: string): Promise<Record<string, unknown>> {
  const token = await getTenantToken();

  const response = await fetch(
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: userId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    },
  );

  const data = (await response.json()) as {
    code: number;
    msg: string;
    data?: { message_id?: string };
  };

  if (data.code !== 0) {
    return { error: data.msg, code: data.code };
  }

  return { ok: true, message_id: data.data?.message_id };
}

function pollReply(messageId: string, timeout: number = 300): Promise<Record<string, unknown>> {
  const existing = replySlots.get(messageId);
  if (existing) {
    return new Promise((resolve) => {
      existing.resolve = (text) => {
        clearTimeout(existing.timer);
        replySlots.delete(messageId);
        resolve(text ? { reply: text } : { timeout: true });
      };
    });
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      replySlots.delete(messageId);
      resolve({ timeout: true });
    }, timeout * 1000);

    replySlots.set(messageId, {
      resolve: (text) => {
        clearTimeout(timer);
        replySlots.delete(messageId);
        resolve(text ? { reply: text } : { timeout: true });
      },
      timer,
    });
  });
}

function receiveReply(messageId: string, text: string): void {
  const slot = replySlots.get(messageId);
  if (slot) {
    slot.resolve(text);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function jsonResponse(
  res: ServerResponse,
  data: Record<string, unknown>,
  status: number = 200,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function parseQuery(url: string): Record<string, string> {
  const params: Record<string, string> = {};
  const qIndex = url.indexOf("?");
  if (qIndex < 0) return params;
  const query = url.slice(qIndex + 1);
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq >= 0) {
      params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
    }
  }
  return params;
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  try {
    if (method === "GET" && url === "/health") {
      jsonResponse(res, { status: "ok", port: PORT });
      return;
    }

    if (method === "GET" && url.startsWith("/poll")) {
      const params = parseQuery(url);
      const messageId = params["message_id"] ?? "";
      const timeout = Number(params["timeout"] ?? "300");

      if (!messageId) {
        jsonResponse(res, { error: "message_id required" }, 400);
        return;
      }

      const result = await pollReply(messageId, timeout);
      jsonResponse(res, result);
      return;
    }

    if (method === "POST" && url === "/send") {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

      const userId = (body["user_id"] as string) ?? USER_ID;
      if (!userId) {
        jsonResponse(
          res,
          {
            error: "user_id required (set FEISHU_USER_ID or pass in body)",
          },
          400,
        );
        return;
      }

      const msgType = (body["type"] as string) ?? "card";
      const title = (body["title"] as string) ?? "ARIS Notification";
      const content = (body["body"] as string) ?? (body["content"] as string) ?? "";
      const color = (body["color"] as string) ?? "blue";

      const result =
        msgType === "text"
          ? await sendText(userId, content)
          : await sendCard(userId, title, content, color);

      jsonResponse(res, result);
      return;
    }

    if (method === "POST" && url === "/reply") {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

      const messageId = (body["message_id"] as string) ?? "";
      const text = (body["text"] as string) ?? "";

      if (messageId) {
        receiveReply(messageId, text);
        jsonResponse(res, { ok: true });
      } else {
        jsonResponse(res, { error: "message_id required" }, 400);
      }
      return;
    }

    jsonResponse(res, { error: "not found" }, 404);
  } catch (err) {
    jsonResponse(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

httpServer.listen(PORT, "0.0.0.0", () => {
  process.stderr.write(`Feishu Bridge Server running on http://0.0.0.0:${PORT}\n`);
  process.stderr.write("  POST /send   — send card/text to Feishu\n");
  process.stderr.write("  GET  /poll   — wait for user reply\n");
  process.stderr.write("  POST /reply  — receive user reply (webhook)\n");
  process.stderr.write("  GET  /health — health check\n");
});
