/**
 * MCP (Model Context Protocol) client support.
 *
 * Connects to each server configured under tools.mcpServers (schema already
 * existed in config/schema.ts — stdio/sse/streamableHttp — but nothing read
 * it until now), lists that server's tools, and wraps each one as a Tool
 * subclass so it goes through the same ToolRegistry param validation,
 * concurrency batching, and result-size budgeting as every built-in tool.
 *
 * A server that fails to connect or list tools is skipped with a warning —
 * never fatal to startup, matching how channel init failures are handled in
 * channels/manager.ts.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Tool } from "./base.js";
import { logger } from "../../utils/logger.js";
import type { MCPServerConfig } from "../../config/schema.js";

const CLIENT_VERSION = "0.1.0";
/** Floor for the connect handshake timeout — some stdio servers (e.g. npx-installed) are slow to cold-start. */
const MIN_CONNECT_TIMEOUT_SEC = 15;

// ---------------------------------------------------------------------------
// McpToolAdapter — wraps one remote MCP tool as a local Tool
// ---------------------------------------------------------------------------

export class McpToolAdapter extends Tool {
  override readonly name: string;
  override readonly description: string;
  override readonly parameters: Record<string, unknown>;
  private readonly _readOnly: boolean;
  override get readOnly(): boolean { return this._readOnly; }

  constructor(
    private readonly client: Client,
    localName: string,
    private readonly remoteName: string,
    description: string,
    inputSchema: Record<string, unknown>,
    private readonly toolTimeoutMs: number,
    readOnlyHint: boolean,
  ) {
    super();
    this.name = localName;
    this.description = description || `MCP tool '${remoteName}'`;
    this.parameters = inputSchema;
    this._readOnly = readOnlyHint;
  }

  async execute(params: Record<string, unknown>): Promise<unknown> {
    try {
      const result = await this.client.callTool(
        { name: this.remoteName, arguments: params },
        undefined,
        { timeout: this.toolTimeoutMs },
      );
      return mcpResultToToolOutput(result as McpCallToolResult);
    } catch (err) {
      return `Error calling MCP tool '${this.remoteName}': ${err}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Result mapping — MCP content blocks -> this codebase's tool-result shape
// ---------------------------------------------------------------------------

interface McpCallToolResult {
  content?: unknown[];
  isError?: boolean;
}

function mcpResultToToolOutput(result: McpCallToolResult): unknown {
  const blocks = Array.isArray(result.content) ? result.content : [];
  if (blocks.length === 0) {
    return result.isError ? "Error: MCP tool returned no content" : "(no output)";
  }

  const textParts: string[] = [];
  const imageBlocks: unknown[] = [];

  for (const block of blocks) {
    const b = block as Record<string, unknown>;
    switch (b["type"]) {
      case "text":
        textParts.push(String(b["text"] ?? ""));
        break;
      case "image": {
        const mime = String(b["mimeType"] ?? "image/png");
        imageBlocks.push({ type: "image_url", image_url: { url: `data:${mime};base64,${String(b["data"] ?? "")}` } });
        break;
      }
      case "audio":
        // No native audio content-block convention in this codebase's
        // provider message converters (only text/image_url) — describe it.
        textParts.push(`[audio content, mimeType: ${String(b["mimeType"] ?? "unknown")}]`);
        break;
      case "resource": {
        const res = b["resource"] as Record<string, unknown> | undefined;
        if (res && typeof res["text"] === "string") {
          textParts.push(res["text"] as string);
        } else if (res) {
          textParts.push(`[resource: ${String(res["uri"] ?? "unknown")}]`);
        }
        break;
      }
      case "resource_link":
        textParts.push(`[resource link: ${String(b["name"] ?? b["uri"] ?? "unknown")}]`);
        break;
      default:
        textParts.push(JSON.stringify(block));
    }
  }

  const text = textParts.join("\n").trim();
  const prefixed = result.isError && text && !text.startsWith("Error") ? `Error: ${text}` : text;

  if (imageBlocks.length === 0) {
    return prefixed || (result.isError ? "Error: MCP tool call failed" : "(no output)");
  }

  // Mixed text + image content: return as a content-block array (the same
  // shape ReadFileTool/context.ts already use for images).
  const out: unknown[] = [];
  if (prefixed) out.push({ type: "text", text: prefixed });
  out.push(...imageBlocks);
  return out;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export interface McpServerConnection {
  name: string;
  client: Client;
  tools: McpToolAdapter[];
  close(): Promise<void>;
}

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

function matchesEnabled(toolName: string, enabledTools: readonly string[]): boolean {
  if (enabledTools.length === 0 || enabledTools.includes("*")) return true;
  return enabledTools.includes(toolName);
}

function buildTransport(name: string, config: MCPServerConfig): Transport {
  const type = config.type ?? (config.command ? "stdio" : "streamableHttp");

  if (type === "stdio") {
    if (!config.command) throw new Error(`type is 'stdio' but no command configured`);
    const hasExtraEnv = Object.keys(config.env).length > 0;
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      // Only override the SDK's own curated-safe default env when the user
      // configured extras — otherwise let it fall back to
      // getDefaultEnvironment() internally rather than the full process.env,
      // consistent with not handing spawned processes secrets they don't need.
      ...(hasExtraEnv ? { env: { ...getDefaultEnvironment(), ...config.env } } : {}),
    });
  }

  if (!config.url) throw new Error(`type is '${type}' but no url configured`);
  const url = new URL(config.url);
  const requestInit: RequestInit = Object.keys(config.headers).length > 0 ? { headers: config.headers } : {};

  // The SDK's own transport classes have a structural mismatch against its
  // own `Transport` interface under this project's `exactOptionalPropertyTypes`
  // (e.g. `sessionId?: string` vs the interface's `string | undefined`) — a
  // pre-existing SDK typing quirk under a stricter-than-usual flag, not a
  // real incompatibility; both concrete classes are the SDK's canonical
  // `Transport` implementations.
  if (type === "sse") {
    return new SSEClientTransport(url, { requestInit }) as Transport;
  }
  return new StreamableHTTPClientTransport(url, { requestInit }) as Transport;
}

/** Connect to one configured MCP server and wrap its tools. Returns null (with a warning logged) on any failure. */
export async function connectMcpServer(
  name: string,
  config: MCPServerConfig,
): Promise<McpServerConnection | null> {
  let transport: Transport;
  try {
    transport = buildTransport(name, config);
  } catch (err) {
    logger.warn({ mcpServer: name, err }, "MCP server misconfigured, skipping");
    return null;
  }

  const client = new Client({ name: "tarantul", version: CLIENT_VERSION }, { capabilities: {} });
  const connectTimeoutMs = Math.max(config.toolTimeout, MIN_CONNECT_TIMEOUT_SEC) * 1000;

  try {
    await client.connect(transport, { timeout: connectTimeoutMs });
  } catch (err) {
    logger.warn({ mcpServer: name, err }, "MCP server connection failed, skipping");
    return null;
  }

  let listed: {
    tools: Array<{
      name: string;
      description?: string | undefined;
      inputSchema: Record<string, unknown>;
      annotations?: { readOnlyHint?: boolean | undefined } | undefined;
    }>;
  };
  try {
    listed = await client.listTools();
  } catch (err) {
    logger.warn({ mcpServer: name, err }, "MCP server listTools failed, skipping");
    try { await client.close(); } catch { /* already broken, nothing to clean up */ }
    return null;
  }

  const toolTimeoutMs = config.toolTimeout * 1000;
  const tools: McpToolAdapter[] = [];
  for (const remote of listed.tools) {
    if (!matchesEnabled(remote.name, config.enabledTools)) continue;
    const localName = `mcp_${sanitizeName(name)}_${sanitizeName(remote.name)}`;
    tools.push(
      new McpToolAdapter(
        client,
        localName,
        remote.name,
        remote.description ?? "",
        remote.inputSchema,
        toolTimeoutMs,
        Boolean(remote.annotations?.readOnlyHint),
      ),
    );
  }

  logger.info({ mcpServer: name, tools: tools.map((t) => t.name) }, "MCP server connected");

  return {
    name,
    client,
    tools,
    close: async () => {
      try {
        await client.close();
      } catch (err) {
        logger.warn({ mcpServer: name, err }, "MCP server close failed");
      }
    },
  };
}

/**
 * Connect to every configured MCP server (in parallel, best-effort — see
 * connectMcpServer) and register all their tools into the given registry.
 * Returns the live connections so the caller can close them on shutdown.
 */
export async function connectAllMcpServers(
  servers: Record<string, MCPServerConfig>,
  registry: { register(tool: Tool): void },
): Promise<McpServerConnection[]> {
  const entries = Object.entries(servers);
  if (entries.length === 0) return [];

  const results = await Promise.all(entries.map(([name, config]) => connectMcpServer(name, config)));

  const connections: McpServerConnection[] = [];
  for (const conn of results) {
    if (!conn) continue;
    for (const tool of conn.tools) registry.register(tool);
    connections.push(conn);
  }
  return connections;
}

export async function closeAllMcpServers(connections: readonly McpServerConnection[]): Promise<void> {
  await Promise.all(connections.map((c) => c.close()));
}
