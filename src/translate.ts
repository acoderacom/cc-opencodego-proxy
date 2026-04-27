/**
 * Anthropic ↔ OpenAI format translation.
 *
 *   - `anthropicToOpenAIRequest`: inbound /v1/messages body → outbound
 *     /v1/chat/completions body.
 *   - `openAIStreamToAnthropicSSE`: outbound stream (OpenAI SSE deltas)
 *     → inbound SSE (Anthropic content_block_* frames).
 *
 * Scope: text, thinking (via reasoning_content or <think>...</think>),
 * tool_calls. We do not support images or computer-use in this port
 * (the Python version does images via base64 — add later if needed).
 */

import { randomUUIDv7 } from "bun";
import { errorFrame, sseFrame } from "./sse.ts";
import type {
  AnthropicMessage,
  AnthropicMessagesRequest,
  OpenAIChatCompletionsRequest,
  OpenAIMessage,
} from "./types.ts";

// ========== request: Anthropic -> OpenAI ==========

export function anthropicToOpenAIRequest(
  req: AnthropicMessagesRequest,
  opts: { includeReasoningContent: boolean; defaultMaxTokens?: number },
): OpenAIChatCompletionsRequest {
  const messages: OpenAIMessage[] = [];

  if (req.system) {
    const system =
      typeof req.system === "string"
        ? req.system
        : req.system.map((b) => b.text).join("\n\n");
    if (system) messages.push({ role: "system", content: system });
  }

  for (const msg of req.messages) {
    pushConverted(messages, msg, opts.includeReasoningContent);
  }

  const body: OpenAIChatCompletionsRequest = {
    model: req.model,
    messages,
    stream: true,
    // Ensures providers like OpenRouter report token usage, which feeds
    // Claude Code's cost/quota display.
    stream_options: { include_usage: true },
  };
  if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
  else if (opts.defaultMaxTokens) body.max_tokens = opts.defaultMaxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.stop_sequences?.length) body.stop = req.stop_sequences;
  if (req.tool_choice) body.tool_choice = req.tool_choice;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }
  return body;
}

function pushConverted(
  out: OpenAIMessage[],
  msg: AnthropicMessage,
  includeReasoningContent: boolean,
): void {
  if (typeof msg.content === "string") {
    out.push({ role: msg.role, content: msg.content });
    return;
  }

  // Split the mixed content into role-appropriate OpenAI messages.
  const texts: string[] = [];
  const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];
  const reasoningParts: string[] = [];

  for (const block of msg.content) {
    switch (block.type) {
      case "text":
        texts.push(block.text);
        break;
      case "thinking":
        if (includeReasoningContent) reasoningParts.push(block.thinking);
        break;
      case "tool_use":
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
        break;
      case "tool_result": {
        const content =
          typeof block.content === "string"
            ? block.content
            : block.content.map((b) => b.text).join("\n\n");
        out.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content,
        });
        continue;
      }
      case "image":
        // Intentionally unsupported in this port.
        break;
    }
  }

  const hasReasoning = includeReasoningContent && reasoningParts.length > 0;
  if (msg.role === "assistant" && (texts.length || toolCalls.length || hasReasoning)) {
    const assistantMsg: OpenAIMessage = {
      role: "assistant",
      // Preserve the role turn even when the assistant only produced a
      // thinking block — dropping it would break role alternation on replay.
      content: texts.join("") || (toolCalls.length ? null : " "),
    };
    if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
    if (hasReasoning) {
      assistantMsg.reasoning_content = reasoningParts.join("");
    }
    out.push(assistantMsg);
  } else if (msg.role === "user" && texts.length) {
    out.push({ role: "user", content: texts.join("") });
  }
}

// ========== token estimation ==========

// Bias-high flat cost per image. Anthropic's real formula is roughly
// (width * height) / 750 tokens — a 1080p screenshot is ~1500. We don't have
// dimensions here, so we charge the high end of the typical screenshot range
// (matches the bias-high goal for early auto-compaction).
const IMAGE_TOKEN_ESTIMATE = 1600;

/**
 * Bias-high estimate of input tokens for the full request. Feeds
 * `message_start.usage.input_tokens` and `/v1/messages/count_tokens`, so
 * Claude Code's auto-compaction fires before the upstream window overflows
 * even when the upstream doesn't report prompt-side usage in the stream.
 */

export function estimateInputTokens(req: AnthropicMessagesRequest): number {
  // Bias-high estimate: prose at ~3.3 chars/token, JSON/tool payloads at ~2.7.
  // Tuned to overestimate on every content type (prose, code, JSON) so Claude
  // Code's auto-compaction always fires before the upstream window overflows.
  let proseChars = 0;
  let jsonChars = 0;
  let imageTokens = 0;

  if (req.system) {
    if (typeof req.system === "string") {
      proseChars += req.system.length;
    } else {
      // Some passthrough betas attach non-text shapes (cache_control markers,
      // etc.). Defensive `?? ""` keeps NaN out of the math.
      for (const block of req.system) proseChars += (block.text ?? "").length;
    }
  }

  for (const msg of req.messages) {
    if (typeof msg.content === "string") {
      proseChars += msg.content.length;
    } else {
      for (const block of msg.content) {
        switch (block.type) {
          case "text":
            proseChars += block.text.length;
            break;
          case "thinking":
            proseChars += block.thinking.length;
            break;
          case "tool_use":
            jsonChars += JSON.stringify(block.input).length;
            break;
          case "tool_result":
            // Tool output is overwhelmingly code/JSON, not prose — count it
            // at the denser ratio so screenshots-of-files don't underestimate.
            if (typeof block.content === "string") {
              jsonChars += block.content.length;
            } else {
              for (const b of block.content) jsonChars += (b.text ?? "").length;
            }
            break;
          case "image":
            imageTokens += IMAGE_TOKEN_ESTIMATE;
            break;
        }
      }
    }
  }

  if (req.tools?.length) {
    for (const t of req.tools) {
      proseChars += (t.name ?? "").length + (t.description ?? "").length;
      jsonChars += JSON.stringify(t.input_schema ?? {}).length;
    }
  }

  return Math.max(1, Math.ceil(proseChars / 3.3 + jsonChars / 2.7) + imageTokens);
}

// ========== stream: OpenAI SSE -> Anthropic SSE ==========

interface ToolBlock {
  id: string | null;
  name: string | null;
  emitted: boolean;
  pendingArgs: string;
  /** Once emitted, the block index this tool owns — preserved across other tool starts. */
  blockIndex: number;
}

// Hard cap on buffered tool-call arguments awaiting a `start` emit. Defends
// against pathological upstreams that stream `arguments` indefinitely without
// ever sending an `id`/`name` pair.
const MAX_PENDING_TOOL_ARGS = 64 * 1024;

interface StreamState {
  messageId: string;
  model: string;
  started: boolean;
  blockIndex: number;
  activeBlockType: "text" | "thinking" | "tool_use" | null;
  tools: Map<number, ToolBlock>;
  inputTokens: number;
  outputTokens: number;
  inThinkTag: boolean;
  /** Unflushed tail that could still be the start of <think>/</think>. */
  thinkTagSuffix: string;
}

function newState(model: string): StreamState {
  return {
    messageId: `msg_${randomUUIDv7()}`,
    model,
    started: false,
    blockIndex: -1,
    activeBlockType: null,
    tools: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    inThinkTag: false,
    thinkTagSuffix: "",
  };
}

/**
 * Re-frame an OpenAI chat-completions SSE stream as an Anthropic messages
 * SSE stream. Drives everything from the line-by-line parser.
 */
export async function* openAIStreamToAnthropicSSE(opts: {
  openAIBody: ReadableStream<Uint8Array>;
  model: string;
  thinkingEnabled: boolean;
  estimatedInputTokens?: number;
  // Output of parseSSE would also work; we take raw body for single-pass efficiency.
  parseLines: (
    body: ReadableStream<Uint8Array>,
  ) => AsyncGenerator<{ event: string; data: string }, void>;
}): AsyncGenerator<string, void> {
  const state = newState(opts.model);
  state.inputTokens = opts.estimatedInputTokens ?? 0;
  yield startFrame(state, opts.estimatedInputTokens ?? 0);

  try {
    for await (const { data } of opts.parseLines(opts.openAIBody)) {
      if (data === "[DONE]") continue;
      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }

      const choice = chunk.choices?.[0];
      if (!choice) {
        if (chunk.usage) {
          state.inputTokens = chunk.usage.prompt_tokens ?? state.inputTokens;
          state.outputTokens = chunk.usage.completion_tokens ?? state.outputTokens;
        }
        continue;
      }

      const delta = choice.delta;
      if (!delta) {
        if (choice.finish_reason) {
          yield* flushPending(state, opts.thinkingEnabled);
          yield* closeActive(state);
        }
        continue;
      }

      // reasoning_content -> thinking blocks
      if (opts.thinkingEnabled && delta.reasoning_content) {
        yield* ensureBlock(state, "thinking");
        yield sseFrame("content_block_delta", {
          type: "content_block_delta",
          index: state.blockIndex,
          delta: { type: "thinking_delta", thinking: delta.reasoning_content },
        });
      }

      // text content (with <think> inline tag detection)
      if (typeof delta.content === "string" && delta.content.length > 0) {
        yield* handleText(state, delta.content, opts.thinkingEnabled);
      }

      // native tool_calls deltas
      if (delta.tool_calls?.length) {
        for (const tc of delta.tool_calls) {
          yield* handleToolCallDelta(state, tc);
        }
      }

      if (choice.finish_reason) {
        yield* flushPending(state, opts.thinkingEnabled);
        yield* closeActive(state);
      }
    }
  } catch (e) {
    yield errorFrame(
      `OpenAI stream translation error: ${(e as Error).message ?? String(e)}`,
    );
    return;
  }

  yield* flushPending(state, opts.thinkingEnabled);
  yield* closeActive(state);
  yield sseFrame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { input_tokens: state.inputTokens, output_tokens: state.outputTokens },
  });
  yield sseFrame("message_stop", { type: "message_stop" });
}

function startFrame(state: StreamState, estimatedInputTokens = 0): string {
  return sseFrame("message_start", {
    type: "message_start",
    message: {
      id: state.messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: state.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: estimatedInputTokens, output_tokens: 0 },
    },
  });
}

function* ensureBlock(state: StreamState, kind: "text" | "thinking"): Generator<string> {
  if (state.activeBlockType === kind) return;
  yield* closeActive(state);
  state.blockIndex += 1;
  state.activeBlockType = kind;
  if (kind === "text") {
    yield sseFrame("content_block_start", {
      type: "content_block_start",
      index: state.blockIndex,
      content_block: { type: "text", text: "" },
    });
  } else {
    yield sseFrame("content_block_start", {
      type: "content_block_start",
      index: state.blockIndex,
      content_block: { type: "thinking", thinking: "" },
    });
  }
}

function* closeActive(state: StreamState): Generator<string> {
  if (state.activeBlockType === null) return;
  yield sseFrame("content_block_stop", {
    type: "content_block_stop",
    index: state.blockIndex,
  });
  state.activeBlockType = null;
}

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

function* handleText(
  state: StreamState,
  chunk: string,
  thinkingEnabled: boolean,
): Generator<string> {
  // Minimal <think>...</think> splitter: emit thinking block for content
  // inside the tags, text block for the rest. Preserves Opencode/OpenRouter
  // models that reveal reasoning inline rather than via reasoning_content.
  // Buffer any trailing partial-tag prefix across chunks so a `<` split from
  // its `think>` doesn't leak the whole reasoning as visible text.
  let remaining = state.thinkTagSuffix + chunk;
  state.thinkTagSuffix = "";

  while (remaining.length > 0) {
    if (state.inThinkTag) {
      const end = remaining.indexOf(CLOSE_TAG);
      if (end === -1) {
        const hold = trailingTagPrefix(remaining, CLOSE_TAG);
        const emit = remaining.slice(0, remaining.length - hold);
        if (thinkingEnabled && emit) {
          yield* ensureBlock(state, "thinking");
          yield sseFrame("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "thinking_delta", thinking: emit },
          });
        }
        state.thinkTagSuffix = remaining.slice(remaining.length - hold);
        return;
      }
      const inside = remaining.slice(0, end);
      if (thinkingEnabled && inside) {
        yield* ensureBlock(state, "thinking");
        yield sseFrame("content_block_delta", {
          type: "content_block_delta",
          index: state.blockIndex,
          delta: { type: "thinking_delta", thinking: inside },
        });
      }
      state.inThinkTag = false;
      remaining = remaining.slice(end + CLOSE_TAG.length);
      continue;
    }

    const start = remaining.indexOf(OPEN_TAG);
    if (start === -1) {
      const hold = trailingTagPrefix(remaining, OPEN_TAG);
      const emit = remaining.slice(0, remaining.length - hold);
      if (emit) {
        yield* ensureBlock(state, "text");
        yield sseFrame("content_block_delta", {
          type: "content_block_delta",
          index: state.blockIndex,
          delta: { type: "text_delta", text: emit },
        });
        state.outputTokens += approxTokens(emit);
      }
      state.thinkTagSuffix = remaining.slice(remaining.length - hold);
      return;
    }
    if (start > 0) {
      const before = remaining.slice(0, start);
      yield* ensureBlock(state, "text");
      yield sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta: { type: "text_delta", text: before },
      });
      state.outputTokens += approxTokens(before);
    }
    state.inThinkTag = true;
    remaining = remaining.slice(start + OPEN_TAG.length);
  }
}

/** Length of the longest non-empty suffix of `s` that is a prefix of `tag`. */
function trailingTagPrefix(s: string, tag: string): number {
  const maxLen = Math.min(s.length, tag.length - 1);
  for (let n = maxLen; n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

function* handleToolCallDelta(
  state: StreamState,
  tc: OpenAIToolCallDelta,
): Generator<string> {
  const idx = tc.index ?? 0;
  const fn = tc.function ?? {};
  let entry = state.tools.get(idx);
  if (!entry) {
    entry = {
      id: null,
      name: null,
      emitted: false,
      pendingArgs: "",
      blockIndex: -1,
    };
    state.tools.set(idx, entry);
  }
  if (tc.id) entry.id = tc.id;
  if (fn.name) entry.name = fn.name;

  // Defer content_block_start until we have both id and name so the real
  // upstream id isn't shadowed by a synthesized one. Commit as soon as
  // arguments start flowing — or when the buffer is about to overflow — to
  // cap the wait.
  const overflowing = !entry.emitted && entry.pendingArgs.length > MAX_PENDING_TOOL_ARGS;
  const canEmit =
    !entry.emitted &&
    ((entry.id !== null && entry.name !== null) ||
      fn.arguments !== undefined ||
      overflowing);

  if (canEmit) {
    yield* emitToolBlockStart(state, entry);
    if (entry.pendingArgs) {
      yield sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: entry.blockIndex,
        delta: { type: "input_json_delta", partial_json: entry.pendingArgs },
      });
      entry.pendingArgs = "";
    }
  }

  if (fn.arguments !== undefined) {
    if (entry.emitted) {
      yield sseFrame("content_block_delta", {
        type: "content_block_delta",
        // Use the tool's own blockIndex, not state.blockIndex — another
        // parallel tool may have been emitted in between, advancing the
        // shared cursor.
        index: entry.blockIndex,
        delta: { type: "input_json_delta", partial_json: fn.arguments },
      });
    } else {
      entry.pendingArgs += fn.arguments;
    }
  }
}

function* emitToolBlockStart(state: StreamState, entry: ToolBlock): Generator<string> {
  yield* closeActive(state);
  state.blockIndex += 1;
  state.activeBlockType = "tool_use";
  entry.id ??= `toolu_${randomUUIDv7()}`;
  entry.name ??= "tool_call";
  entry.emitted = true;
  // Pin this tool's block index so subsequent input_json_delta frames land
  // on the right block even if other parallel tools advance state.blockIndex.
  entry.blockIndex = state.blockIndex;
  yield sseFrame("content_block_start", {
    type: "content_block_start",
    index: entry.blockIndex,
    content_block: { type: "tool_use", id: entry.id, name: entry.name, input: {} },
  });
}

/** Flush any buffered tool blocks or think-tag suffix before finishing the stream. */
function* flushPending(state: StreamState, thinkingEnabled: boolean): Generator<string> {
  if (state.thinkTagSuffix) {
    // Whatever we held back didn't resolve into a tag — emit it literally so
    // we don't silently lose content.
    const leftover = state.thinkTagSuffix;
    state.thinkTagSuffix = "";
    const kind = state.inThinkTag ? "thinking" : "text";
    if (kind === "thinking" && !thinkingEnabled) {
      // Drop: thinking blocks are globally disabled.
    } else {
      yield* ensureBlock(state, kind);
      yield sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta:
          kind === "text"
            ? { type: "text_delta", text: leftover }
            : { type: "thinking_delta", thinking: leftover },
      });
      if (kind === "text") state.outputTokens += approxTokens(leftover);
    }
  }
  for (const entry of state.tools.values()) {
    if (
      !entry.emitted &&
      (entry.id !== null || entry.name !== null || entry.pendingArgs)
    ) {
      yield* emitToolBlockStart(state, entry);
      if (entry.pendingArgs) {
        yield sseFrame("content_block_delta", {
          type: "content_block_delta",
          index: state.blockIndex,
          delta: { type: "input_json_delta", partial_json: entry.pendingArgs },
        });
        entry.pendingArgs = "";
      }
    }
  }
}

function approxTokens(s: string): number {
  // Cheap proxy for output-token accounting; upstream `usage` overrides this.
  // Bias-high (3.3 chars/token) so context % errs toward early auto-compact.
  return Math.max(1, Math.ceil(s.length / 3.3));
}

// ---------- OpenAI streaming chunk shapes (subset) ----------

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: OpenAIToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

// Export the outbound serializer for completeness (tests may import it).
export function serializeAnthropicPassthrough(
  req: AnthropicMessagesRequest,
  opts: { thinkingEnabled: boolean },
): AnthropicMessagesRequest & { stream: true } {
  // Clone and force streaming; strip `thinking` when globally disabled.
  const { thinking, ...rest } = req;
  const out: AnthropicMessagesRequest & { stream: true } = {
    ...rest,
    stream: true,
  };
  if (opts.thinkingEnabled && thinking) out.thinking = thinking;
  return out;
}
