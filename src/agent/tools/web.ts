/**
 * Web tools: web_fetch (URL -> readable text) and web_search (search API).
 * Both are read-only and safe to run concurrently with other read-only tools.
 *
 * Content returned by these tools is untrusted external data — the system
 * prompt (see agent/context.ts buildIdentity) already warns the model not to
 * follow instructions found in it, gated on these exact tool names.
 */

import { Tool } from "./base.js";
import { extractReadable } from "./html.js";
import { type SearchProvider, createSearchProvider } from "./search-providers.js";
import { checkHostname } from "./ssrf.js";

const MAX_FETCH_BYTES = 2_000_000;
const MAX_OUTPUT_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; tarantul/0.1; +https://github.com/FarkhodovIslom/Tarantul)";

/** Bun's fetch() accepts an extra `proxy` field beyond the standard RequestInit. */
interface BunFetchInit extends RequestInit {
  proxy?: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Read a response body up to `maxBytes`, stopping early rather than buffering everything. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.from(await response.arrayBuffer());

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > maxBytes) {
      chunks.push(value.subarray(0, value.length - (total - maxBytes)));
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function truncate(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n\n... (truncated, ${trimmed.length - maxChars} more chars)`;
}

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

export class WebFetchTool extends Tool {
  override readonly name = "web_fetch";
  override get readOnly(): boolean {
    return true;
  }
  override readonly description =
    "Fetch a URL (http/https) and scrape its main content as readable Markdown " +
    "(title, headings, links, and lists preserved). Handles HTML, plain text, and " +
    "JSON. Images and other binary content are not supported.";

  readonly parameters = {
    type: "object",
    properties: {
      url: { type: "string", description: "The http(s) URL to fetch" },
      max_chars: {
        type: "integer",
        description: `Max characters to return (default ${MAX_OUTPUT_CHARS}).`,
        minimum: 500,
      },
    },
    required: ["url"],
  };

  /**
   * @param proxy         optional outbound proxy for Bun's fetch
   * @param allowPrivate  when true, skip the SSRF guard and permit fetching
   *                      loopback/private/link-local hosts (config opt-in)
   */
  constructor(
    private readonly proxy: string | null = null,
    private readonly allowPrivate = false,
  ) {
    super();
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const raw = String(params["url"] ?? "").trim();
    if (!raw) return "Error: url is required";
    const maxChars =
      typeof params["max_chars"] === "number" && params["max_chars"] >= 500
        ? Math.min(params["max_chars"] as number, MAX_FETCH_BYTES)
        : MAX_OUTPUT_CHARS;

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return `Error: invalid URL '${raw}'`;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `Error: unsupported URL scheme '${parsed.protocol}'`;
    }

    // SSRF guard: resolve the host and refuse private/reserved targets so
    // untrusted content can't steer a fetch at internal services (e.g. cloud
    // metadata at 169.254.169.254). Opt out via tools.web.allowPrivateAddresses.
    if (!this.allowPrivate) {
      const guard = await checkHostname(parsed.hostname);
      if (guard.blocked) {
        return `Error: refusing to fetch — ${guard.reason}. Set tools.web.allowPrivateAddresses to allow private/reserved hosts.`;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const init: BunFetchInit = {
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT },
      };
      if (this.proxy) init.proxy = this.proxy;

      const response = await fetch(parsed.toString(), init);
      if (!response.ok) {
        return `Error: fetch failed with status ${response.status} ${response.statusText}`;
      }

      const contentType = response.headers.get("content-type") ?? "";
      const buf = await readCapped(response, MAX_FETCH_BYTES);
      const body = buf.toString("utf-8");

      if (contentType.includes("application/json")) {
        return truncate(body, maxChars);
      }
      if (contentType && !contentType.includes("html") && !contentType.includes("text")) {
        return `Error: unsupported content-type '${contentType}' for web_fetch (expected HTML, text, or JSON)`;
      }

      // Plain text (non-HTML): return as-is; HTML: scrape to Markdown.
      if (contentType.includes("text/plain") || !/<[a-z!]/i.test(body.slice(0, 500))) {
        const plain = body.trim();
        return plain ? truncate(plain, maxChars) : "(empty response)";
      }

      const { title, text } = extractReadable(body);
      if (!text) return "(no readable text content found at this URL)";
      const doc = title ? `# ${title}\n\n${text}` : text;
      return truncate(doc, maxChars);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return `Error: fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s`;
      }
      return `Error fetching ${raw}: ${err}`;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

export interface WebSearchOpts {
  provider?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  maxResults?: number | undefined;
  proxy?: string | null | undefined;
}

export class WebSearchTool extends Tool {
  override readonly name = "web_search";
  override get readOnly(): boolean {
    return true;
  }
  override readonly description =
    "Search the web and return a list of results (title, url, snippet). Works " +
    "out of the box (DuckDuckGo) with no API key; Brave, Tavily, and SearXNG are " +
    "also supported via config.";

  readonly parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      count: {
        type: "integer",
        description: "Number of results to return (1-20).",
        minimum: 1,
        maximum: 20,
      },
    },
    required: ["query"],
  };

  private readonly search: SearchProvider;
  private readonly defaultCount: number;

  constructor(opts: WebSearchOpts) {
    super();
    this.search = createSearchProvider({
      provider: opts.provider,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      proxy: opts.proxy ?? null,
    });
    this.defaultCount = Math.min(Math.max(opts.maxResults ?? 5, 1), 20);
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const query = String(params["query"] ?? "").trim();
    if (!query) return "Error: query is required";
    const count =
      typeof params["count"] === "number"
        ? Math.min(Math.max(params["count"] as number, 1), 20)
        : this.defaultCount;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const results = await this.search.search(query, count, controller.signal);
      if (results.length === 0) return `No results found for "${query}"`;

      return results
        .map((r, i) => {
          const desc = r.description ? `\n   ${r.description}` : "";
          return `${i + 1}. ${r.title || "(no title)"}\n   ${r.url}${desc}`;
        })
        .join("\n\n");
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return `Error: search timed out after ${FETCH_TIMEOUT_MS / 1000}s`;
      }
      return `Error searching for "${query}" via ${this.search.id}: ${(err as Error).message}`;
    } finally {
      clearTimeout(timer);
    }
  }
}
