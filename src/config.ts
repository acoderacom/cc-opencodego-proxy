/**
 * Environment-backed runtime settings. Bun auto-loads `.env` from the
 * project root, so we just read from `Bun.env`.
 */

import type { ProviderType } from "./types.ts";

const VALID_PROVIDERS = new Set<ProviderType>(["opencode", "open_router", "baseten"]);

function num(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name}=${JSON.stringify(raw)} must be a finite number`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = Bun.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function csv(name: string): ReadonlySet<string> {
  const raw = Bun.env[name];
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function urlOrDefault(name: string, fallback: string): string {
  return Bun.env[name]?.trim() || fallback;
}

function modelOrNull(name: string): string | null {
  const raw = Bun.env[name];
  if (!raw) return null;
  assertValidModel(name, raw);
  return raw;
}

function assertValidModel(envName: string, value: string): void {
  const slash = value.indexOf("/");
  // Reject empty model id (e.g. "open_router/") as well as missing prefix.
  if (slash <= 0 || slash >= value.length - 1) {
    throw new Error(
      `${envName}=${JSON.stringify(value)} must be prefixed with a provider: ` +
        `"opencode/<model>", "open_router/<model>", or "baseten/<model>"`,
    );
  }
  const provider = value.slice(0, slash) as ProviderType;
  if (!VALID_PROVIDERS.has(provider)) {
    throw new Error(
      `${envName}=${JSON.stringify(value)} uses unknown provider ` +
        `${JSON.stringify(provider)}. Valid: opencode, open_router, baseten`,
    );
  }
}

export interface Settings {
  readonly model: string;
  readonly modelOpus: string | null;
  readonly modelSonnet: string | null;
  readonly modelHaiku: string | null;

  readonly openRouterApiKey: string;
  readonly openRouterBaseUrl: string;
  readonly opencodeApiKey: string;
  readonly opencodeBaseUrl: string;
  readonly opencodeOpenAIModels: ReadonlySet<string>;
  readonly basetenApiKey: string;
  readonly basetenBaseUrl: string;

  readonly enableThinking: boolean;
  readonly providerRateLimit: number;
  readonly providerRateWindowSec: number;
  readonly providerMaxConcurrency: number;
  readonly openCodeMaxTokens: number;
  readonly openRouterMaxTokens: number;
  readonly basetenMaxTokens: number;

  readonly httpReadTimeoutMs: number;
  readonly httpConnectTimeoutMs: number;

  readonly host: string;
  readonly port: number;
  readonly idleTimeoutSec: number;
  readonly anthropicAuthToken: string;
}

function isLoopbackHost(host: string): boolean {
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") return true;
  // Anything in 127.0.0.0/8 is loopback per RFC.
  if (host.startsWith("127.")) return true;
  return false;
}

export function loadSettings(): Settings {
  const fallbackModel = Bun.env.MODEL ?? "opencode/minimax-m2.7";
  assertValidModel("MODEL", fallbackModel);

  const host = Bun.env.HOST ?? "127.0.0.1";
  const anthropicAuthToken = Bun.env.ANTHROPIC_AUTH_TOKEN ?? "";
  if (!anthropicAuthToken && !isLoopbackHost(host)) {
    throw new Error(
      `Refusing to bind HOST=${JSON.stringify(host)} (non-loopback) without ` +
        `ANTHROPIC_AUTH_TOKEN set. Either bind to 127.0.0.1 or set the token ` +
        `to require authentication on incoming requests.`,
    );
  }

  return {
    model: fallbackModel,
    modelOpus: modelOrNull("MODEL_OPUS"),
    modelSonnet: modelOrNull("MODEL_SONNET"),
    modelHaiku: modelOrNull("MODEL_HAIKU"),

    openRouterApiKey: Bun.env.OPENROUTER_API_KEY ?? "",
    openRouterBaseUrl: urlOrDefault(
      "OPENROUTER_BASE_URL",
      "https://openrouter.ai/api/v1",
    ),
    opencodeApiKey: Bun.env.OPENCODE_API_KEY ?? "",
    opencodeBaseUrl: urlOrDefault("OPENCODE_BASE_URL", "https://opencode.ai/zen/go/v1"),
    opencodeOpenAIModels: csv("OPENCODE_OPENAI_MODELS"),
    basetenApiKey: Bun.env.BASETEN_API_KEY ?? "",
    basetenBaseUrl: urlOrDefault("BASETEN_BASE_URL", "https://inference.baseten.co/v1"),

    enableThinking: bool("ENABLE_THINKING", true),
    providerRateLimit: num("PROVIDER_RATE_LIMIT", 40),
    providerRateWindowSec: num("PROVIDER_RATE_WINDOW", 60),
    providerMaxConcurrency: num("PROVIDER_MAX_CONCURRENCY", 5),
    openCodeMaxTokens: num("OPENCODE_MAX_TOKENS", 0),
    openRouterMaxTokens: num("OPENROUTER_MAX_TOKENS", 0),
    basetenMaxTokens: num("BASETEN_MAX_TOKENS", 0),

    httpReadTimeoutMs: num("HTTP_READ_TIMEOUT", 120) * 1000,
    httpConnectTimeoutMs: num("HTTP_CONNECT_TIMEOUT", 5) * 1000,

    host,
    port: num("PORT", 8082),
    // Bun.serve's default is 10s — far too short for LLM streams that can
    // pause mid-generation. 255 is Bun's max; the upstream read timeout
    // (HTTP_READ_TIMEOUT) is the real safety net for stuck connections.
    idleTimeoutSec: num("SERVER_IDLE_TIMEOUT", 255),
    anthropicAuthToken,
  };
}

/**
 * Resolve an incoming Claude model id (e.g. "claude-sonnet-4-20250514")
 * to its configured "provider/model" string, using the MODEL_OPUS /
 * MODEL_SONNET / MODEL_HAIKU overrides with a fallback to MODEL.
 */
export function resolveModel(claudeModel: string, settings: Settings): string {
  const lower = claudeModel.toLowerCase();
  if (lower.includes("opus") && settings.modelOpus) return settings.modelOpus;
  if (lower.includes("haiku") && settings.modelHaiku) return settings.modelHaiku;
  if (lower.includes("sonnet") && settings.modelSonnet) return settings.modelSonnet;
  return settings.model;
}

export function splitProviderModel(full: string): {
  provider: ProviderType;
  model: string;
} {
  const slash = full.indexOf("/");
  if (slash <= 0) {
    throw new Error(
      `splitProviderModel: ${JSON.stringify(full)} is missing a provider prefix`,
    );
  }
  return {
    provider: full.slice(0, slash) as ProviderType,
    model: full.slice(slash + 1),
  };
}
