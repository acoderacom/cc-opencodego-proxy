# cc-opencodego-proxy

Tiny Bun proxy. Use [OpenCode Go](https://opencode.ai/docs/go/), [OpenRouter](https://openrouter.ai), or [Baseten](https://baseten.co) inside [Claude Code](https://claude.com/claude-code). Listens on `127.0.0.1:8082`, accepts Anthropic-shaped `/v1/messages`, forwards upstream, re-frames OpenAI streams as Anthropic SSE.

## Routing

| Provider     | Format            | Path                                |
|--------------|-------------------|-------------------------------------|
| OpenCode Go  | Anthropic-native  | `/v1/messages` passthrough          |
| OpenCode Go  | OpenAI-compatible | `/v1/chat/completions` + translator |
| OpenRouter   | OpenAI-compatible | `/v1/chat/completions` + translator |
| Baseten      | OpenAI-compatible | `/v1/chat/completions` + translator |

OpenCode is hybrid per-model: anything in `OPENCODE_OPENAI_MODELS` routes through the OpenAI translator; rest passthrough. Inbound Claude model id is matched case-insensitively against `opus`/`sonnet`/`haiku` and routed to `MODEL_OPUS`/`MODEL_SONNET`/`MODEL_HAIKU`, with `MODEL` as fallback.

## Install

```bash
bun run build                # host binary → dist/cc-opencodego-proxy
bun run build:all            # linux/darwin/windows × x64/arm64
```

Or run from source:

```bash
bun install && cp .env.example .env && bun run start
```

## Config

| Env | Default | Notes |
|-----|---------|-------|
| `MODEL` | `opencode/minimax-m2.7` | Fallback. Must be `<provider>/<model>` |
| `MODEL_OPUS` / `MODEL_SONNET` / `MODEL_HAIKU` | — | Family override |
| `OPENCODE_API_KEY` | — | Required for opencode/* |
| `OPENCODE_OPENAI_MODELS` | — | CSV of opencode models routed via OpenAI translator |
| `OPENCODE_BASE_URL` | `https://opencode.ai/zen/go/v1` | |
| `OPENROUTER_API_KEY` | — | Required for open_router/* |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | |
| `BASETEN_API_KEY` | — | Required for baseten/* |
| `BASETEN_BASE_URL` | `https://inference.baseten.co/v1` | |
| `OPENCODE_MAX_TOKENS` / `OPENROUTER_MAX_TOKENS` / `BASETEN_MAX_TOKENS` | `0` | Default `max_tokens` when client omits |
| `ENABLE_THINKING` | `true` | Forward thinking/reasoning blocks |
| `PROVIDER_RATE_LIMIT` / `PROVIDER_RATE_WINDOW` | `40` / `60s` | Rolling-window cap |
| `PROVIDER_MAX_CONCURRENCY` | `5` | In-flight stream cap |
| `HTTP_READ_TIMEOUT` / `HTTP_CONNECT_TIMEOUT` | `120s` / `5s` | |
| `HOST` / `PORT` | `127.0.0.1` / `8082` | Non-loopback requires `ANTHROPIC_AUTH_TOKEN` |
| `ANTHROPIC_AUTH_TOKEN` | — | Inbound auth gate (`x-api-key` / `Authorization: Bearer`) |
| `LOG_FILE` | — | Path or `silent` to mute |

Provider prefixes valid: `opencode/`, `open_router/`, `baseten/`. Anything else fails fast.

## Client setup

`~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8082",
    "ANTHROPIC_AUTH_TOKEN": "any-key"
  }
}
```

`ANTHROPIC_AUTH_TOKEN` is a placeholder unless the proxy's `.env` also sets it (then both must match — constant-time compared).

## Behavior

- **Translator**: text, thinking (`reasoning_content` or inline `<think>...</think>`), tool calls. No images, no heuristic text→tool_use parser.
- **Token estimate**: `chars/4` bias-high feeds `message_start.usage.input_tokens` and `/v1/messages/count_tokens` so Claude Code auto-compaction fires before upstream window overflows.
- **Rate limit**: rolling window + reactive 429 cooldown + concurrency semaphore. Strict FIFO.
- **Retry**: up to 3 attempts on 429. Honors `Retry-After`; otherwise 2s→60s exponential + jitter. Retries don't recharge the rate window.
- **Stream cancel**: client disconnect → upstream `AbortSignal` fires → generator `finally` releases concurrency slot.
- **Auth**: constant-time compare via `crypto.timingSafeEqual`. Inbound auth headers never forwarded upstream.

## Binary

```
cc-opencodego-proxy            start on $HOST:$PORT
cc-opencodego-proxy --version
cc-opencodego-proxy --help
cc-opencodego-proxy --quiet | --log-file PATH
```

`.env` picked up from binary's working directory.

## Auto-start hook (optional)

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

Hook script: curl `/health`, `nohup` binary if down, wait ~3s for port.

## Development

```bash
bun install
bun run dev            # --watch
bun run check          # biome + tsc
bun run lint:fix
bun test               # 59 tests across sse/config/translate/rate-limit
```

## Layout

```
src/
├── cli.ts                   binary entry + log sink
├── server.ts                Bun.serve + routes + auth
├── config.ts                env parsing, model resolver
├── rate-limit.ts            rolling window + concurrency cap
├── sse.ts                   frame builder + line parser
├── translate.ts             Anthropic ↔ OpenAI request/stream
├── types.ts
└── providers/
    ├── dispatcher.ts        per-request route by provider
    ├── anthropic-passthrough.ts
    └── openai-compat.ts     /chat/completions + re-framing
tests/
├── sse.test.ts
├── config.test.ts
├── translate.test.ts
└── rate-limit.test.ts
```

## Intentional gaps

- No tiktoken — `count_tokens` uses `chars/4`, good enough for Claude Code quota probes.
- No image blocks in OpenAI translator path. Anthropic passthrough forwards verbatim.
- No text→tool_use heuristic; native `tool_calls` deltas only.
- No Discord/Telegram/voice bots.

## License

See LICENSE.
