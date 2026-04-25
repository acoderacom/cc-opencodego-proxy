/**
 * Bun.serve entry point. Exposes the Anthropic-compatible routes Claude Code
 * probes (`/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`, `/`,
 * `/health`) plus their HEAD/OPTIONS stubs.
 */

import { timingSafeEqual } from "node:crypto";
import { loadSettings, resolveModel, splitProviderModel } from "./config.ts";
import { streamForProvider, UpstreamConfigError } from "./providers/dispatcher.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { estimateInputTokens } from "./translate.ts";
import type { AnthropicMessagesRequest } from "./types.ts";

const settings = loadSettings();
const rateLimiter = createRateLimiter({
  rateLimit: settings.providerRateLimit,
  windowSec: settings.providerRateWindowSec,
  maxConcurrency: settings.providerMaxConcurrency,
});

// Anthropic Claude model IDs advertised via /v1/models.
// Routing itself only depends on the opus/sonnet/haiku substring match in
// config.resolveModel, so adding/removing entries here is cosmetic.
// Source: https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/models.md
const SUPPORTED_CLAUDE_MODELS = [
  // Opus
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  // Sonnet
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-20250514",
  // Haiku
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
] as const;

function probe(allow: string): Response {
  return new Response(null, { status: 204, headers: { Allow: allow } });
}

const expectedTokenBuf = Buffer.from(settings.anthropicAuthToken, "utf8");

function constantTimeMatch(presented: string): boolean {
  // Same-length compare to avoid leaking the expected length. Buffer.byteLength
  // is computed once on the presented string; mismatched lengths short-circuit
  // to false but still run a fixed-size compare against the expected token to
  // keep the timing profile uniform.
  const presentedBuf = Buffer.from(presented, "utf8");
  const sameLen = presentedBuf.length === expectedTokenBuf.length;
  const a = sameLen ? presentedBuf : expectedTokenBuf;
  const equal = timingSafeEqual(a, expectedTokenBuf);
  return sameLen && equal;
}

function requireAuth(req: Request): Response | null {
  if (!settings.anthropicAuthToken) return null;
  const header =
    req.headers.get("x-api-key") ??
    req.headers.get("authorization") ??
    req.headers.get("anthropic-auth-token");
  if (!header) {
    return Response.json({ error: "Missing API key" }, { status: 401 });
  }
  let token = header;
  if (token.toLowerCase().startsWith("bearer ")) {
    token = token.slice(7);
  }
  if (!constantTimeMatch(token)) {
    return Response.json({ error: "Invalid API key" }, { status: 401 });
  }
  return null;
}

async function handleMessages(req: Request): Promise<Response> {
  const authFail = requireAuth(req);
  if (authFail) return authFail;

  let body: AnthropicMessagesRequest;
  try {
    body = (await req.json()) as AnthropicMessagesRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.messages?.length) {
    return Response.json(
      { error: "messages must be a non-empty array" },
      { status: 400 },
    );
  }

  const originalModel = body.model;
  const resolvedFull = resolveModel(originalModel, settings);
  const { provider, model: resolvedModel } = splitProviderModel(resolvedFull);
  const rewrittenBody: AnthropicMessagesRequest = { ...body, model: resolvedModel };
  // UUIDv4 first 12 hex chars = 48 bits of randomness. UUIDv7's prefix is a
  // millisecond timestamp, which collides across concurrent requests.
  const requestId = `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

  console.log(
    `[api] request_id=${requestId} ` +
      `original=${originalModel} → ${resolvedFull} messages=${body.messages.length}`,
  );

  let stream: AsyncGenerator<string, void>;
  try {
    stream = streamForProvider({
      provider,
      resolvedModel,
      req: rewrittenBody,
      settings,
      rateLimiter,
      requestId,
      clientSignal: req.signal,
      // Forwarded to the Anthropic passthrough so beta features requested by
      // Claude Code (prompt caching, extended thinking, etc.) aren't stripped.
      anthropicBeta: req.headers.get("anthropic-beta"),
      anthropicVersion: req.headers.get("anthropic-version"),
    });
  } catch (e) {
    if (e instanceof UpstreamConfigError) {
      return Response.json({ error: e.message }, { status: 503 });
    }
    throw e;
  }

  return new Response(generatorToReadableStream(stream), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Bridge an SSE-string async generator into a ReadableStream so client
 * disconnects (`Response` body cancel) propagate to the generator. Without
 * this, Bun keeps the generator suspended at its current `yield` and the
 * upstream socket leaks until httpReadTimeoutMs fires.
 */
function generatorToReadableStream(
  gen: AsyncGenerator<string, void>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value));
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      // Throws into any pending `yield`/`await` inside the generator, which
      // then runs `finally` blocks (e.g. parseSSE's reader.releaseLock and
      // the rate-limit slot release). The upstream fetch's AbortSignal also
      // fires from the request signal independently.
      try {
        await gen.return();
      } catch {
        // Ignore: the generator's cleanup may itself throw on already-aborted
        // streams; we only care that finally blocks executed.
      }
    },
  });
}

function handleRoot(): Response {
  return Response.json({
    status: "ok",
    provider: splitProviderModel(settings.model).provider,
    model: settings.model,
  });
}

function handleModels(req: Request): Response {
  const authFail = requireAuth(req);
  if (authFail) return authFail;
  const data = SUPPORTED_CLAUDE_MODELS.map((id) => ({
    type: "model",
    id,
    display_name: id,
    created_at: "2024-01-01T00:00:00Z",
  }));
  return Response.json({
    data,
    first_id: data[0]?.id,
    last_id: data[data.length - 1]?.id,
    has_more: false,
  });
}

async function handleCountTokens(req: Request): Promise<Response> {
  const authFail = requireAuth(req);
  if (authFail) return authFail;
  let body: AnthropicMessagesRequest;
  try {
    body = (await req.json()) as AnthropicMessagesRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  // Reuse the same estimator that feeds message_start.usage so the
  // count_tokens answer is consistent with what the stream reports.
  return Response.json({ input_tokens: estimateInputTokens(body) });
}

const server = Bun.serve({
  hostname: settings.host,
  port: settings.port,
  idleTimeout: settings.idleTimeoutSec,
  routes: {
    "/": {
      GET: handleRoot,
      HEAD: () => probe("GET, HEAD, OPTIONS"),
      OPTIONS: () => probe("GET, HEAD, OPTIONS"),
    },
    "/health": {
      GET: () => Response.json({ status: "healthy" }),
      HEAD: () => probe("GET, HEAD, OPTIONS"),
      OPTIONS: () => probe("GET, HEAD, OPTIONS"),
    },
    "/v1/models": {
      GET: handleModels,
      HEAD: () => probe("GET, HEAD, OPTIONS"),
      OPTIONS: () => probe("GET, HEAD, OPTIONS"),
    },
    "/v1/messages": {
      POST: handleMessages,
      HEAD: () => probe("POST, HEAD, OPTIONS"),
      OPTIONS: () => probe("POST, HEAD, OPTIONS"),
    },
    "/v1/messages/count_tokens": {
      POST: handleCountTokens,
      HEAD: () => probe("POST, HEAD, OPTIONS"),
      OPTIONS: () => probe("POST, HEAD, OPTIONS"),
    },
  },
  error(err) {
    console.error("[server] unhandled error:", err);
    return Response.json(
      { error: err.message ?? "Internal server error" },
      { status: 500 },
    );
  },
});

console.log(`cc-opencodego-proxy listening on http://${server.hostname}:${server.port}`);
console.log(
  `  MODEL=${settings.model} OPUS=${settings.modelOpus ?? "(fallback)"} ` +
    `SONNET=${settings.modelSonnet ?? "(fallback)"} ` +
    `HAIKU=${settings.modelHaiku ?? "(fallback)"}`,
);
if (settings.opencodeOpenAIModels.size > 0) {
  console.log(
    `  OPENCODE_OPENAI_MODELS=[${[...settings.opencodeOpenAIModels].join(", ")}]`,
  );
}
