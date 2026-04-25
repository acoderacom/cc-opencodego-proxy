/**
 * SSE helpers: frame emitter + stream-of-events parser shared by both
 * strategies. Format: `event: NAME\ndata: BODY\n\n`.
 */

export function sseFrame(event: string, data: string | object): string {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${body}\n\n`;
}

export function errorFrame(message: string): string {
  return sseFrame("error", {
    type: "error",
    error: { type: "api_error", message },
  });
}

/**
 * Async-iterate fully-assembled SSE events from the upstream response body.
 * Follows the W3C EventSource spec: only the single leading space after
 * `data:` is stripped (JSON payloads that legitimately begin with spaces
 * stay intact). Multiple `data:` lines for a single event are joined by
 * newlines per the spec.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let eventName: string | null = null;
  let dataParts: string[] = [];

  const flush = (): { event: string; data: string } | null => {
    if (dataParts.length === 0) {
      eventName = null;
      return null;
    }
    const frame = {
      event: eventName ?? "message",
      data: dataParts.join("\n"),
    };
    eventName = null;
    dataParts = [];
    return frame;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      // On EOF, flush pending multi-byte UTF-8 state so the final frame isn't
      // truncated when the upstream closes mid-codepoint.
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

      while (true) {
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx === -1) break;
        // Preserve leading whitespace; only strip trailing CR.
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
        buffer = buffer.slice(newlineIdx + 1);

        if (line === "") {
          const frame = flush();
          if (frame) yield frame;
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const rest = line.slice(5);
          dataParts.push(rest.startsWith(" ") ? rest.slice(1) : rest);
        }
      }

      if (done) break;
    }
    // Drop any partial line left in the buffer at EOF. Including it would
    // re-feed truncated `data:` JSON to the consumer, which would throw a
    // confusing JSON.parse error rather than surfacing the upstream's
    // abrupt close. The final complete frame was already yielded above on
    // the trailing `\n\n`.
    const frame = flush();
    if (frame) yield frame;
  } finally {
    reader.releaseLock();
  }
}
