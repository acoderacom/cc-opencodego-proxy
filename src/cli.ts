#!/usr/bin/env bun
/**
 * CLI entrypoint for the compiled binary.
 *
 * Usage:
 *   cc-opencodego-proxy                      start the proxy (logs → stdout/stderr)
 *   cc-opencodego-proxy --log-file PATH      append logs to PATH (also LOG_FILE env)
 *   cc-opencodego-proxy --quiet              suppress all logs (also LOG_FILE=silent)
 *   cc-opencodego-proxy --version
 *   cc-opencodego-proxy --help
 */

import { createWriteStream } from "node:fs";

// `BUILD_VERSION` is baked in at compile time via --define.
declare const BUILD_VERSION: string;
const VERSION = typeof BUILD_VERSION === "string" ? BUILD_VERSION : "0.0.0-dev";

const HELP = `cc-opencodego-proxy ${VERSION}

Usage:
  cc-opencodego-proxy                   start the proxy on $HOST:$PORT
  cc-opencodego-proxy --log-file PATH   append every log line to PATH
  cc-opencodego-proxy --quiet           disable logging entirely
  cc-opencodego-proxy --version         print version and exit
  cc-opencodego-proxy --help            print this help and exit

Logging precedence: --quiet > --log-file > LOG_FILE env > stdout/stderr (default).
LOG_FILE=silent in .env is equivalent to --quiet.

Configuration is read from environment variables. A template lives in
.env.example next to the source. Key vars:

  MODEL, MODEL_OPUS, MODEL_SONNET, MODEL_HAIKU
  OPENCODE_API_KEY  OPENCODE_OPENAI_MODELS  OPENCODE_BASE_URL
  OPENROUTER_API_KEY
  BASETEN_API_KEY  BASETEN_BASE_URL
  HOST  PORT  ANTHROPIC_AUTH_TOKEN  LOG_FILE
`;

// ---- minimal arg parser ----

interface CliArgs {
  logFile: string | null;
  quiet: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = { logFile: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--help":
      case "-h":
        process.stdout.write(HELP);
        process.exit(0);
        break;
      case "--version":
      case "-v":
        process.stdout.write(`${VERSION}\n`);
        process.exit(0);
        break;
      case "--quiet":
      case "-q":
        out.quiet = true;
        break;
      case "--log-file": {
        const next = argv[i + 1];
        if (!next || next.startsWith("-")) {
          process.stderr.write(`--log-file requires a path argument\n`);
          process.exit(2);
        }
        out.logFile = next;
        i++;
        break;
      }
      default:
        process.stderr.write(`Unknown argument: ${a}\nSee --help\n`);
        process.exit(2);
    }
  }
  return out;
}

const cli = parseArgs(Bun.argv.slice(2));

// ---- log sink selection ----
// Resolve target: --quiet > --log-file > LOG_FILE env > stdout.
type LogTarget = { kind: "stdout" } | { kind: "silent" } | { kind: "file"; path: string };

function resolveTarget(cli: CliArgs): LogTarget {
  if (cli.quiet) return { kind: "silent" };
  if (cli.logFile) return { kind: "file", path: cli.logFile };
  const env = (Bun.env.LOG_FILE ?? "").trim();
  if (!env) return { kind: "stdout" };
  if (env === "silent" || env === "off" || env === "/dev/null") {
    return { kind: "silent" };
  }
  return { kind: "file", path: env };
}

const target = resolveTarget(cli);

if (target.kind === "silent") {
  const noop = (): void => {};
  console.log = noop;
  console.info = noop;
  console.warn = noop;
  console.error = noop;
} else if (target.kind === "file") {
  // Append mode; createWriteStream buffers internally so per-line cost stays cheap.
  const stream = createWriteStream(target.path, { flags: "a" });
  const fmt = (level: string, args: unknown[]): string => {
    const body = args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    return `${new Date().toISOString()} ${level} ${body}\n`;
  };
  console.log = (...a: unknown[]): void => {
    stream.write(fmt("INFO", a));
  };
  console.info = console.log;
  console.warn = (...a: unknown[]): void => {
    stream.write(fmt("WARN", a));
  };
  console.error = (...a: unknown[]): void => {
    stream.write(fmt("ERROR", a));
  };

  // Flush on shutdown so the tail of the log isn't lost.
  const shutdown = (): void => {
    stream.end();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("beforeExit", shutdown);

  // Also announce to the real stdout where logs are going, otherwise users run
  // the binary and see nothing and think it crashed.
  process.stdout.write(`cc-opencodego-proxy: logging to ${target.path}\n`);
}

// Import the server for its startup side effects.
await import("./server.ts");
