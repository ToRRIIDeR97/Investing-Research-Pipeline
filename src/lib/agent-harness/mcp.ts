import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ProviderError, redactHarnessText } from "./errors";
import { isPrivateOrLocalHost } from "./network";
import type { McpServerConfig } from "./types";
import type { ToolRegistry } from "./tools";

const MAX_MCP_TOOLS = 256;
const MAX_MCP_TOOL_DEFINITION_BYTES = 16 * 1024;
const MAX_MCP_RESULT_BYTES = 1024 * 1024;

function boundedJson(value: unknown, limit: number, label: string) {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch {
    throw new ProviderError(`${label} is not JSON serializable`, "malformed_stream");
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > limit) {
    throw new ProviderError(`${label} exceeds the transport limit`, "response_limit");
  }
  return value;
}

function validateConfig(config: McpServerConfig) {
  let url: URL;
  try { url = new URL(config.url); } catch {
    throw new ProviderError(`Invalid MCP URL for ${config.name}`, "invalid_request");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new ProviderError(`MCP server ${config.name} must use credential-free HTTPS URL`, "invalid_request");
  }
  const allowed = config.allowedHosts.map((host) => host.toLowerCase());
  if (!allowed.includes(url.hostname.toLowerCase()) || isPrivateOrLocalHost(url.hostname)) {
    throw new ProviderError(`MCP server host is not allowlisted: ${url.hostname}`, "invalid_request");
  }
  return url;
}

function safeName(value: string) {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
}

function headersFromEnvironment(config: McpServerConfig) {
  const headers: Record<string, string> = {};
  for (const [header, environmentName] of Object.entries(config.headerEnv || {})) {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(header) || !/^[A-Z][A-Z0-9_]{0,127}$/.test(environmentName)) {
      throw new ProviderError(`Invalid MCP header environment mapping for ${config.name}`, "invalid_request");
    }
    const value = process.env[environmentName];
    if (!value) throw new ProviderError(`Missing MCP header environment variable ${environmentName}`, "invalid_request");
    headers[header] = value;
  }
  return headers;
}

function secureFetch(base: URL): typeof fetch {
  return async (input, init) => {
    const target = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    if (target.origin !== base.origin) {
      throw new ProviderError(`MCP transport attempted an unapproved URL: ${target.hostname}`, "permission_denied");
    }
    return fetch(target, { ...init, redirect: "error" });
  };
}

export class RemoteMcpClient {
  private client?: Client;
  private transport?: Transport;
  private readonly url: URL;
  private readonly timeoutMs: number;

  constructor(readonly config: McpServerConfig) {
    this.url = validateConfig(config);
    this.timeoutMs = config.timeoutMs || 30_000;
  }

  private async connectTransport(transport: Transport, signal: AbortSignal) {
    const client = new Client({ name: "research-os", version: "1.0.0" }, { capabilities: {} });
    this.client = client;
    this.transport = transport;
    try {
      await client.connect(transport, { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs });
    } catch (error) {
      await transport.close().catch(() => undefined);
      if (this.transport === transport) {
        this.client = undefined;
        this.transport = undefined;
      }
      throw error;
    }
  }

  async connect(signal: AbortSignal) {
    const fetchImpl = secureFetch(this.url);
    const headers = headersFromEnvironment(this.config);
    try {
      await this.connectTransport(new StreamableHTTPClientTransport(this.url, {
        fetch: fetchImpl,
        requestInit: { redirect: "error", headers },
        reconnectionOptions: {
          maxReconnectionDelay: 5_000,
          initialReconnectionDelay: 500,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 1,
        },
      }), signal);
    } catch (streamableError) {
      await this.close().catch(() => undefined);
      try {
        await this.connectTransport(new SSEClientTransport(this.url, {
          fetch: fetchImpl,
          requestInit: { redirect: "error", headers },
          eventSourceInit: { fetch: fetchImpl } as any,
        }), signal);
      } catch (sseError) {
        await this.close().catch(() => undefined);
        throw new ProviderError(
          `Unable to connect MCP server ${this.config.name}: ${sseError instanceof Error ? sseError.message : String(sseError)}; streamable HTTP also failed: ${streamableError instanceof Error ? streamableError.message : String(streamableError)}`,
          "connection"
        );
      }
    }
  }

  async listTools(signal: AbortSignal) {
    if (!this.client) throw new ProviderError(`MCP server is not connected: ${this.config.name}`, "invalid_request");
    const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.client.listTools(cursor ? { cursor } : undefined, {
        signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs,
      });
      if (tools.length + result.tools.length > MAX_MCP_TOOLS) {
        throw new ProviderError(`MCP server returned too many tools: ${this.config.name}`, "response_limit");
      }
      for (const tool of result.tools) {
        boundedJson(tool, MAX_MCP_TOOL_DEFINITION_BYTES, `MCP tool definition ${this.config.name}/${tool.name}`);
      }
      tools.push(...result.tools);
      if (!result.nextCursor) return tools;
      if (cursors.has(result.nextCursor)) throw new ProviderError(`MCP server repeated a tools cursor: ${this.config.name}`, "malformed_stream");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new ProviderError(`MCP server returned too many tool pages: ${this.config.name}`, "response_limit");
  }

  async callTool(name: string, input: Record<string, unknown>, signal: AbortSignal) {
    if (!this.client) throw new ProviderError(`MCP server is not connected: ${this.config.name}`, "invalid_request");
    const result = await this.client.callTool({ name, arguments: input }, undefined, {
      signal,
      timeout: this.timeoutMs,
      maxTotalTimeout: this.timeoutMs,
      resetTimeoutOnProgress: true,
    });
    if ("isError" in result && result.isError) {
      throw new ProviderError(`MCP tool ${this.config.name}/${name} returned an error`, "server_error", { result });
    }
    const output = "structuredContent" in result && result.structuredContent
      ? result.structuredContent
      : "content" in result
        ? result.content
        : "toolResult" in result
          ? result.toolResult
          : result;
    return boundedJson(output, MAX_MCP_RESULT_BYTES, `MCP tool result ${this.config.name}/${name}`);
  }

  async close() {
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    if (!transport) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        transport.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ProviderError(`Timed out closing MCP server ${this.config.name}`, "provider_timeout")), Math.min(this.timeoutMs, 5_000));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export async function registerMcpServers(
  configs: McpServerConfig[],
  registry: ToolRegistry,
  signal: AbortSignal
): Promise<{ enabledTools: string[]; errors: Array<{ server: string; message: string }>; close(): Promise<void> }> {
  const clients: RemoteMcpClient[] = [];
  const unregister: Array<() => void> = [];
  const enabledTools: string[] = [];
  const errors: Array<{ server: string; message: string }> = [];
  const exposedNames = new Set<string>();

  for (const config of configs) {
    let client: RemoteMcpClient | undefined;
    const serverUnregister: Array<() => void> = [];
    const serverNames: string[] = [];
    try {
      client = new RemoteMcpClient(config);
      const activeClient = client;
      await activeClient.connect(signal);
      const allowed = config.enabledTools ? new Set(config.enabledTools) : null;
      for (const tool of await activeClient.listTools(signal)) {
        if (allowed && !allowed.has(tool.name)) continue;
        const exposedName = `mcp__${safeName(config.name)}__${safeName(tool.name)}`;
        if (exposedNames.has(exposedName) || serverNames.includes(exposedName)) {
          throw new ProviderError(`MCP tool name collision: ${exposedName}`, "invalid_request");
        }
        serverUnregister.push(registry.register({
          name: exposedName,
          description: tool.description || `MCP tool ${config.name}/${tool.name}`,
          inputSchema: { ...tool.inputSchema, type: "object" },
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          permission: { action: `mcp:${config.name}/${tool.name}`, resource: config.url },
          execute: async (input: Record<string, unknown>, context) => activeClient.callTool(tool.name, input, context.signal),
        }));
        serverNames.push(exposedName);
      }
      clients.push(activeClient);
      unregister.push(...serverUnregister);
      enabledTools.push(...serverNames);
      for (const name of serverNames) exposedNames.add(name);
    } catch (error) {
      for (const remove of serverUnregister.reverse()) remove();
      await client?.close().catch(() => undefined);
      if (signal.aborted || (error instanceof ProviderError && error.category === "cancellation")) {
        throw new ProviderError("MCP registration cancelled", "cancellation");
      }
      errors.push({ server: config.name, message: redactHarnessText(error instanceof Error ? error.message : String(error), 2_000) });
    }
  }

  return {
    enabledTools,
    errors,
    close: async () => {
      for (const remove of unregister.reverse()) remove();
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
}
