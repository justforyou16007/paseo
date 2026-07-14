import { createCli, runCli } from "../lib/cli.js";

const BASE_URL = "https://api.openalex.org";

interface OpenAlexWork {
  id: string | null;
  openalex_id: string;
  doi: string | null;
  title: string;
  authors: string[];
  author_count: number;
  publication_year: number | null;
  publication_date: string | null;
  venue: string;
  venue_type: string | null;
  cited_by_count: number;
  is_oa: boolean;
  oa_status: string;
  oa_url: string | null;
  abstract: string | null;
  topics: string[];
  keywords: string[];
  type: string | null;
  language: string | null;
  referenced_works_count: number;
  url: string | null;
}

function reconstructAbstract(invertedIndex: Record<string, number[]> | null): string | null {
  if (!invertedIndex) return null;
  const words: [number, string][] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words.push([pos, word]);
    }
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(([, w]) => w).join(" ");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseWork(work: Record<string, any>): OpenAlexWork {
  const authors: string[] = [];
  for (const authorship of work.authorships ?? []) {
    const author = authorship.author ?? {};
    authors.push(author.display_name ?? "Unknown");
  }

  const primaryLocation = work.primary_location ?? {};
  const source = primaryLocation.source ?? {};
  const venue = source.display_name ?? "Unknown";

  const oaInfo = work.open_access ?? {};
  const oaStatus = oaInfo.oa_status ?? "closed";
  const oaUrl = oaInfo.oa_url ?? null;

  const abstractInverted = work.abstract_inverted_index ?? null;
  const abstract = reconstructAbstract(abstractInverted);

  const topics = (work.topics ?? []).slice(0, 3).map((t: Record<string, string>) => t.display_name);
  const keywords = (work.keywords ?? [])
    .slice(0, 5)
    .map((k: Record<string, string>) => k.display_name);

  const rawId: string = work.id ?? "";
  const doi: string | null = work.doi ? (work.doi as string).replace("https://doi.org/", "") : null;

  return {
    id: work.id ?? null,
    openalex_id: rawId.split("/").pop() ?? "",
    doi,
    title: work.display_name ?? work.title ?? "Untitled",
    authors,
    author_count: authors.length,
    publication_year: work.publication_year ?? null,
    publication_date: work.publication_date ?? null,
    venue,
    venue_type: source.type ?? null,
    cited_by_count: work.cited_by_count ?? 0,
    is_oa: work.is_oa ?? false,
    oa_status: oaStatus,
    oa_url: oaUrl,
    abstract,
    topics,
    keywords,
    type: work.type ?? null,
    language: work.language ?? null,
    referenced_works_count: work.referenced_works_count ?? 0,
    url: work.id ?? null,
  };
}

interface ClientOptions {
  apiKey?: string;
  email?: string;
}

function buildHeaders(opts: ClientOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  const email = opts.email || process.env.OPENALEX_EMAIL;
  if (email) {
    headers["User-Agent"] = `mailto:${email}`;
  }
  return headers;
}

function buildApiKey(opts: ClientOptions): string | undefined {
  return opts.apiKey || process.env.OPENALEX_API_KEY || undefined;
}

async function searchWorks(
  query: string,
  options: {
    maxResults?: number;
    publicationYear?: string;
    workType?: string;
    openAccess?: boolean;
    minCitations?: number;
    sort?: string;
  } = {},
  clientOpts: ClientOptions = {},
): Promise<OpenAlexWork[]> {
  const maxResults = options.maxResults ?? 10;
  const sort = options.sort ?? "relevance_score:desc";

  const filters: string[] = [];
  if (options.publicationYear) filters.push(`publication_year:${options.publicationYear}`);
  if (options.workType) filters.push(`type:${options.workType}`);
  if (options.openAccess != null) filters.push(`is_oa:${String(options.openAccess).toLowerCase()}`);
  if (options.minCitations) filters.push(`cited_by_count:>${options.minCitations}`);

  const params = new URLSearchParams({
    search: query,
    per_page: String(Math.min(maxResults, 200)),
    sort,
  });

  if (filters.length) params.set("filter", filters.join(","));
  const apiKey = buildApiKey(clientOpts);
  if (apiKey) params.set("api_key", apiKey);

  const resp = await fetch(`${BASE_URL}/works?${params.toString()}`, {
    headers: buildHeaders(clientOpts),
    signal: AbortSignal.timeout(30_000),
  });

  if (resp.status === 429) {
    console.error("Rate limit exceeded. Consider using an API key or reducing request frequency.");
  }

  if (!resp.ok) throw new Error(`OpenAlex API error: HTTP ${resp.status}`);

  const data = await resp.json();
  const results: OpenAlexWork[] = [];
  for (const work of data.results ?? []) {
    results.push(parseWork(work));
  }
  return results.slice(0, maxResults);
}

async function getWork(workId: string, clientOpts: ClientOptions = {}): Promise<OpenAlexWork> {
  let url: string;
  if (workId.startsWith("10.")) {
    url = `${BASE_URL}/works/doi:${workId}`;
  } else {
    url = `${BASE_URL}/works/${workId}`;
  }

  const params = new URLSearchParams();
  const apiKey = buildApiKey(clientOpts);
  if (apiKey) params.set("api_key", apiKey);

  const fullUrl = params.toString() ? `${url}?${params.toString()}` : url;
  const resp = await fetch(fullUrl, {
    headers: buildHeaders(clientOpts),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) throw new Error(`OpenAlex API error: HTTP ${resp.status}`);

  return parseWork(await resp.json());
}

function formatTextResults(results: OpenAlexWork[]): void {
  console.log(`Found ${results.length} papers:\n`);
  results.forEach((work, i) => {
    console.log(`${i + 1}. ${work.title}`);
    const authorStr = work.authors.slice(0, 3).join(", ");
    const etAl = work.authors.length > 3 ? " et al." : "";
    console.log(`   Authors: ${authorStr}${etAl}`);
    console.log(`   Year: ${work.publication_year} | Venue: ${work.venue}`);
    console.log(`   Citations: ${work.cited_by_count} | OA: ${work.is_oa ? "Yes" : "No"}`);
    if (work.doi) console.log(`   DOI: ${work.doi}`);
    if (work.oa_url) console.log(`   PDF: ${work.oa_url}`);
    if (work.abstract) {
      const preview =
        work.abstract.length > 200 ? work.abstract.slice(0, 200) + "..." : work.abstract;
      console.log(`   Abstract: ${preview}`);
    }
    console.log();
  });
}

function formatTextWork(work: OpenAlexWork): void {
  console.log(`Title: ${work.title}`);
  console.log(`Authors: ${work.authors.join(", ")}`);
  console.log(`Year: ${work.publication_year} | Venue: ${work.venue}`);
  console.log(`Citations: ${work.cited_by_count} | OA: ${work.is_oa ? "Yes" : "No"}`);
  if (work.doi) console.log(`DOI: ${work.doi}`);
  if (work.oa_url) console.log(`PDF: ${work.oa_url}`);
  if (work.topics.length) console.log(`Topics: ${work.topics.join(", ")}`);
  if (work.abstract) console.log(`\nAbstract:\n${work.abstract}`);
}

const SORT_MAP: Record<string, string> = {
  relevance: "relevance_score:desc",
  citations: "cited_by_count:desc",
  date: "publication_date:desc",
};

const program = createCli("openalex-fetch", "Search OpenAlex for academic papers");

program
  .command("search")
  .description("Search for works")
  .argument("<query>", "Search query")
  .option("--max <n>", "Maximum results", "10")
  .option("--year <year>", "Publication year filter (e.g., '2023' or '2020-2023')")
  .option(
    "--type <type>",
    "Work type filter (article, preprint, book, book-chapter, dataset, dissertation)",
  )
  .option("--open-access", "Only open access papers")
  .option("--min-citations <n>", "Minimum citation count")
  .option("--sort <sort>", "Sort order (relevance, citations, date)", "relevance")
  .option("--json", "Output as JSON")
  .action(
    async (
      query: string,
      opts: {
        max: string;
        year?: string;
        type?: string;
        openAccess?: boolean;
        minCitations?: string;
        sort: string;
        json?: boolean;
      },
    ) => {
      const results = await searchWorks(query, {
        maxResults: parseInt(opts.max, 10),
        publicationYear: opts.year,
        workType: opts.type,
        openAccess: opts.openAccess || undefined,
        minCitations: opts.minCitations ? parseInt(opts.minCitations, 10) : undefined,
        sort: SORT_MAP[opts.sort] ?? "relevance_score:desc",
      });

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        formatTextResults(results);
      }
    },
  );

program
  .command("work")
  .description("Get specific work by ID/DOI")
  .argument("<work_id>", "Work ID (DOI, OpenAlex ID, etc.)")
  .option("--json", "Output as JSON")
  .action(async (workId: string, opts: { json?: boolean }) => {
    const work = await getWork(workId);
    if (opts.json) {
      console.log(JSON.stringify(work, null, 2));
    } else {
      formatTextWork(work);
    }
  });

runCli(program);
