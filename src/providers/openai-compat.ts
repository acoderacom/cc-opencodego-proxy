/**
 * Shared OpenAI-compatible streaming: convert inbound Anthropic request to
 * OpenAI chat-completions, POST with `stream: true`, and re-frame deltas as
 * Anthropic SSE via `openAIStreamToAnthropicSSE`.
 */

import type { RateLimiter } from "../rate-limit.ts";
import { errorFrame, parseSSE } from "../sse.ts";
import {
  anthropicToOpenAIRequest,
  estimateInputTokens,
  openAIStreamToAnthropicSSE,
} from "../translate.ts";
import type { AnthropicMessagesRequest } from "../types.ts";

export interface OpenAICompatOpts {
  baseUrl: string;
  apiKey: string;
  rateLimiter: RateLimiter;
  thinkingEnabled: boolean;
  readTimeoutMs: number;
  requestId: string;
  providerTag: string;
  defaultMaxTokens?: number;
  extraHeaders?: Record<string, string>;
  /** Aborts the upstream fetch when the Claude Code client disconnects. */
  clientSignal?: AbortSignal;
}

const MAX_RATE_LIMIT_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 60_000;

export async function* streamOpenAICompat(
  req: AnthropicMessagesRequest,
  opts: OpenAICompatOpts,
): AsyncGenerator<string, void> {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const body = anthropicToOpenAIRequest(req, {
    includeReasoningContent: opts.thinkingEnabled,
    defaultMaxTokens: opts.defaultMaxTokens,
  });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...opts.extraHeaders,
  };

  const estimatedInput = estimateInputTokens(req);
  let release = await opts.rateLimiter.acquireConcurrencySlot();
  try {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      // Only the first attempt counts against the rolling rate window.
      // Retries already paid that cost; they only need to honor the
      // reactive 429 cooldown set below.
      if (attempt === 0) await opts.rateLimiter.waitIfBlocked();
      else await opts.rateLimiter.waitForCooldown();

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: combineSignals(opts.clientSignal, opts.readTimeoutMs),
        });
      } catch (e) {
        yield errorFrame(
          `Could not reach upstream: ${(e as Error).message ?? String(e)} ` +
            `(request_id=${opts.requestId})`,
        );
        return;
      }

      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        if (response.body) {
          try {
            await response.body.cancel();
          } catch {
            /* already consumed or errored */
          }
        }
        const retryAfter = response.headers.get("retry-after");
        const delayMs = computeRetryDelayMs(retryAfter, attempt);
        opts.rateLimiter.setBlocked(delayMs / 1000);
        console.warn(
          `[${opts.providerTag}] request_id=${opts.requestId} ` +
            `429 attempt=${attempt + 1}/${MAX_RATE_LIMIT_RETRIES + 1} ` +
            `retry_in=${(delayMs / 1000).toFixed(1)}s`,
        );
        // Free the concurrency slot during the cooldown sleep so other
        // clients aren't blocked on a request that's just waiting. We
        // re-acquire (and re-honor cooldown) before the next fetch.
        release();
        await opts.rateLimiter.waitForCooldown();
        release = await opts.rateLimiter.acquireConcurrencySlot();
        continue;
      }

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        yield errorFrame(
          `Upstream ${response.status}: ${text.trim() || response.statusText} ` +
            `(request_id=${opts.requestId})`,
        );
        return;
      }

      console.log(
        `[${opts.providerTag}] request_id=${opts.requestId} model=${body.model} ` +
          `msgs=${body.messages.length} tools=${body.tools?.length ?? 0}`,
      );

      yield* openAIStreamToAnthropicSSE({
        openAIBody: response.body,
        model: req.model,
        thinkingEnabled: opts.thinkingEnabled,
        estimatedInputTokens: estimatedInput,
        parseLines: parseSSE,
      });
      return;
    }
    yield errorFrame(
      `Upstream rate limit exceeded after retries (request_id=${opts.requestId})`,
    );
  } finally {
    release();
  }
}

function computeRetryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const parsed = Number(retryAfter);
    if (Number.isFinite(parsed) && parsed > 0) return parsed * 1000;
  }
  const exp = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  return exp + Math.random() * 1000;
}

function combineSignals(client: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return client ? AbortSignal.any([client, timeout]) : timeout;
}
