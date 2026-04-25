# cc-opencodego-proxy

Use your [OpenCode Go](https://opencode.ai/docs/go/) (or OpenRouter)
subscription with [Claude Code](https://claude.com/claude-code). A tiny Bun
binary that listens locally on `127.0.0.1:8082`, accepts Anthropic-shaped
`/v1/messages` requests from Claude Code, and forwards them to the upstream —
translating to OpenAI `/v1/chat/completions` when the target model needs it and
re-framing the streaming response back to Anthropic SSE so Claude Code sees a
native reply.

| Provider        | Format              | Path                                |
| --------------- | ------------------- | ----------------------------------- |
| **OpenCode Go** | Anthropic-native    | `/v1/messages` passthrough          |
| **OpenCode Go** | OpenAI-compatible   | `/v1/chat/completions` + translator |
| **OpenRouter**  | OpenAI-compatible   | `/v1/chat/completions` + translator |

OpenCode is hybrid per-model: anything listed in `OPENCODE_OPENAI_MODELS` is
routed through the OpenAI translator; everything else falls through to the
Anthropic passthrough. Incoming Claude model ids are matched case-insensitively
against `opus` / `sonnet` / `haiku` and routed to `MODEL_OPUS` / `MODEL_SONNET` /
`MODEL_HAIKU`, with `MODEL` as the catch-all fallback.

## Dependencies

Only `@types/bun` and `typescript` (dev-only, for the type-checker). All
runtime plumbing uses Bun's built-ins:

- `Bun.serve` with the `routes` API (Bun 1.2.3+)
- `fetch` + `ReadableStream` for upstream streaming
- `TextDecoder` for the line-by-line SSE parser
- `AbortSignal.timeout` for request timeouts
- `.env` is auto-loaded by Bun

No Hono, no Zod, no Express, no Node polyfills.

## Run

### Option A — standalone binary (no Bun install needed)

```bash
bun run build                # native for the host platform → dist/cc-opencodego-proxy
cp .env.example .env         # fill in OPENCODE_API_KEY
./dist/cc-opencodego-proxy
```

Cross-compile for other targets:

```bash
bun run build:linux-x64       # → dist/cc-opencodego-proxy-linux-x64
bun run build:linux-arm64     # → dist/cc-opencodego-proxy-linux-arm64
bun run build:darwin-arm64    # → dist/cc-opencodego-proxy-darwin-arm64
bun run build:darwin-x64      # → dist/cc-opencodego-proxy-darwin-x64
bun run build:windows-x64     # → dist/cc-opencodego-proxy-windows-x64.exe
bun run build:all             # all of the above
```

Typical sizes: ~60–110 MB (Bun runtime is embedded). Binary flags:

```
cc-opencodego-proxy            start the proxy on $HOST:$PORT
cc-opencodego-proxy --version
cc-opencodego-proxy --help
```

Config is env-only — `.env` is picked up from the binary's working directory.

### Option B — source

```bash
bun install
cp .env.example .env
bun run start               # or: bun --watch src/cli.ts
```

The server listens on `http://127.0.0.1:8082` by default.

## Configure

Every knob lives in `.env`. `.env.example` is the authoritative reference,
grouped and commented. The three you'll actually touch:

```dotenv
OPENCODE_API_KEY="sk-..."               # required for opencode/*
OPENCODE_OPENAI_MODELS="mimo-v2.5-pro"  # hybrid routing (see above)
MODEL_OPUS="opencode/mimo-v2.5-pro"     # override per Claude family, optional
```

Valid provider prefixes are `opencode/` and `open_router/`. Any other prefix
fails fast at startup with a clear error.

## Point Claude Code at it

`~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8082",
    "ANTHROPIC_AUTH_TOKEN": "freecc"
  }
}
```

`ANTHROPIC_AUTH_TOKEN` is a placeholder unless you also set
`ANTHROPIC_AUTH_TOKEN` in this proxy's `.env` (then the two must match).

### Auto-start on every session (optional)

If you'd rather not remember to launch the proxy, a Claude Code `SessionStart`
hook can bring it up on demand. Drop a script at `~/.claude/hooks/start-proxy.sh`
that curls `/health` first, `nohup`s the binary only if it's not already up, and
waits up to ~3s for the port to open — then wire it into `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/start-proxy.sh", "timeout": 10 }]
    }]
  }
}
```

## Project layout

```
src/
├── server.ts                # Bun.serve + routes
├── config.ts                # env parsing + model resolver
├── rate-limit.ts            # rolling-window limiter + concurrency cap
├── sse.ts                   # SSE frame builder + upstream line parser
├── translate.ts             # Anthropic ↔ OpenAI request/stream conversion
├── types.ts                 # shared request/response shapes
└── providers/
    ├── dispatcher.ts        # routes per request.provider + resolved model
    ├── anthropic-passthrough.ts  # Opencode /messages passthrough
    └── openai-compat.ts     # shared /chat/completions + re-framing
```

## Intentional gaps

- **No messaging layer** — Discord / Telegram / voice bots are out of scope.
- **No tiktoken** — `count_tokens` uses a `chars / 4` estimator, good enough
  for Claude Code's quota probes.
- **No image blocks** — the translator drops `image` content blocks when
  converting to OpenAI format. Add later if needed.
- **No heuristic tool-call parser** (text → `tool_use`); native `tool_calls`
  deltas work fine for the models this proxy targets today.

## Verified end-to-end

Against the real OpenCode Go endpoint:

- `claude-sonnet-4-20250514` → `minimax-m2.7` (Anthropic passthrough):
  thinking blocks preserved, content streamed verbatim.
- `claude-opus-4-20250514` → `mimo-v2.5-pro` (OpenAI translator):
  `/v1/chat/completions` deltas re-framed as `content_block_delta` / `text_delta`,
  finishing with a proper `message_stop`.

## License

MIT.
