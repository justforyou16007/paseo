import { McpStdio } from "../../lib/mcp-stdio.js";

const API_KEY = process.env["LLM_API_KEY"] ?? "";
const BASE_URL = process.env["LLM_BASE_URL"] ?? "https://api.openai.com/v1";
const DEFAULT_MODEL = process.env["LLM_MODEL"] ?? "gpt-4o";
const FALLBACK_MODEL = process.env["LLM_FALLBACK_MODEL"] ?? "gpt-4o";
const SERVER_NAME = process.env["LLM_SERVER_NAME"] ?? "llm-chat";

type Message = { role: string; content: string };

async function callLlm(
  messages: Message[],
  model?: string,
): Promise<[string | null, string | null]> {
  if (!API_KEY) return [null, "LLM_API_KEY environment variable not set"];

  const useModel = model ?? DEFAULT_MODEL;
  const url = `${BASE_URL.replace(/\/+$/, "")}/chat/completions`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const currentModel = attempt < 2 ? useModel : FALLBACK_MODEL;
    const payload = {
      model: currentModel,
      messages,
      max_tokens: 4096,
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300_000),
      });

      if (response.status === 504) {
        if (attempt < 2) continue;
      }

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

      if (currentModel !== useModel) {
        return [
          `\n\n[Note: Used fallback model ${currentModel} after 504 timeout with ${useModel}]\n${content}`,
          null,
        ];
      }
      return [content, null];
    } catch (err) {
      if (attempt === 2) {
        return [null, err instanceof Error ? err.message : String(err)];
      }
    }
  }

  return [null, "All attempts failed with 504 Gateway Timeout"];
}

const server = new McpStdio(SERVER_NAME, "2.0.0");

server.onRequest("tools/list", () => ({
  tools: [
    {
      name: "chat",
      description: `Send a message to ${DEFAULT_MODEL} and get a response. Use this for research reviews, code analysis, and general AI tasks.`,
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The prompt to send" },
          model: {
            type: "string",
            description: `Model to use (default: ${DEFAULT_MODEL})`,
          },
          system: {
            type: "string",
            description: "Optional system prompt",
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

  if (toolName !== "chat") {
    throw Object.assign(new Error(`Unknown tool: ${toolName}`), {
      code: -32601,
    });
  }

  const prompt = (args["prompt"] as string) ?? "";
  const model = (args["model"] as string) ?? DEFAULT_MODEL;
  const system = (args["system"] as string) ?? "";

  const messages: Message[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const [content, error] = await callLlm(messages, model);

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error}` }],
      isError: true,
    };
  }

  return { content: [{ type: "text", text: content! }] };
});

server.run();
