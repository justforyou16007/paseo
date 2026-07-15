import { McpStdio } from "../../lib/mcp-stdio.js";

const MINIMAX_API_KEY = process.env["MINIMAX_API_KEY"] ?? "";
const MINIMAX_BASE_URL = process.env["MINIMAX_BASE_URL"] ?? "https://api.minimax.io/v1";
const DEFAULT_MODEL = process.env["MINIMAX_MODEL"] ?? "MiniMax-M3";

type Message = { role: string; content: string };

function clampTemperature(temp: unknown): number {
  if (temp == null) return 0.7;
  const n = Number(temp);
  if (Number.isNaN(n)) throw new Error(`Invalid temperature: ${temp}`);
  if (n <= 0.0) return 0.01;
  if (n > 1.0) return 1.0;
  return n;
}

async function callMinimax(
  messages: Message[],
  model?: string,
  temperature: unknown = 0.7,
): Promise<[string | null, string | null]> {
  if (!MINIMAX_API_KEY) {
    return [null, "MINIMAX_API_KEY environment variable not set"];
  }

  const url = `${MINIMAX_BASE_URL}/chat/completions`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${MINIMAX_API_KEY}`,
  };

  let clampedTemp: number;
  try {
    clampedTemp = clampTemperature(temperature);
  } catch (err) {
    return [null, err instanceof Error ? err.message : String(err)];
  }

  const payload = {
    model: model ?? DEFAULT_MODEL,
    messages,
    max_tokens: 4096,
    temperature: clampedTemp,
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const text = await response.text();
      return [null, `API error ${response.status}: ${text.slice(0, 500)}`];
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (content == null) {
      return [null, "Unexpected API response structure"];
    }
    return [content, null];
  } catch (err) {
    return [null, err instanceof Error ? err.message : String(err)];
  }
}

const server = new McpStdio("minimax-chat", "2.0.0");

server.onRequest("tools/list", () => ({
  tools: [
    {
      name: "minimax_chat",
      description:
        "Send a message to MiniMax model and get a response. Use this for research reviews, code analysis, and general AI tasks. Supports MiniMax-M3 (default, 512K context), MiniMax-M2.7 (204K context) and MiniMax-M2.7-highspeed.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The prompt to send to MiniMax",
          },
          model: {
            type: "string",
            description:
              "Model to use: MiniMax-M3 (default, 512K context), MiniMax-M2.7 (204K context) or MiniMax-M2.7-highspeed (faster, 204K context)",
            default: "MiniMax-M3",
            enum: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
          },
          system: {
            type: "string",
            description: "Optional system prompt",
          },
          temperature: {
            type: "number",
            description: "Sampling temperature (0.01-1.0). Default: 0.7",
            default: 0.7,
          },
        },
        required: ["prompt"],
      },
    },
  ],
}));

server.onRequest("tools/call", async (params) => {
  const toolName = (params as { name?: string }).name ?? "";
  const args = (params as { arguments?: Record<string, unknown> }).arguments ?? {};

  if (toolName !== "minimax_chat") {
    throw Object.assign(new Error(`Unknown tool: ${toolName}`), {
      code: -32601,
    });
  }

  const prompt = (args["prompt"] as string) ?? "";
  const model = (args["model"] as string) ?? DEFAULT_MODEL;
  const system = (args["system"] as string) ?? "";
  const temperature = args["temperature"] ?? 0.7;

  const messages: Message[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const [content, error] = await callMinimax(messages, model, temperature);

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error}` }],
      isError: true,
    };
  }

  return { content: [{ type: "text", text: content! }] };
});

server.run();
