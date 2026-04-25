/**
 * Minimal types for the Anthropic Messages + OpenAI Chat request/response
 * shapes we proxy through. We do not validate these at runtime — the upstream
 * rejects malformed payloads and we forward the error to the client.
 */

// ---------- Anthropic (inbound) ----------

export type AnthropicRole = "user" | "assistant";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<AnthropicTextBlock>;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock;

export interface AnthropicMessage {
  role: AnthropicRole;
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens?: number;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: "text"; text: string }>;
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  metadata?: Record<string, unknown>;
  tools?: AnthropicTool[];
  tool_choice?: Record<string, unknown>;
  thinking?: { enabled: boolean } | Record<string, unknown>;
}

// ---------- OpenAI (outbound for the chat-completions path) ----------

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  reasoning_content?: string;
}

export interface OpenAIChatCompletionsRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream: true;
  stream_options?: { include_usage?: boolean };
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters: Record<string, unknown>;
    };
  }>;
  tool_choice?: Record<string, unknown>;
}

// ---------- Resolved provider routing metadata ----------

export interface ResolvedRequest {
  /** Original Claude model id the client sent (e.g. "claude-sonnet-4-20250514"). */
  readonly originalModel: string;
  /** Full "provider/model" string after MODEL_* resolution. */
  readonly resolvedProviderModel: string;
  /** The upstream model name only (the slash-suffix of resolvedProviderModel). */
  readonly resolvedModel: string;
  /** Resolved provider type — "opencode" or "open_router". */
  readonly providerType: ProviderType;
  /** A stable request id for logging. */
  readonly requestId: string;
  /** The parsed Anthropic request, already rewritten with the resolved model. */
  readonly body: AnthropicMessagesRequest;
}

export type ProviderType = "opencode" | "open_router";
