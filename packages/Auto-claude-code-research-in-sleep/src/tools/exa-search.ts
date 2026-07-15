#!/usr/bin/env node
import { createCli, runCli } from "../lib/cli.js";

const EXA_API_BASE = "https://api.exa.ai";

interface ExaResult {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  highlights?: string[];
  text?: string;
  summary?: string;
}

interface ExaResponse {
  results: ExaResult[];
}

function getApiKey(): string {
  const key = (process.env.EXA_API_KEY ?? "").trim();
  if (!key) {
    throw new Error(
      "EXA_API_KEY environment variable is required. Get your key from: https://exa.ai",
    );
  }
  return key;
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function buildContentParams(contentMode: string, maxChars: number): Record<string, unknown> {
  if (contentMode === "none") return {};
  if (contentMode === "highlights")
    return { highlights: { num_sentences: 3, highlights_per_url: 3, query: "" } };
  if (contentMode === "text") return { text: { max_characters: maxChars } };
  if (contentMode === "summary") return { summary: true };
  return { highlights: { num_sentences: 3, highlights_per_url: 3, query: "" } };
}

function processResult(result: ExaResult, contentMode: string): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    title: result.title ?? "No Title",
    url: result.url ?? "",
  };

  if (result.publishedDate) entry.published_date = result.publishedDate;
  if (result.author) entry.author = result.author;

  if (contentMode === "highlights" && result.highlights) {
    entry.highlights = result.highlights;
  } else if (contentMode === "text" && result.text) {
    entry.text = result.text;
  } else if (contentMode === "summary" && result.summary) {
    entry.summary = result.summary;
  }

  return entry;
}

async function exaFetch(endpoint: string, body: Record<string, unknown>): Promise<ExaResponse> {
  const apiKey = getApiKey();
  const resp = await fetch(`${EXA_API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "x-exa-integration": "auto-claude-code-research-in-sleep",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Exa API error (${resp.status}): ${text}`);
  }
  return (await resp.json()) as ExaResponse;
}

async function search(opts: {
  query: string;
  maxResults: number;
  searchType: string;
  contentMode: string;
  maxChars: number;
  category?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  includeText?: string[];
  excludeText?: string[];
  startDate?: string;
  endDate?: string;
  location?: string;
}): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    query: opts.query,
    num_results: opts.maxResults,
    type: opts.searchType,
    ...buildContentParams(opts.contentMode, opts.maxChars),
  };

  if (opts.category) body.category = opts.category;
  if (opts.includeDomains) body.include_domains = opts.includeDomains;
  if (opts.excludeDomains) body.exclude_domains = opts.excludeDomains;
  if (opts.includeText) body.include_text = opts.includeText;
  if (opts.excludeText) body.exclude_text = opts.excludeText;
  if (opts.startDate) body.start_published_date = opts.startDate;
  if (opts.endDate) body.end_published_date = opts.endDate;
  if (opts.location) body.user_location = opts.location;

  const response = await exaFetch("/search", body);

  return {
    mode: "search",
    query: opts.query,
    type: opts.searchType,
    returned: response.results.length,
    data: response.results.map((r) => processResult(r, opts.contentMode)),
  };
}

async function findSimilar(opts: {
  url: string;
  maxResults: number;
  contentMode: string;
  maxChars: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  startDate?: string;
  endDate?: string;
}): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    url: opts.url,
    num_results: opts.maxResults,
    ...buildContentParams(opts.contentMode, opts.maxChars),
  };

  if (opts.includeDomains) body.include_domains = opts.includeDomains;
  if (opts.excludeDomains) body.exclude_domains = opts.excludeDomains;
  if (opts.startDate) body.start_published_date = opts.startDate;
  if (opts.endDate) body.end_published_date = opts.endDate;

  const response = await exaFetch("/findSimilar", body);

  return {
    mode: "find-similar",
    url: opts.url,
    returned: response.results.length,
    data: response.results.map((r) => processResult(r, opts.contentMode)),
  };
}

async function getContents(opts: {
  urls: string[];
  contentMode: string;
  maxChars: number;
}): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    ids: opts.urls,
    ...buildContentParams(opts.contentMode, opts.maxChars),
  };

  const response = await exaFetch("/contents", body);

  return {
    mode: "get-contents",
    returned: response.results.length,
    data: response.results.map((r) => processResult(r, opts.contentMode)),
  };
}

const program = createCli("exa-search", "AI-powered web search via Exa.");

program
  .command("search")
  .description("Search the web via Exa")
  .argument("<query>", "Search query")
  .option("--max <n>", "Maximum number of results (default: 10)", "10")
  .option("--type <type>", "Search type: auto, neural, fast, instant (default: auto)", "auto")
  .option(
    "--content <mode>",
    "Content retrieval mode: highlights, text, summary, none (default: highlights)",
    "highlights",
  )
  .option("--max-chars <n>", "Max characters for content extraction (default: 4000)", "4000")
  .option("--category <category>", 'Category filter: "company", "research paper", "news", etc.')
  .option("--include-domains <domains>", "Comma-separated domains to include")
  .option("--exclude-domains <domains>", "Comma-separated domains to exclude")
  .option("--include-text <phrases>", "Comma-separated phrases that must appear in page")
  .option("--exclude-text <phrases>", "Comma-separated phrases to exclude from results")
  .option("--start-date <date>", "Only results published after this date (ISO 8601)")
  .option("--end-date <date>", "Only results published before this date (ISO 8601)")
  .option("--location <code>", "Two-letter ISO country code for localized results")
  .action(
    async (
      query: string,
      opts: {
        max: string;
        type: string;
        content: string;
        maxChars: string;
        category?: string;
        includeDomains?: string;
        excludeDomains?: string;
        includeText?: string;
        excludeText?: string;
        startDate?: string;
        endDate?: string;
        location?: string;
      },
    ) => {
      const result = await search({
        query,
        maxResults: parseInt(opts.max, 10),
        searchType: opts.type,
        contentMode: opts.content,
        maxChars: parseInt(opts.maxChars, 10),
        category: opts.category,
        includeDomains: parseList(opts.includeDomains),
        excludeDomains: parseList(opts.excludeDomains),
        includeText: parseList(opts.includeText),
        excludeText: parseList(opts.excludeText),
        startDate: opts.startDate,
        endDate: opts.endDate,
        location: opts.location,
      });
      console.log(JSON.stringify(result, null, 2));
    },
  );

program
  .command("find-similar")
  .description("Find pages similar to a URL")
  .argument("<url>", "URL to find similar pages for")
  .option("--max <n>", "Maximum number of results (default: 10)", "10")
  .option(
    "--content <mode>",
    "Content retrieval mode: highlights, text, summary, none (default: highlights)",
    "highlights",
  )
  .option("--max-chars <n>", "Max characters for content extraction (default: 4000)", "4000")
  .option("--include-domains <domains>", "Comma-separated domains to include")
  .option("--exclude-domains <domains>", "Comma-separated domains to exclude")
  .option("--start-date <date>", "Only results published after this date (ISO 8601)")
  .option("--end-date <date>", "Only results published before this date (ISO 8601)")
  .action(
    async (
      url: string,
      opts: {
        max: string;
        content: string;
        maxChars: string;
        includeDomains?: string;
        excludeDomains?: string;
        startDate?: string;
        endDate?: string;
      },
    ) => {
      const result = await findSimilar({
        url,
        maxResults: parseInt(opts.max, 10),
        contentMode: opts.content,
        maxChars: parseInt(opts.maxChars, 10),
        includeDomains: parseList(opts.includeDomains),
        excludeDomains: parseList(opts.excludeDomains),
        startDate: opts.startDate,
        endDate: opts.endDate,
      });
      console.log(JSON.stringify(result, null, 2));
    },
  );

program
  .command("get-contents")
  .description("Retrieve content for specific URLs")
  .argument("<urls...>", "URLs to fetch content for")
  .option(
    "--content <mode>",
    "Content retrieval mode: highlights, text, summary, none (default: text)",
    "text",
  )
  .option("--max-chars <n>", "Max characters for content extraction (default: 10000)", "10000")
  .action(async (urls: string[], opts: { content: string; maxChars: string }) => {
    const result = await getContents({
      urls,
      contentMode: opts.content,
      maxChars: parseInt(opts.maxChars, 10),
    });
    console.log(JSON.stringify(result, null, 2));
  });

runCli(program);
