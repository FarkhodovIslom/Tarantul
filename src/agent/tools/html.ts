/**
 * Minimal, dependency-free HTML utilities shared by the web tools:
 * entity decoding, tag stripping, and a readability-style HTML→Markdown
 * extractor used by web_fetch to scrape a page into clean, LLM-friendly text.
 */

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'",
  mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™",
  laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  deg: "°", euro: "€", pound: "£", cent: "¢", middot: "·", bull: "•",
};

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/** Decode named, decimal (`&#123;`) and hex (`&#x1F600;`) HTML entities. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*|#39);/g, (m, name: string) => NAMED_ENTITIES[name] ?? m);
}

/** Remove all HTML tags, collapsing them to nothing. */
export function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

/** Decode entities and strip tags, then collapse whitespace to single spaces. */
export function htmlToInline(s: string): string {
  return decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim();
}

export interface ReadablePage {
  title: string;
  text: string;
}

/**
 * Extract the readable content of an HTML page as lightweight Markdown:
 * keeps headings, links, and list items; drops scripts, styles, and chrome
 * (nav/header/footer/aside/forms). Prefers a `<main>`/`<article>` region when
 * present. Best-effort and regex-based — good enough to feed an LLM.
 */
export function extractReadable(html: string): ReadablePage {
  const title = htmlToInline((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")).slice(0, 300);

  // Drop non-content elements entirely (including their contents).
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|form|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");

  // Prefer the main content region if the page marks one.
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (main?.[2] && main[2].length > 200) body = main[2];

  // Headings → Markdown (#..######), in place.
  body = body.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl: string, inner: string) => {
    const text = htmlToInline(inner);
    return text ? `\n\n${"#".repeat(Number(lvl))} ${text}\n\n` : "\n";
  });

  // Anchors with http(s) hrefs → [text](url).
  body = body.replace(
    /<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, inner: string) => {
      const text = htmlToInline(inner);
      return text ? `[${text}](${href})` : "";
    },
  );

  // List items and block boundaries → newlines.
  body = body
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(br|p|div|tr|section|ul|ol|table|blockquote)\b[^>]*>/gi, "\n");

  const text = decodeEntities(stripTags(body))
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, text };
}
