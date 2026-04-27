import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  loadSettings,
  resolveModel,
  splitProviderModel,
  type Settings,
} from "../src/config.ts";

const ENV_KEYS = [
  "MODEL",
  "MODEL_OPUS",
  "MODEL_SONNET",
  "MODEL_HAIKU",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENCODE_API_KEY",
  "OPENCODE_BASE_URL",
  "OPENCODE_OPENAI_MODELS",
  "BASETEN_API_KEY",
  "BASETEN_BASE_URL",
  "ENABLE_THINKING",
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_RATE_WINDOW",
  "PROVIDER_MAX_CONCURRENCY",
  "OPENCODE_MAX_TOKENS",
  "OPENROUTER_MAX_TOKENS",
  "BASETEN_MAX_TOKENS",
  "HTTP_READ_TIMEOUT",
  "HTTP_CONNECT_TIMEOUT",
  "HOST",
  "PORT",
  "SERVER_IDLE_TIMEOUT",
  "ANTHROPIC_AUTH_TOKEN",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = Bun.env[k];
    delete Bun.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete Bun.env[k];
    else Bun.env[k] = saved[k]!;
  }
});

describe("splitProviderModel", () => {
  test("splits provider and model", () => {
    expect(splitProviderModel("opencode/foo-bar")).toEqual({
      provider: "opencode",
      model: "foo-bar",
    });
  });

  test("preserves slashes inside model name", () => {
    expect(splitProviderModel("open_router/anthropic/claude-3")).toEqual({
      provider: "open_router",
      model: "anthropic/claude-3",
    });
  });

  test("throws when prefix missing", () => {
    expect(() => splitProviderModel("noprefix")).toThrow(/missing a provider/);
  });

  test("throws on leading slash", () => {
    expect(() => splitProviderModel("/foo")).toThrow(/missing a provider/);
  });
});

describe("resolveModel", () => {
  const settings = {
    model: "opencode/fallback",
    modelOpus: "opencode/o-model",
    modelSonnet: "opencode/s-model",
    modelHaiku: "open_router/h-model",
  } as Settings;

  test("opus override", () => {
    expect(resolveModel("claude-opus-4-5", settings)).toBe("opencode/o-model");
  });

  test("sonnet override", () => {
    expect(resolveModel("claude-Sonnet-4-5", settings)).toBe("opencode/s-model");
  });

  test("haiku override", () => {
    expect(resolveModel("CLAUDE-HAIKU-4-5", settings)).toBe("open_router/h-model");
  });

  test("fallback when no family match", () => {
    expect(resolveModel("gpt-4o", settings)).toBe("opencode/fallback");
  });

  test("fallback when override is null", () => {
    const s = { ...settings, modelOpus: null } as Settings;
    expect(resolveModel("claude-opus-4", s)).toBe("opencode/fallback");
  });
});

describe("loadSettings", () => {
  test("uses default MODEL when unset", () => {
    const s = loadSettings();
    expect(s.model).toBe("opencode/minimax-m2.7");
    expect(s.host).toBe("127.0.0.1");
    expect(s.port).toBe(8082);
  });

  test("rejects MODEL with no provider prefix", () => {
    Bun.env.MODEL = "naked-model";
    expect(() => loadSettings()).toThrow(/must be prefixed with a provider/);
  });

  test("rejects MODEL with unknown provider", () => {
    Bun.env.MODEL = "fake/x";
    expect(() => loadSettings()).toThrow(/unknown provider/);
  });

  test("rejects empty model name", () => {
    Bun.env.MODEL_OPUS = "opencode/";
    expect(() => loadSettings()).toThrow(/must be prefixed with a provider/);
  });

  test("refuses non-loopback bind without auth token", () => {
    Bun.env.HOST = "0.0.0.0";
    expect(() => loadSettings()).toThrow(/Refusing to bind/);
  });

  test("allows non-loopback bind with auth token", () => {
    Bun.env.HOST = "0.0.0.0";
    Bun.env.ANTHROPIC_AUTH_TOKEN = "secret";
    const s = loadSettings();
    expect(s.host).toBe("0.0.0.0");
    expect(s.anthropicAuthToken).toBe("secret");
  });

  test("parses csv into a Set", () => {
    Bun.env.OPENCODE_OPENAI_MODELS = "a, b ,c,";
    const s = loadSettings();
    expect([...s.opencodeOpenAIModels].sort()).toEqual(["a", "b", "c"]);
  });

  test("rejects non-finite numeric env", () => {
    Bun.env.PORT = "not-a-number";
    expect(() => loadSettings()).toThrow(/must be a finite number/);
  });

  test("ENABLE_THINKING defaults to true", () => {
    expect(loadSettings().enableThinking).toBe(true);
  });

  test("ENABLE_THINKING=0 disables", () => {
    Bun.env.ENABLE_THINKING = "0";
    expect(loadSettings().enableThinking).toBe(false);
  });

  test("OPENROUTER_BASE_URL trims and falls back when blank", () => {
    Bun.env.OPENROUTER_BASE_URL = "   ";
    expect(loadSettings().openRouterBaseUrl).toBe("https://openrouter.ai/api/v1");
  });
});
