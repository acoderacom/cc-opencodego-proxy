/**
 * Opencode Anthropic-native passthrough. Forwards the inbound
 * `/v1/messages` request to the upstream verbatim (minus internal
 * fields + `thinking` when globally disabled) and re-emits the upstream
 * SSE frames as-is.
 */

import type { RateLimiter } from "../rate-limit.ts";
import { errorFrame, parseSSE, sseFrame } from "../sse.ts";
import { estimateInputTokens, serializeAnthropicPassthrough } from "../translate.ts";
import type { AnthropicMessagesRequest } from "../types.ts";

export interface AnthropicPassthroughOpts {
  baseUrl: string;
  apiKey: string;
  rateLimiter: RateLimiter;
  thinkingEnabled: boolean;
  readTimeoutMs: number;
  requestId: string;
  /** Aborts the upstream fetch when the Claude Code client disconnects. */
  clientSignal?: AbortSignal;
  /** Forwarded from the inbound request so beta features aren't stripped. */
  anthropicBeta?: string | null;
  /** Forwarded from the inbound request; falls back to 2023-06-01. */
  anthropicVersion?: string | null;
}

const MAX_RATE_LIMIT_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 60_000;

export async function* streamOpencodeAnthropic(
  req: AnthropicMessagesRequest,
  opts: AnthropicPassthroughOpts,
): AsyncGenerator<string, void> {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/messages`;
  const body = serializeAnthropicPassthrough(req, {
    thinkingEnabled: opts.thinkingEnabled,
  });
  const headers: Record<string, string> = {
    // Inbound `x-api-key` / `Authorization` headers from Claude Code are
    // intentionally NOT forwarded — we build a fresh header dict so the
    // proxy's own token cannot leak to the upstream.
    "x-api-key": opts.apiKey,
    "anthropic-version": opts.anthropicVersion || "2023-06-01",
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (opts.anthropicBeta) headers["anthropic-beta"] = opts.anthropicBeta;

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
        await response.body?.cancel();
        const retryAfter = response.headers.get("retry-after");
        const delayMs = computeRetryDelayMs(retryAfter, attempt);
        opts.rateLimiter.setBlocked(delayMs / 1000);
        console.warn(
          `[opencode.anthropic] request_id=${opts.requestId} ` +
            `429 attempt=${attempt + 1}/${MAX_RATE_LIMIT_RETRIES + 1} ` +
            `retry_in=${(delayMs / 1000).toFixed(1)}s`,
        );
        // Free the concurrency slot during the cooldown sleep so other
        // clients aren't blocked on a request that's just waiting.
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
        `[opencode.anthropic] request_id=${opts.requestId} model=${body.model} ` +
          `msgs=${body.messages.length} tools=${body.tools?.length ?? 0}`,
      );

      // Track minimal state so we can synthesize terminal frames if the
      // upstream stream ends without a `message_stop` (error, disconnect).
      const estimatedInput = estimateInputTokens(req);
      let sawMessageStart = false;
      let sawMessageStop = false;
      let activeBlockIndex: number | null = null;
      try {
        for await (const frame of parseSSE(response.body)) {
          if (frame.event === "message_start") {
            sawMessageStart = true;
            // Patch the upstream message_start to ensure non-zero
            // input_tokens so Claude Code's context meter displays
            // accurate usage.
            yield sseFrame(
              "message_start",
              patchMessageStart(frame.data, estimatedInput),
            );
            continue;
          }
          if (frame.event === "message_stop") sawMessageStop = true;
          else if (frame.event === "content_block_start") {
            const idx = tryReadIndex(frame.data);
            if (idx !== null) activeBlockIndex = idx;
          } else if (frame.event === "content_block_stop") {
            activeBlockIndex = null;
          }
          yield sseFrame(frame.event, frame.data);
        }
      } catch (e) {
        yield errorFrame(
          `Stream interrupted: ${(e as Error).message ?? String(e)} ` +
            `(request_id=${opts.requestId})`,
        );
      } finally {
        if (sawMessageStart && !sawMessageStop) {
          if (activeBlockIndex !== null) {
            yield sseFrame("content_block_stop", {
              type: "content_block_stop",
              index: activeBlockIndex,
            });
          }
          yield sseFrame("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { input_tokens: estimatedInput, output_tokens: 0 },
          });
          yield sseFrame("message_stop", { type: "message_stop" });
        }
      }
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

/**
 * Patch a `message_start` SSE data payload to ensure `input_tokens` is
 * non-zero.  The upstream may send `input_tokens: 0` or omit it entirely;
 * we replace it with our char-based estimate so Claude Code's context meter
 * shows real usage.
 */
function patchMessageStart(data: string, estimatedInput: number): string {
  try {
    const parsed = JSON.parse(data);
    if (parsed?.message?.usage) {
      if (!parsed.message.usage.input_tokens) {
        parsed.message.usage.input_tokens = estimatedInput;
      }
    }
    return JSON.stringify(parsed);
  } catch {
    return data;
  }
}

function tryReadIndex(data: string): number | null {
  try {
    const parsed = JSON.parse(data) as { index?: unknown };
    return typeof parsed.index === "number" ? parsed.index : null;
  } catch {
    return null;
  }
}
