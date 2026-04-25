/**
 * Per-request provider dispatch. For `opencode`, routes between the
 * Anthropic passthrough and the OpenAI-compat path based on whether
 * the resolved model appears in `OPENCODE_OPENAI_MODELS`.
 */

import type { Settings } from "../config.ts";
import type { RateLimiter } from "../rate-limit.ts";
import type { AnthropicMessagesRequest, ProviderType } from "../types.ts";
import { streamOpencodeAnthropic } from "./anthropic-passthrough.ts";
import { streamOpenAICompat } from "./openai-compat.ts";

export async function* streamForProvider(opts: {
  provider: ProviderType;
  resolvedModel: string;
  req: AnthropicMessagesRequest;
  settings: Settings;
  rateLimiter: RateLimiter;
  requestId: string;
  clientSignal?: AbortSignal;
  anthropicBeta?: string | null;
  anthropicVersion?: string | null;
}): AsyncGenerator<string, void> {
  const {
    provider,
    req,
    settings,
    rateLimiter,
    requestId,
    resolvedModel,
    clientSignal,
    anthropicBeta,
    anthropicVersion,
  } = opts;

  if (provider === "opencode") {
    if (!settings.opencodeApiKey) {
      throw new UpstreamConfigError("OPENCODE_API_KEY is not set. Add it to your .env.");
    }
    if (settings.opencodeOpenAIModels.has(resolvedModel)) {
      yield* streamOpenAICompat(req, {
        baseUrl: settings.opencodeBaseUrl,
        apiKey: settings.opencodeApiKey,
        rateLimiter,
        thinkingEnabled: settings.enableThinking,
        readTimeoutMs: settings.httpReadTimeoutMs,
        requestId,
        providerTag: "opencode.openai",
        defaultMaxTokens: settings.openCodeMaxTokens || undefined,
        clientSignal,
      });
    } else {
      yield* streamOpencodeAnthropic(req, {
        baseUrl: settings.opencodeBaseUrl,
        apiKey: settings.opencodeApiKey,
        rateLimiter,
        thinkingEnabled: settings.enableThinking,
        readTimeoutMs: settings.httpReadTimeoutMs,
        requestId,
        clientSignal,
        anthropicBeta,
        anthropicVersion,
      });
    }
    return;
  }

  if (provider === "open_router") {
    if (!settings.openRouterApiKey) {
      throw new UpstreamConfigError(
        "OPENROUTER_API_KEY is not set. Get a key at https://openrouter.ai/keys",
      );
    }
    yield* streamOpenAICompat(req, {
      baseUrl: settings.openRouterBaseUrl,
      apiKey: settings.openRouterApiKey,
      rateLimiter,
      thinkingEnabled: settings.enableThinking,
      readTimeoutMs: settings.httpReadTimeoutMs,
      requestId,
      providerTag: "open_router",
      defaultMaxTokens: settings.openRouterMaxTokens || undefined,
      extraHeaders: {
        "HTTP-Referer": "https://github.com/acoderacom/cc-opencodego-proxy",
        "X-Title": "cc-opencodego-proxy",
      },
      clientSignal,
    });
    return;
  }

  const unreachable: never = provider;
  throw new Error(`Unknown provider: ${unreachable}`);
}

export class UpstreamConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamConfigError";
  }
}
