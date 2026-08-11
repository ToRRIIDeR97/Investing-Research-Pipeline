import { randomUUID } from "node:crypto";
import { ProviderError } from "./errors";
import type { AgentContentPart, AgentMessage, AgentMessageRole } from "./types";

const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function createMessage(role: AgentMessageRole, parts: AgentContentPart[], id: string = randomUUID()): AgentMessage {
  return { id, role, parts, createdAt: new Date().toISOString() };
}

export function textMessage(role: AgentMessageRole, text: string, id?: string): AgentMessage {
  return createMessage(role, [{ type: "text", text }], id);
}

export function messageText(message: AgentMessage): string {
  return message.parts
    .filter((part): part is Extract<AgentContentPart, { type: "text" | "reasoning" }> =>
      part.type === "text" || part.type === "reasoning")
    .map((part) => part.text)
    .join("\n");
}

export function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("undefined");
    return serialized;
  } catch {
    throw new ProviderError("Tool output is not JSON serializable", "invalid_request");
  }
}

function dataUrl(part: Extract<AgentContentPart, { type: "image" }>): string {
  if (!part.url && (!part.mediaType || !part.data)) {
    throw new ProviderError("Image messages require bounded JPEG, PNG, GIF, or WebP data", "invalid_request");
  }
  const value = part.url || `data:${part.mediaType};base64,${part.data}`;
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match || !IMAGE_MEDIA_TYPES.has(match[1]) || !match[2]) {
    throw new ProviderError("Remote or unsupported image URLs are not allowed in model messages", "invalid_request");
  }
  if (match[2].length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4) {
    throw new ProviderError("Image message exceeds 10 MB", "response_limit");
  }
  const decoded = Buffer.from(match[2], "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")) {
    throw new ProviderError("Image message contains invalid base64 data", "invalid_request");
  }
  if (decoded.length > MAX_IMAGE_BYTES) throw new ProviderError("Image message exceeds 10 MB", "response_limit");
  return `data:${match[1]};base64,${match[2]}`;
}

function textParts(parts: AgentContentPart[]) {
  return parts.filter((part): part is Extract<AgentContentPart, { type: "text" }> => part.type === "text");
}

export function toOpenAIChatMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "tool") {
      const result = message.parts.find(
        (part): part is Extract<AgentContentPart, { type: "tool_result" }> => part.type === "tool_result"
      );
      if (!result) throw new ProviderError("Tool message is missing a tool result", "invalid_request");
      return { role: "tool", tool_call_id: result.toolCallId, content: safeJson(result.output) };
    }

    const text = textParts(message.parts).map((part) => part.text).join("\n");
    const images = message.parts.filter(
      (part): part is Extract<AgentContentPart, { type: "image" }> => part.type === "image"
    );
    const calls = message.parts.filter(
      (part): part is Extract<AgentContentPart, { type: "tool_call" }> => part.type === "tool_call"
    );
    const content = images.length
      ? [
          ...(text ? [{ type: "text", text }] : []),
          ...images.map((image) => ({
            type: "image_url",
            image_url: { url: dataUrl(image), detail: image.detail || "auto" },
          })),
        ]
      : text || (calls.length ? null : "");

    if (message.role === "assistant" && calls.length) {
      return {
        role: "assistant",
        content,
        tool_calls: calls.map(({ call }) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments || "{}" },
        })),
      };
    }
    return { role: message.role, content };
  });
}

function anthropicImage(part: Extract<AgentContentPart, { type: "image" }>) {
  const url = dataUrl(part);
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
  if (!match || !IMAGE_MEDIA_TYPES.has(match[1])) {
    throw new ProviderError("Anthropic messages require base64 image data", "invalid_request");
  }
  return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
}

export function toAnthropicMessages(messages: AgentMessage[]): {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }>;
} {
  const system = messages.filter((message) => message.role === "system").map(messageText).filter(Boolean).join("\n\n");
  const lowered: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }> = [];

  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const content: Array<Record<string, unknown>> = [];
    for (const part of message.parts) {
      if (part.type === "text") content.push({ type: "text", text: part.text });
      if (part.type === "image") content.push(anthropicImage(part));
      if (part.type === "tool_call") {
        let input: unknown;
        try { input = JSON.parse(part.call.arguments || "{}"); } catch {
          throw new ProviderError(`Invalid JSON arguments for tool ${part.call.name}`, "invalid_request");
        }
        content.push({ type: "tool_use", id: part.call.id, name: part.call.name, input });
      }
      if (part.type === "tool_result") {
        content.push({
          type: "tool_result",
          tool_use_id: part.toolCallId,
          content: safeJson(part.output),
          ...(part.isError ? { is_error: true } : {}),
        });
      }
    }
    if (!content.length) content.push({ type: "text", text: "" });
    const previous = lowered.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else lowered.push({ role, content });
  }
  if (!lowered.length) throw new ProviderError("Anthropic messages require at least one user or assistant message", "invalid_request");
  return { ...(system ? { system } : {}), messages: lowered };
}

function truncateMiddle(value: string, limit: number) {
  if (value.length <= limit) return value;
  const half = Math.max(1, Math.floor((limit - 40) / 2));
  return `${value.slice(0, half)}\n...[context compacted]...\n${value.slice(-half)}`;
}

export function messageBytes(messages: AgentMessage[]) {
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

function toolIds(message: AgentMessage) {
  return new Set(message.parts.flatMap((part) => {
    if (part.type === "tool_call") return [part.call.id];
    if (part.type === "tool_result") return [part.toolCallId];
    return [];
  }));
}

function closeToolPairs(messages: AgentMessage[], keepIds: Set<string>) {
  const calls = new Set<string>();
  for (const message of messages) {
    if (keepIds.has(message.id)) for (const id of toolIds(message)) calls.add(id);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const message of messages) {
      const ids = toolIds(message);
      if (![...ids].some((id) => calls.has(id))) continue;
      if (!keepIds.has(message.id)) {
        keepIds.add(message.id);
        changed = true;
      }
      for (const id of ids) {
        if (!calls.has(id)) {
          calls.add(id);
          changed = true;
        }
      }
    }
  }
}

function removeMessageGroup(messages: AgentMessage[], index: number) {
  const calls = toolIds(messages[index]);
  if (!calls.size) return messages.filter((_, candidate) => candidate !== index);
  let changed = true;
  while (changed) {
    changed = false;
    for (const message of messages) {
      const ids = toolIds(message);
      if (![...ids].some((id) => calls.has(id))) continue;
      for (const id of ids) {
        if (!calls.has(id)) {
          calls.add(id);
          changed = true;
        }
      }
    }
  }
  return messages.filter((message) => ![...toolIds(message)].some((id) => calls.has(id)));
}

/** Deterministic, evidence-preserving compaction for provider-visible history. */
export function compactMessages(messages: AgentMessage[], maxBytes: number): {
  messages: AgentMessage[];
  compacted: boolean;
} {
  if (messageBytes(messages) <= maxBytes) return { messages, compacted: false };

  const keepIds = new Set([
    ...messages.filter((message) => message.role === "system").map((message) => message.id),
    ...messages.slice(-6).map((message) => message.id),
  ]);
  closeToolPairs(messages, keepIds);
  const omitted = messages.filter((message) => !keepIds.has(message.id));
  let kept: AgentMessage[] = messages.filter((message) => keepIds.has(message.id)).map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type === "tool_result") {
        const output = safeJson(part.output);
        return { ...part, output: truncateMiddle(output, 2_000) } satisfies AgentContentPart;
      }
      if (part.type === "text") return { ...part, text: truncateMiddle(part.text, Math.max(4_000, Math.floor(maxBytes / 3))) } satisfies AgentContentPart;
      return part;
    }),
  }));
  if (omitted.length) {
    const summary = omitted.map((message) => `${message.role}: ${truncateMiddle(messageText(message), 500)}`).join("\n");
    const insertAt = kept.findIndex((message) => message.role !== "system");
    kept.splice(insertAt < 0 ? kept.length : insertAt, 0, textMessage("user", `Earlier session history (compacted data):\n${summary}`));
  }

  while (messageBytes(kept) > maxBytes && kept.length > 2) {
    const index = kept.findIndex((message) => message.role !== "system");
    if (index < 0) break;
    const next = removeMessageGroup(kept, index);
    if (next.length === kept.length) break;
    kept = next;
  }
  if (messageBytes(kept) > maxBytes) {
    throw new ProviderError("Model context exceeds maximum size after compaction", "context_limit");
  }
  return { messages: kept, compacted: true };
}
