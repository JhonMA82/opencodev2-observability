import { afterEach, describe, expect, test } from "bun:test";
import { boundEvent, boundValue, MAX_FIELD_CHARS, sendEvent } from "../src/sender";

const ORIGINAL_URL = process.env.OPENCODE_OBSERVABILITY_URL;

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.OPENCODE_OBSERVABILITY_URL;
  else process.env.OPENCODE_OBSERVABILITY_URL = ORIGINAL_URL;
});

describe("payload bound", () => {
  test("short values pass through untouched", () => {
    const { value, truncated } = boundValue({ text: "hello", n: 3 });
    expect(truncated).toBe(false);
    expect(value).toEqual({ text: "hello", n: 3 });
  });

  test("an oversized result is truncated deterministically", () => {
    const big = "x".repeat(MAX_FIELD_CHARS + 500);
    const first = boundValue({ out: big });
    const second = boundValue({ out: big });
    expect(first.truncated).toBe(true);
    expect(first.value).toEqual(second.value);
    expect(JSON.stringify(first.value).length).toBeLessThanOrEqual(MAX_FIELD_CHARS + 100);
  });

  test("object shape survives truncation", () => {
    const { value, truncated } = boundValue({
      keep: "yes",
      blob: "y".repeat(MAX_FIELD_CHARS + 10),
    });
    expect(truncated).toBe(true);
    const record = value as Record<string, unknown>;
    expect(record["keep"]).toBe("yes");
    expect(typeof record["blob"]).toBe("string");
  });

  test("boundEvent flags truncation for the sender", () => {
    const { truncated } = boundEvent({
      source_app: "app",
      session_id: "ses_1",
      event_type: "tool.execute.after",
      tool_output: "z".repeat(MAX_FIELD_CHARS + 1),
    });
    expect(truncated).toBe(true);
  });
});

describe("server unavailable", () => {
  test("a failed connection never propagates to OpenCode", async () => {
    // Port 9 (discard) is expected to refuse connections.
    process.env.OPENCODE_OBSERVABILITY_URL = "http://127.0.0.1:9";
    await expect(
      sendEvent({ source_app: "app", session_id: "ses_1", event_type: "tool.execute.before" }),
    ).resolves.toBeUndefined();
  });

  test("an invalid URL never propagates to OpenCode", async () => {
    process.env.OPENCODE_OBSERVABILITY_URL = "http://";
    await expect(
      sendEvent({ source_app: "app", session_id: "ses_1", event_type: "tool.execute.before" }),
    ).resolves.toBeUndefined();
  });
});

describe("successful send", () => {
  test("posts the normalized event with a timestamp", async () => {
    const received: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req: Request) {
        if (req.method === "POST") received.push((await req.json()) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    process.env.OPENCODE_OBSERVABILITY_URL = `http://127.0.0.1:${server.port}`;
    try {
      await sendEvent({
        source_app: "app",
        session_id: "ses_9",
        event_type: "session.created",
      });
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        source_app: "app",
        session_id: "ses_9",
        event_type: "session.created",
      });
      expect(typeof received[0]?.["timestamp"]).toBe("number");
    } finally {
      server.stop(true);
    }
  });
});
