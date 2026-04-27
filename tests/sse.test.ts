import { describe, expect, test } from "bun:test";
import { errorFrame, parseSSE, sseFrame } from "../src/sse.ts";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

async function collect(
  body: ReadableStream<Uint8Array>,
): Promise<Array<{ event: string; data: string }>> {
  const out: Array<{ event: string; data: string }> = [];
  for await (const f of parseSSE(body)) out.push(f);
  return out;
}

describe("sseFrame", () => {
  test("string body", () => {
    expect(sseFrame("ping", "hello")).toBe("event: ping\ndata: hello\n\n");
  });

  test("object body serializes to JSON", () => {
    expect(sseFrame("x", { a: 1 })).toBe('event: x\ndata: {"a":1}\n\n');
  });
});

describe("errorFrame", () => {
  test("emits error envelope", () => {
    const out = errorFrame("boom");
    expect(out.startsWith("event: error\n")).toBe(true);
    expect(out).toContain('"type":"error"');
    expect(out).toContain('"message":"boom"');
  });
});

describe("parseSSE", () => {
  test("parses simple event/data pair", async () => {
    const frames = await collect(streamFrom(["event: foo\ndata: bar\n\n"]));
    expect(frames).toEqual([{ event: "foo", data: "bar" }]);
  });

  test("defaults event name to 'message'", async () => {
    const frames = await collect(streamFrom(["data: hi\n\n"]));
    expect(frames).toEqual([{ event: "message", data: "hi" }]);
  });

  test("strips a single leading space after data:", async () => {
    const frames = await collect(streamFrom(["data:  two-spaces\n\n"]));
    // Per spec: strip exactly one leading space; keep the rest verbatim.
    expect(frames[0]?.data).toBe(" two-spaces");
  });

  test("joins multiple data: lines with newline", async () => {
    const frames = await collect(streamFrom(["data: a\ndata: b\n\n"]));
    expect(frames[0]?.data).toBe("a\nb");
  });

  test("ignores comment lines starting with ':'", async () => {
    const frames = await collect(
      streamFrom([": keepalive\nevent: t\ndata: ok\n\n"]),
    );
    expect(frames).toEqual([{ event: "t", data: "ok" }]);
  });

  test("handles CRLF line endings", async () => {
    const frames = await collect(streamFrom(["event: a\r\ndata: b\r\n\r\n"]));
    expect(frames).toEqual([{ event: "a", data: "b" }]);
  });

  test("split chunks across boundary", async () => {
    const frames = await collect(streamFrom(["event: a\nda", "ta: b\n\n"]));
    expect(frames).toEqual([{ event: "a", data: "b" }]);
  });

  test("multiple frames in one chunk", async () => {
    const frames = await collect(
      streamFrom(["event: a\ndata: 1\n\nevent: b\ndata: 2\n\n"]),
    );
    expect(frames).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  test("drops trailing partial line at EOF", async () => {
    const frames = await collect(streamFrom(["data: complete\n\ndata: trunc"]));
    expect(frames).toEqual([{ event: "message", data: "complete" }]);
  });

  test("drops empty event with no data lines", async () => {
    const frames = await collect(streamFrom(["event: x\n\nevent: y\ndata: z\n\n"]));
    expect(frames).toEqual([{ event: "y", data: "z" }]);
  });
});
