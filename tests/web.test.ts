/**
 * Web tools: HTML extraction, search-provider parsers + factory, and the
 * WebSearchTool / WebFetchTool wired against a mocked global fetch.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { decodeEntities, stripTags, extractReadable } from "../src/agent/tools/html.js";
import {
  parseDuckDuckGo,
  parseSearxng,
  parseBrave,
  parseTavily,
  createSearchProvider,
} from "../src/agent/tools/search-providers.js";
import { WebSearchTool, WebFetchTool } from "../src/agent/tools/web.js";

// ---------------------------------------------------------------------------
// HTML utilities
// ---------------------------------------------------------------------------

describe("html utils", () => {
  it("decodes named, decimal, and hex entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#39;q&#39; &#x263A;")).toBe("a & b <c> 'q' ☺");
  });

  it("stripTags removes tags", () => {
    expect(stripTags("<p>hi <b>there</b></p>")).toBe("hi there");
  });

  it("extractReadable pulls title, headings, links, lists; drops chrome", () => {
    const html = `
      <html><head><title>My &amp; Page</title></head>
      <body>
        <nav>Home About Contact</nav>
        <script>window.x = 1;</script>
        <main>
          <h2>Section One</h2>
          <p>Visit <a href="https://example.com/x">the site</a> now.</p>
          <ul><li>first</li><li>second</li></ul>
        </main>
        <footer>copyright</footer>
      </body></html>`;
    const { title, text } = extractReadable(html);
    expect(title).toBe("My & Page");
    expect(text).toContain("## Section One");
    expect(text).toContain("[the site](https://example.com/x)");
    expect(text).toContain("- first");
    expect(text).toContain("- second");
    // Chrome + scripts are gone.
    expect(text).not.toContain("window.x");
    expect(text).not.toContain("copyright");
    expect(text).not.toContain("Home About Contact");
  });
});

// ---------------------------------------------------------------------------
// Search-provider parsers
// ---------------------------------------------------------------------------

describe("search parsers", () => {
  it("parseDuckDuckGo unwraps uddg redirects and pairs snippets", () => {
    const html = `
      <a class="result__a" rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fcats&rut=z">Cats Page</a>
      <a class="result__snippet">All about cats.</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fdogs">Dogs Page</a>
      <a class="result__snippet">Everything dogs.</a>`;
    const r = parseDuckDuckGo(html);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ title: "Cats Page", url: "https://example.com/cats", description: "All about cats." });
    expect(r[1]!.url).toBe("https://example.org/dogs");
  });

  it("parseSearxng maps results", () => {
    const r = parseSearxng({ results: [{ title: "T", url: "https://a.com", content: "snippet" }] });
    expect(r[0]).toEqual({ title: "T", url: "https://a.com", description: "snippet" });
  });

  it("parseBrave reads web.results and strips markup in description", () => {
    const r = parseBrave({ web: { results: [{ title: "B", url: "https://b.com", description: "<b>bold</b> desc" }] } });
    expect(r[0]).toEqual({ title: "B", url: "https://b.com", description: "bold desc" });
  });

  it("parseTavily maps content to description", () => {
    const r = parseTavily({ results: [{ title: "V", url: "https://v.com", content: "ctx" }] });
    expect(r[0]).toEqual({ title: "V", url: "https://v.com", description: "ctx" });
  });

  it("parsers return [] on malformed payloads", () => {
    expect(parseSearxng({})).toEqual([]);
    expect(parseBrave(null)).toEqual([]);
    expect(parseTavily({ results: "nope" })).toEqual([]);
  });
});

describe("createSearchProvider", () => {
  it("defaults to keyless duckduckgo and falls back on unknown", () => {
    expect(createSearchProvider({}).id).toBe("duckduckgo");
    expect(createSearchProvider({ provider: "totally-unknown" }).id).toBe("duckduckgo");
  });
  it("selects keyed and instance providers by name", () => {
    expect(createSearchProvider({ provider: "brave", apiKey: "k" }).id).toBe("brave");
    expect(createSearchProvider({ provider: "tavily", apiKey: "k" }).id).toBe("tavily");
    expect(createSearchProvider({ provider: "searxng", baseUrl: "https://s.example" }).id).toBe("searxng");
  });
});

// ---------------------------------------------------------------------------
// Tools with a mocked global fetch
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function mockFetch(body: string, contentType: string): void {
  globalThis.fetch = (async () =>
    new Response(body, { status: 200, headers: { "content-type": contentType } })) as unknown as typeof fetch;
}

describe("WebSearchTool (keyless DuckDuckGo)", () => {
  it("returns formatted results via the default provider", async () => {
    mockFetch(
      `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Alpha</a>
       <a class="result__snippet">alpha snippet</a>`,
      "text/html",
    );
    const tool = new WebSearchTool({});
    const out = (await tool.execute({ query: "alpha" })) as string;
    expect(out).toContain("1. Alpha");
    expect(out).toContain("https://example.com/a");
    expect(out).toContain("alpha snippet");
  });

  it("surfaces a config hint when a keyed provider has no key", async () => {
    const tool = new WebSearchTool({ provider: "brave" });
    const out = (await tool.execute({ query: "x" })) as string;
    expect(out).toContain("requires an API key");
  });
});

describe("WebFetchTool (scrape to markdown)", () => {
  it("scrapes HTML into markdown with a title heading", async () => {
    mockFetch("<html><head><title>Doc</title></head><body><h1>Hello</h1><p>World</p></body></html>", "text/html");
    const out = (await new WebFetchTool().execute({ url: "https://example.com" })) as string;
    expect(out).toContain("# Doc");
    expect(out).toContain("# Hello");
    expect(out).toContain("World");
  });

  it("rejects non-http schemes", async () => {
    const out = (await new WebFetchTool().execute({ url: "file:///etc/passwd" })) as string;
    expect(out).toContain("unsupported URL scheme");
  });
});
