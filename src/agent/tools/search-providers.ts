/**
 * Pluggable web-search backends. Two work with no API key at all
 * (`duckduckgo` scrapes the HTML endpoint, `searxng` calls a self-/publicly
 * hosted SearXNG instance), and two are keyed (`brave`, `tavily`).
 *
 * Each provider's response parser is exported as a pure function so it can be
 * unit-tested against sample payloads without network access.
 */

import { htmlToInline } from "./html.js";
import { logger } from "../../utils/logger.js";

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

export interface SearchProvider {
  readonly id: string;
  search(query: string, count: number, signal: AbortSignal): Promise<SearchResult[]>;
}

export interface SearchProviderOpts {
  provider?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  proxy?: string | null | undefined;
}

const USER_AGENT =
  "Mozilla/5.0 (compatible; tarantul/0.1; +https://github.com/FarkhodovIslom/Tarantul)";

/** Bun's fetch() accepts an extra `proxy` field beyond standard RequestInit. */
interface BunFetchInit extends RequestInit {
  proxy?: string;
}

function withProxy(init: RequestInit, proxy?: string | null): BunFetchInit {
  const out: BunFetchInit = { ...init };
  if (proxy) out.proxy = proxy;
  return out;
}

// ---------------------------------------------------------------------------
// DuckDuckGo (keyless — scrapes the HTML endpoint)
// ---------------------------------------------------------------------------

const DDG_URL = "https://html.duckduckgo.com/html/";

/** Decode DuckDuckGo's `/l/?uddg=` redirect wrapper into the real target URL. */
function unwrapDdgUrl(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m?.[1]) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return "";
    }
  }
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("http")) return href;
  return "";
}

export function parseDuckDuckGo(html: string): SearchResult[] {
  const snippets: string[] = [];
  for (const m of html.matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    snippets.push(htmlToInline(m[1] ?? ""));
  }
  const results: SearchResult[] = [];
  let i = 0;
  for (const m of html.matchAll(
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const url = unwrapDdgUrl(m[1] ?? "");
    const title = htmlToInline(m[2] ?? "");
    if (url && title) results.push({ title, url, description: snippets[i] ?? "" });
    i++;
  }
  return results;
}

class DuckDuckGoProvider implements SearchProvider {
  readonly id = "duckduckgo";
  constructor(private readonly proxy?: string | null) {}

  async search(query: string, count: number, signal: AbortSignal): Promise<SearchResult[]> {
    const url = `${DDG_URL}?q=${encodeURIComponent(query)}`;
    const res = await fetch(
      url,
      withProxy({ signal, headers: { "User-Agent": USER_AGENT, Accept: "text/html" } }, this.proxy),
    );
    if (!res.ok) throw new Error(`duckduckgo HTTP ${res.status} ${res.statusText}`);
    return parseDuckDuckGo(await res.text()).slice(0, count);
  }
}

// ---------------------------------------------------------------------------
// SearXNG (keyless — needs an instance base URL)
// ---------------------------------------------------------------------------

export function parseSearxng(json: unknown): SearchResult[] {
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  return results.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      title: String(o["title"] ?? ""),
      url: String(o["url"] ?? ""),
      description: String(o["content"] ?? ""),
    };
  });
}

class SearxngProvider implements SearchProvider {
  readonly id = "searxng";
  constructor(
    private readonly baseUrl: string,
    private readonly proxy?: string | null,
  ) {}

  async search(query: string, count: number, signal: AbortSignal): Promise<SearchResult[]> {
    if (!this.baseUrl) {
      throw new Error("searxng requires a base URL (set tools.web.search.baseUrl to your instance)");
    }
    const url = new URL("/search", this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const res = await fetch(
      url.toString(),
      withProxy({ signal, headers: { "User-Agent": USER_AGENT, Accept: "application/json" } }, this.proxy),
    );
    if (!res.ok) throw new Error(`searxng HTTP ${res.status} ${res.statusText}`);
    return parseSearxng(await res.json()).slice(0, count);
  }
}

// ---------------------------------------------------------------------------
// Brave (keyed)
// ---------------------------------------------------------------------------

const DEFAULT_BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";

export function parseBrave(json: unknown): SearchResult[] {
  const web = (json as { web?: { results?: unknown[] } })?.web;
  const results = web?.results;
  if (!Array.isArray(results)) return [];
  return results.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      title: String(o["title"] ?? ""),
      url: String(o["url"] ?? ""),
      description: htmlToInline(String(o["description"] ?? "")),
    };
  });
}

class BraveProvider implements SearchProvider {
  readonly id = "brave";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly proxy?: string | null,
  ) {}

  async search(query: string, count: number, signal: AbortSignal): Promise<SearchResult[]> {
    if (!this.apiKey) {
      throw new Error("brave requires an API key (set tools.web.search.apiKey)");
    }
    const url = new URL(this.baseUrl || DEFAULT_BRAVE_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));
    const res = await fetch(
      url.toString(),
      withProxy(
        {
          signal,
          headers: {
            Accept: "application/json",
            "User-Agent": USER_AGENT,
            "X-Subscription-Token": this.apiKey,
          },
        },
        this.proxy,
      ),
    );
    if (!res.ok) throw new Error(`brave HTTP ${res.status} ${res.statusText}`);
    return parseBrave(await res.json()).slice(0, count);
  }
}

// ---------------------------------------------------------------------------
// Tavily (keyed — designed for agents)
// ---------------------------------------------------------------------------

const DEFAULT_TAVILY_URL = "https://api.tavily.com/search";

export function parseTavily(json: unknown): SearchResult[] {
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  return results.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      title: String(o["title"] ?? ""),
      url: String(o["url"] ?? ""),
      description: String(o["content"] ?? ""),
    };
  });
}

class TavilyProvider implements SearchProvider {
  readonly id = "tavily";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly proxy?: string | null,
  ) {}

  async search(query: string, count: number, signal: AbortSignal): Promise<SearchResult[]> {
    if (!this.apiKey) {
      throw new Error("tavily requires an API key (set tools.web.search.apiKey)");
    }
    const res = await fetch(
      this.baseUrl || DEFAULT_TAVILY_URL,
      withProxy(
        {
          method: "POST",
          signal,
          headers: { "content-type": "application/json", "User-Agent": USER_AGENT },
          body: JSON.stringify({
            api_key: this.apiKey,
            query,
            max_results: count,
            search_depth: "basic",
          }),
        },
        this.proxy,
      ),
    );
    if (!res.ok) throw new Error(`tavily HTTP ${res.status} ${res.statusText}`);
    return parseTavily(await res.json()).slice(0, count);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Providers that work without any API key. */
export const KEYLESS_PROVIDERS = new Set(["duckduckgo", "ddg", "searxng"]);

/**
 * Build a search provider from config. Unknown names fall back to DuckDuckGo
 * (keyless) so web_search always works out of the box.
 */
export function createSearchProvider(opts: SearchProviderOpts): SearchProvider {
  const name = (opts.provider || "duckduckgo").toLowerCase();
  const proxy = opts.proxy ?? null;
  switch (name) {
    case "duckduckgo":
    case "ddg":
      return new DuckDuckGoProvider(proxy);
    case "searxng":
      return new SearxngProvider(opts.baseUrl ?? "", proxy);
    case "brave":
      return new BraveProvider(opts.apiKey ?? "", opts.baseUrl ?? "", proxy);
    case "tavily":
      return new TavilyProvider(opts.apiKey ?? "", opts.baseUrl ?? "", proxy);
    default:
      logger.warn({ provider: name }, "unknown web_search provider; falling back to duckduckgo");
      return new DuckDuckGoProvider(proxy);
  }
}
