/**
 * Web tools: web_fetch (URL -> readable text) and web_search (search API).
 * Both are read-only and safe to run concurrently with other read-only tools.
 *
 * Content returned by these tools is untrusted external data — the system
 * prompt (see agent/context.ts buildIdentity) already warns the model not to
 * follow instructions found in it, gated on these exact tool names.
 */

import { Tool } from "./base.js";

const MAX_FETCH_BYTES = 2_000_000;
const MAX_OUTPUT_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "tarantul/0.1 (+https://github.com/FarkhodovIslom/tarantul)";

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
  return trimmed.slice(0, maxChars) + `\n\n... (truncated, ${trimmed.length - maxChars} more chars)`;
}

const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
  "&quot;": '"', "&#39;": "'", "&apos;": "'", "&mdash;": "—", "&ndash;": "–",
};

/** Minimal HTML -> text extraction: strips scripts/styles/tags, decodes common entities. */
function htmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|p|div|h[1-6]|li|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  text = text.replace(/&(nbsp|amp|lt|gt|quot|#39|apos|mdash|ndash);/g, (m) => HTML_ENTITIES[m] ?? m);
  text = text.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));

  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

export class WebFetchTool extends Tool {
  override readonly name = "web_fetch";
  override get readOnly(): boolean { return true; }
  override readonly description =
    "Fetch a URL (http/https) and return its readable text content. " +
    "Returns native image content for direct image URLs is not supported — text/HTML/JSON only.";

  readonly parameters = {
    type: "object",
    properties: {
      url: { type: "string", description: "The http(s) URL to fetch" },
    },
    required: ["url"],
  };

  constructor(private readonly proxy: string | null = null) {
    super();
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const raw = String(params["url"] ?? "").trim();
    if (!raw) return "Error: url is required";

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return `Error: invalid URL '${raw}'`;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `Error: unsupported URL scheme '${parsed.protocol}'`;
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

      if (contentType.includes("application/json")) {
        return truncate(buf.toString("utf-8"), MAX_OUTPUT_CHARS);
      }
      if (contentType && !contentType.includes("html") && !contentType.includes("text")) {
        return `Error: unsupported content-type '${contentType}' for web_fetch (expected HTML, text, or JSON)`;
      }

      const text = htmlToText(buf.toString("utf-8"));
      return text ? truncate(text, MAX_OUTPUT_CHARS) : "(no readable text content found at this URL)";
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
  apiKey: string;
  baseUrl?: string | undefined;
  maxResults?: number | undefined;
}

const DEFAULT_BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";

export class WebSearchTool extends Tool {
  override readonly name = "web_search";
  override get readOnly(): boolean { return true; }
  override readonly description =
    "Search the web and return a list of results (title, url, snippet).";

  readonly parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
    },
    required: ["query"],
  };

  private readonly provider: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxResults: number;

  constructor(opts: WebSearchOpts) {
    super();
    this.provider = (opts.provider || "brave").toLowerCase();
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl || DEFAULT_BRAVE_URL;
    this.maxResults = Math.min(Math.max(opts.maxResults ?? 5, 1), 20);
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const query = String(params["query"] ?? "").trim();
    if (!query) return "Error: query is required";
    if (!this.apiKey) {
      return "Error: web_search is not configured. Set tools.web.search.apiKey in your config.";
    }
    if (this.provider !== "brave") {
      return `Error: unsupported search provider '${this.provider}' (only 'brave' is currently supported)`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const url = new URL(this.baseUrl);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(this.maxResults));

      const response = await fetch(url.toString(), {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          "X-Subscription-Token": this.apiKey,
        },
      });

      if (!response.ok) {
        return `Error: search failed with status ${response.status} ${response.statusText}`;
      }

      const data = (await response.json()) as Record<string, unknown>;
      const web = data["web"] as Record<string, unknown> | undefined;
      const results = (web?.["results"] as Record<string, unknown>[] | undefined) ?? [];
      if (results.length === 0) return `No results found for "${query}"`;

      const lines = results.slice(0, this.maxResults).map((r, i) => {
        const title = String(r["title"] ?? "(no title)");
        const link = String(r["url"] ?? "");
        const desc = String(r["description"] ?? "").replace(/<[^>]+>/g, "");
        return `${i + 1}. ${title}\n   ${link}\n   ${desc}`;
      });
      return lines.join("\n\n");
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return `Error: search timed out after ${FETCH_TIMEOUT_MS / 1000}s`;
      }
      return `Error searching for "${query}": ${err}`;
    } finally {
      clearTimeout(timer);
    }
  }
}
