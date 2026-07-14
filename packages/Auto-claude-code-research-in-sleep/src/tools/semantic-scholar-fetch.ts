import { createCli, runCli } from "../lib/cli.js";

const API_BASE = "https://api.semanticscholar.org/graph/v1";
const USER_AGENT = "s2-fetch/1.1";
const DEFAULT_TIMEOUT = 30_000;

const DEFAULT_FIELDS =
  "paperId,title,abstract,year,venue,publicationVenue,publicationTypes," +
  "publicationDate,url,openAccessPdf,authors,externalIds,citationCount," +
  "referenceCount,fieldsOfStudy,s2FieldsOfStudy,tldr";

const DEFAULT_BULK_FIELDS =
  "paperId,title,abstract,year,venue,publicationDate,url,authors," +
  "externalIds,citationCount,referenceCount,fieldsOfStudy";

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
  const apiKey = (process.env.SEMANTIC_SCHOLAR_API_KEY ?? "").trim();
  if (apiKey) h["x-api-key"] = apiKey;
  return h;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function requestJson(url: string, retries = 2): Promise<any> {
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: headers(),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
      });

      if ([429, 500, 502, 503, 504].includes(resp.status) && attempt < retries) {
        await sleep(1500 * (attempt + 1));
        lastErr = new Error(`HTTP ${resp.status}`);
        continue;
      }

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        let message = `HTTP ${resp.status}`;
        if (body) message += `: ${body}`;
        throw new Error(message);
      }

      return await resp.json();
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("HTTP ")) throw err;
      if (attempt < retries) {
        await sleep(1500 * (attempt + 1));
        lastErr = err instanceof Error ? err : new Error(String(err));
        continue;
      }
      throw new Error(`Network error: ${err}`);
    }
  }

  throw new Error(`Request failed after retries: ${lastErr}`);
}

function cleanText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim().replace(/\n/g, " ");
  return text || null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseAuthor(author: Record<string, any>): Record<string, unknown> {
  return {
    authorId: author.authorId ?? null,
    name: cleanText(author.name),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parsePublicationVenue(
  pubVenue: Record<string, any> | null,
): Record<string, unknown> | null {
  if (!pubVenue) return null;
  return {
    id: pubVenue.id ?? null,
    name: cleanText(pubVenue.name),
    type: cleanText(pubVenue.type),
    issn: cleanText(pubVenue.issn),
    url: cleanText(pubVenue.url),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parsePaper(paper: Record<string, any>): Record<string, unknown> {
  const authors = paper.authors ?? [];
  return {
    paperId: paper.paperId ?? null,
    title: cleanText(paper.title),
    abstract: cleanText(paper.abstract),
    year: paper.year ?? null,
    venue: cleanText(paper.venue),
    publicationVenue: parsePublicationVenue(paper.publicationVenue ?? null),
    publicationTypes: paper.publicationTypes ?? null,
    publicationDate: cleanText(paper.publicationDate),
    url: cleanText(paper.url),
    openAccessPdf: paper.openAccessPdf ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authors: authors.map((a: any) => parseAuthor(a)),
    externalIds: paper.externalIds ?? null,
    citationCount: paper.citationCount ?? null,
    referenceCount: paper.referenceCount ?? null,
    fieldsOfStudy: paper.fieldsOfStudy ?? null,
    s2FieldsOfStudy: paper.s2FieldsOfStudy ?? null,
    tldr: paper.tldr ?? null,
  };
}

interface FilterArgs {
  fieldsOfStudy?: string;
  venue?: string;
  year?: string;
  minCitations?: string;
  publicationTypes?: string;
  openAccess?: boolean;
}

async function searchPapers(
  query: string,
  maxResults = 10,
  offset = 0,
  fields = DEFAULT_FIELDS,
  filters: FilterArgs = {},
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({
    query,
    limit: String(maxResults),
    offset: String(offset),
    fields,
  });
  if (filters.fieldsOfStudy) params.set("fieldsOfStudy", filters.fieldsOfStudy);
  if (filters.venue) params.set("venue", filters.venue);
  if (filters.year) params.set("year", filters.year);
  if (filters.minCitations != null) params.set("minCitationCount", filters.minCitations);
  if (filters.publicationTypes) params.set("publicationTypes", filters.publicationTypes);
  if (filters.openAccess) params.set("openAccessPdf", "");

  const url = `${API_BASE}/paper/search?${params.toString()}`;
  const payload = await requestJson(url);

  const data = payload.data ?? [];
  return {
    mode: "search",
    total: payload.total ?? null,
    offset,
    next_offset: offset + data.length,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: data.map((item: any) => parsePaper(item)),
  };
}

async function searchBulk(
  query: string,
  maxResults = 100,
  token: string | undefined,
  fields = DEFAULT_BULK_FIELDS,
  sort: string | undefined,
  filters: FilterArgs = {},
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({
    query,
    limit: String(maxResults),
    fields,
  });
  if (token) params.set("token", token);
  if (sort) params.set("sort", sort);
  if (filters.fieldsOfStudy) params.set("fieldsOfStudy", filters.fieldsOfStudy);
  if (filters.venue) params.set("venue", filters.venue);
  if (filters.year) params.set("year", filters.year);
  if (filters.minCitations != null) params.set("minCitationCount", filters.minCitations);
  if (filters.publicationTypes) params.set("publicationTypes", filters.publicationTypes);
  if (filters.openAccess) params.set("openAccessPdf", "");

  const url = `${API_BASE}/paper/search/bulk?${params.toString()}`;
  const payload = await requestJson(url);

  const data = payload.data ?? [];
  return {
    mode: "search-bulk",
    token: payload.token ?? null,
    returned: data.length,
    sort: sort ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: data.map((item: any) => parsePaper(item)),
  };
}

async function getPaper(
  paperId: string,
  fields = DEFAULT_FIELDS,
): Promise<Record<string, unknown>> {
  const encodedId = encodeURIComponent(paperId);
  const params = new URLSearchParams({ fields });
  const url = `${API_BASE}/paper/${encodedId}?${params.toString()}`;
  const payload = await requestJson(url);
  return parsePaper(payload);
}

function addFilterOptions(cmd: import("commander").Command): import("commander").Command {
  return cmd
    .option(
      "--fields-of-study <fields>",
      "Comma-separated fields of study filter, e.g. 'Computer Science,Engineering'",
    )
    .option("--venue <venue>", "Comma-separated venue filter, e.g. 'IEEE,ACM' or 'Nature'")
    .option("--year <year>", "Year or range, e.g. '2023', '2020-2024', '2020-', '-2023'")
    .option("--min-citations <n>", "Minimum citation count filter")
    .option(
      "--publication-types <types>",
      "Comma-separated types: JournalArticle,Conference,Review,etc.",
    )
    .option("--open-access", "Only return papers with a public PDF");
}

const program = createCli(
  "semantic-scholar-fetch",
  "Search and fetch papers from Semantic Scholar.",
);

const searchCmd = program
  .command("search")
  .description("Relevance search for papers")
  .argument("<query>", "Keyword query")
  .option("--max <n>", "Maximum number of results", "10")
  .option("--offset <n>", "Offset for pagination", "0")
  .option("--fields <fields>", "Comma-separated response fields", DEFAULT_FIELDS);
addFilterOptions(searchCmd).action(async (query: string, opts) => {
  const result = await searchPapers(
    query,
    parseInt(opts.max, 10),
    parseInt(opts.offset, 10),
    opts.fields,
    {
      fieldsOfStudy: opts.fieldsOfStudy,
      venue: opts.venue,
      year: opts.year,
      minCitations: opts.minCitations,
      publicationTypes: opts.publicationTypes,
      openAccess: opts.openAccess,
    },
  );
  console.log(JSON.stringify(result, null, 2));
});

const bulkCmd = program
  .command("search-bulk")
  .description("Bulk search for papers with token-based pagination")
  .argument("<query>", "Keyword query")
  .option("--max <n>", "Maximum number of results", "100")
  .option("--token <token>", "Continuation token from a previous bulk search page")
  .option("--sort <sort>", "Optional sort, e.g. publicationDate:desc or citationCount:desc")
  .option("--fields <fields>", "Comma-separated response fields", DEFAULT_BULK_FIELDS);
addFilterOptions(bulkCmd).action(async (query: string, opts) => {
  const result = await searchBulk(
    query,
    parseInt(opts.max, 10),
    opts.token,
    opts.fields,
    opts.sort,
    {
      fieldsOfStudy: opts.fieldsOfStudy,
      venue: opts.venue,
      year: opts.year,
      minCitations: opts.minCitations,
      publicationTypes: opts.publicationTypes,
      openAccess: opts.openAccess,
    },
  );
  console.log(JSON.stringify(result, null, 2));
});

program
  .command("paper")
  .description("Fetch one paper by ID")
  .argument(
    "<id>",
    "Semantic Scholar paper ID, DOI, CorpusId:..., ARXIV:..., PMID:..., MAG:..., ACL:..., etc.",
  )
  .option("--fields <fields>", "Comma-separated response fields", DEFAULT_FIELDS)
  .action(async (id: string, opts: { fields: string }) => {
    const result = await getPaper(id, opts.fields);
    console.log(JSON.stringify(result, null, 2));
  });

runCli(program);
