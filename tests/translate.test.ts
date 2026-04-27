import { describe, expect, test } from "bun:test";
import { parseSSE } from "../src/sse.ts";
import {
  anthropicToOpenAIRequest,
  estimateInputTokens,
  openAIStreamToAnthropicSSE,
  serializeAnthropicPassthrough,
} from "../src/translate.ts";
import type { AnthropicMessagesRequest } from "../src/types.ts";

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

async function collect(
  gen: AsyncGenerator<string, void>,
): Promise<Array<{ event: string; data: string }>> {
  const out: Array<{ event: string; data: string }> = [];
  for await (const chunk of gen) {
    // each yielded string is a complete SSE frame "event: X\ndata: Y\n\n"
    const lines = chunk.split("\n");
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    if (dataLines.length) out.push({ event, data: dataLines.join("\n") });
  }
  return out;
}

function ssePayload(events: Array<{ event?: string; data: object | string }>): string {
  return events
    .map((e) => {
      const body = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
      const head = e.event ? `event: ${e.event}\n` : "";
      return `${head}data: ${body}\n\n`;
    })
    .join("");
}

describe("anthropicToOpenAIRequest", () => {
  test("flattens system string into system message", () => {
    const r = anthropicToOpenAIRequest(
      {
        model: "x",
        messages: [{ role: "user", content: "hello" }],
        system: "you are helpful",
      } as AnthropicMessagesRequest,
      { includeReasoningContent: true },
    );
    expect(r.messages[0]).toEqual({ role: "system", content: "you are helpful" });
    expect(r.messages[1]).toEqual({ role: "user", content: "hello" });
    expect(r.stream).toBe(true);
    expect(r.stream_options).toEqual({ include_usage: true });
  });

  test("joins system block array with double newline", () => {
    const r = anthropicToOpenAIRequest(
      {
        model: "x",
        messages: [{ role: "user", content: "hi" }],
        system: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
      { includeReasoningContent: true },
    );
    expect(r.messages[0]).toEqual({ role: "system", content: "a\n\nb" });
  });

  test("converts tool_use → tool_calls and tool_result → tool message", () => {
    const r = anthropicToOpenAIRequest(
      {
        model: "x",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: "search",
                input: { q: "bun" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_1",
                content: "ok",
              },
            ],
          },
        ],
      },
      { includeReasoningContent: true },
    );
    const assistant = r.messages.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls?.[0]?.id).toBe("tu_1");
    expect(assistant?.tool_calls?.[0]?.function.name).toBe("search");
    expect(assistant?.tool_calls?.[0]?.function.arguments).toBe('{"q":"bun"}');
    const tool = r.messages.find((m) => m.role === "tool");
    expect(tool).toEqual({ role: "tool", tool_call_id: "tu_1", content: "ok" });
  });

  test("forwards thinking via reasoning_content when enabled", () => {
    const r = anthropicToOpenAIRequest(
      {
        model: "x",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "step 1" },
              { type: "text", text: "answer" },
            ],
          },
        ],
      },
      { includeReasoningContent: true },
    );
    const a = r.messages.find((m) => m.role === "assistant");
    expect(a?.reasoning_content).toBe("step 1");
    expect(a?.content).toBe("answer");
  });

  test("drops thinking when disabled", () => {
    const r = anthropicToOpenAIRequest(
      {
        model: "x",
        messages: [
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "secret" }],
          },
        ],
      },
      { includeReasoningContent: false },
    );
    // pure-thinking assistant turn with disabled reasoning produces no message
    expect(r.messages.find((m) => m.role === "assistant")).toBeUndefined();
  });

  test("maps tools with input_schema to function parameters", () => {
    const r = anthropicToOpenAIRequest(
      {
        model: "x",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "t", description: "d", input_schema: { type: "object" } }],
      },
      { includeReasoningContent: true },
    );
    expect(r.tools).toEqual([
      {
        type: "function",
        function: { name: "t", description: "d", parameters: { type: "object" } },
      },
    ]);
  });

  test("uses defaultMaxTokens when request omits max_tokens", () => {
    const r = anthropicToOpenAIRequest(
      { model: "x", messages: [{ role: "user", content: "hi" }] },
      { includeReasoningContent: true, defaultMaxTokens: 512 },
    );
    expect(r.max_tokens).toBe(512);
  });

  test("request max_tokens overrides default", () => {
    const r = anthropicToOpenAIRequest(
      { model: "x", max_tokens: 99, messages: [{ role: "user", content: "hi" }] },
      { includeReasoningContent: true, defaultMaxTokens: 512 },
    );
    expect(r.max_tokens).toBe(99);
  });
});

describe("estimateInputTokens", () => {
  test("returns at least 1 for empty messages", () => {
    expect(
      estimateInputTokens({
        model: "x",
        messages: [],
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  test("counts string content via prose ratio", () => {
    const n = estimateInputTokens({
      model: "x",
      messages: [{ role: "user", content: "x".repeat(33) }],
    });
    // 33 / 3.3 = 10
    expect(n).toBe(10);
  });

  test("adds a flat budget per image block", () => {
    const n = estimateInputTokens({
      model: "x",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "" },
            },
          ],
        },
      ],
    });
    expect(n).toBeGreaterThanOrEqual(1600);
  });
});

describe("serializeAnthropicPassthrough", () => {
  test("forces stream:true and preserves thinking when enabled", () => {
    const out = serializeAnthropicPassthrough(
      {
        model: "x",
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled", budget_tokens: 1024 },
      },
      { thinkingEnabled: true },
    );
    expect(out.stream).toBe(true);
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  test("strips thinking when disabled globally", () => {
    const out = serializeAnthropicPassthrough(
      {
        model: "x",
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled" },
      },
      { thinkingEnabled: false },
    );
    expect(out.thinking).toBeUndefined();
  });
});

describe("openAIStreamToAnthropicSSE", () => {
  test("re-frames a simple text delta stream", async () => {
    const upstream = ssePayload([
      {
        data: {
          choices: [{ delta: { content: "Hello " } }],
        },
      },
      {
        data: {
          choices: [{ delta: { content: "world" }, finish_reason: "stop" }],
        },
      },
      { data: "[DONE]" },
    ]);

    const frames = await collect(
      openAIStreamToAnthropicSSE({
        openAIBody: streamFromString(upstream),
        model: "claude-x",
        thinkingEnabled: true,
        estimatedInputTokens: 5,
        parseLines: parseSSE,
      }),
    );

    const events = frames.map((f) => f.event);
    expect(events[0]).toBe("message_start");
    expect(events).toContain("content_block_start");
    expect(events).toContain("content_block_delta");
    expect(events).toContain("content_block_stop");
    expect(events.at(-2)).toBe("message_delta");
    expect(events.at(-1)).toBe("message_stop");

    const deltas = frames
      .filter((f) => f.event === "content_block_delta")
      .map((f) => JSON.parse(f.data).delta);
    const concatenated = deltas
      .filter((d: { type: string }) => d.type === "text_delta")
      .map((d: { text: string }) => d.text)
      .join("");
    expect(concatenated).toBe("Hello world");
  });

  test("emits thinking_delta for reasoning_content", async () => {
    const upstream = ssePayload([
      { data: { choices: [{ delta: { reasoning_content: "thinking..." } }] } },
      { data: { choices: [{ delta: {}, finish_reason: "stop" }] } },
    ]);

    const frames = await collect(
      openAIStreamToAnthropicSSE({
        openAIBody: streamFromString(upstream),
        model: "claude-x",
        thinkingEnabled: true,
        parseLines: parseSSE,
      }),
    );
    const thinking = frames.find(
      (f) =>
        f.event === "content_block_delta" &&
        JSON.parse(f.data).delta?.type === "thinking_delta",
    );
    expect(thinking).toBeDefined();
  });

  test("splits inline <think>...</think> into thinking + text blocks", async () => {
    const upstream = ssePayload([
      {
        data: {
          choices: [{ delta: { content: "<think>secret</think>visible" } }],
        },
      },
      { data: { choices: [{ delta: {}, finish_reason: "stop" }] } },
    ]);

    const frames = await collect(
      openAIStreamToAnthropicSSE({
        openAIBody: streamFromString(upstream),
        model: "claude-x",
        thinkingEnabled: true,
        parseLines: parseSSE,
      }),
    );

    const blockStarts = frames
      .filter((f) => f.event === "content_block_start")
      .map((f) => JSON.parse(f.data).content_block.type);
    expect(blockStarts).toEqual(["thinking", "text"]);

    const concatText = frames
      .filter(
        (f) =>
          f.event === "content_block_delta" &&
          JSON.parse(f.data).delta?.type === "text_delta",
      )
      .map((f) => JSON.parse(f.data).delta.text)
      .join("");
    expect(concatText).toBe("visible");
  });

  test("converts native tool_calls deltas to tool_use frames", async () => {
    const upstream = ssePayload([
      {
        data: {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "do" } },
                ],
              },
            },
          ],
        },
      },
      {
        data: {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '{"x":' } },
                ],
              },
            },
          ],
        },
      },
      {
        data: {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: "1}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      },
    ]);

    const frames = await collect(
      openAIStreamToAnthropicSSE({
        openAIBody: streamFromString(upstream),
        model: "claude-x",
        thinkingEnabled: true,
        parseLines: parseSSE,
      }),
    );

    const toolStart = frames.find((f) => {
      if (f.event !== "content_block_start") return false;
      const cb = JSON.parse(f.data).content_block;
      return cb.type === "tool_use" && cb.id === "call_1" && cb.name === "do";
    });
    expect(toolStart).toBeDefined();

    const argChunks = frames
      .filter(
        (f) =>
          f.event === "content_block_delta" &&
          JSON.parse(f.data).delta?.type === "input_json_delta",
      )
      .map((f) => JSON.parse(f.data).delta.partial_json)
      .join("");
    expect(argChunks).toBe('{"x":1}');
  });

  test("ignores [DONE] sentinel", async () => {
    const frames = await collect(
      openAIStreamToAnthropicSSE({
        openAIBody: streamFromString("data: [DONE]\n\n"),
        model: "claude-x",
        thinkingEnabled: true,
        parseLines: parseSSE,
      }),
    );
    // Always emits a message_start + terminal frames even on empty content.
    expect(frames[0]?.event).toBe("message_start");
    expect(frames.at(-1)?.event).toBe("message_stop");
  });

  test("uses upstream usage when provided", async () => {
    const upstream = ssePayload([
      { data: { choices: [{ delta: { content: "hi" } }] } },
      { data: { choices: [{ delta: {}, finish_reason: "stop" }] } },
      {
        data: {
          choices: [],
          usage: { prompt_tokens: 11, completion_tokens: 22 },
        },
      },
    ]);
    const frames = await collect(
      openAIStreamToAnthropicSSE({
        openAIBody: streamFromString(upstream),
        model: "claude-x",
        thinkingEnabled: true,
        estimatedInputTokens: 5,
        parseLines: parseSSE,
      }),
    );
    const md = frames.find((f) => f.event === "message_delta");
    expect(md).toBeDefined();
    const parsed = JSON.parse(md!.data);
    expect(parsed.usage).toEqual({ input_tokens: 11, output_tokens: 22 });
  });
});
