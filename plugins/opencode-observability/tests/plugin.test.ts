import { describe, expect, test } from "bun:test";
import plugin from "../src/index";

type HookHandler = (input: Record<string, unknown>) => void | Promise<void>;

interface FakeCtx {
  location: {
    directory: string;
    project: { id: string; directory: string; canonical: string };
  };
  tool: {
    hook: (name: string, handler: HookHandler) => Promise<{ dispose: () => Promise<void> }>;
  };
  event: {
    subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<Record<string, unknown>>;
  };
}

function createFakeCtx(streamed: Record<string, unknown>[] = []) {
  const handlers = new Map<string, HookHandler>();
  const disposed: string[] = [];
  let subscribeSignal: AbortSignal | undefined;

  const ctx: FakeCtx = {
    location: {
      directory: "/home/user/code/my-project",
      project: {
        id: "prj_1",
        directory: "/home/user/code/my-project",
        canonical: "/home/user/code/my-project",
      },
    },
    tool: {
      hook: async (name, handler) => {
        handlers.set(name, handler);
        return {
          dispose: async () => {
            disposed.push(name);
          },
        };
      },
    },
    event: {
      subscribe: (options) => {
        subscribeSignal = options?.signal;
        return (async function* () {
          for (const event of streamed) yield event;
          // Then hang until disposed, like the real transport.
          await new Promise<void>((_, reject) => {
            subscribeSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        })();
      },
    },
  };
  return { ctx, handlers, disposed, signalOf: () => subscribeSignal };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("plugin lifecycle", () => {
  test("tool hooks emit before/after with the real sessionID and a duration", async () => {
    const received: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req: Request) {
        if (req.method === "POST") received.push((await req.json()) as Record<string, unknown>);
        return new Response("{}");
      },
    });
    process.env.OPENCODE_OBSERVABILITY_URL = `http://127.0.0.1:${server.port}`;
    const { ctx, handlers } = createFakeCtx();
    try {
      const dispose = await plugin.setup(ctx as never);
      expect(typeof dispose).toBe("function");

      await handlers.get("execute.before")?.({
        tool: "read",
        sessionID: "ses_live",
        agent: "build",
        messageID: "msg_1",
        id: "call_9",
        input: { path: "a.txt" },
      });
      await handlers.get("execute.after")?.({
        tool: "read",
        sessionID: "ses_live",
        agent: "build",
        messageID: "msg_1",
        id: "call_9",
        input: { path: "a.txt" },
        status: "completed",
        result: { content: "hi" },
      });

      await waitFor(() => received.length >= 2);
      expect(received[0]).toMatchObject({
        source_app: "my-project",
        session_id: "ses_live",
        event_type: "tool.execute.before",
        tool_name: "read",
      });
      expect(received[1]).toMatchObject({
        session_id: "ses_live",
        event_type: "tool.execute.after",
        tool_name: "read",
      });
      const payload = received[1]?.["payload"] as Record<string, unknown>;
      expect(payload["status"]).toBe("completed");
      expect(typeof payload["durationMs"]).toBe("number");

      await (dispose as () => Promise<void>)();
    } finally {
      server.stop(true);
      delete process.env.OPENCODE_OBSERVABILITY_URL;
    }
  });

  test("streamed V2 events use the real sessionID, never an invented one", async () => {
    const received: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req: Request) {
        if (req.method === "POST") received.push((await req.json()) as Record<string, unknown>);
        return new Response("{}");
      },
    });
    process.env.OPENCODE_OBSERVABILITY_URL = `http://127.0.0.1:${server.port}`;
    const { ctx } = createFakeCtx([
      { type: "session.created", data: { sessionID: "ses_a", projectID: "prj_1" } },
      { type: "session.created", data: {} },
      { type: "session.step.started", data: { sessionID: "ses_a" } },
    ]);
    try {
      const dispose = await plugin.setup(ctx as never);
      await waitFor(() => received.length >= 2);
      const sessionIds = received.map((event) => event["session_id"]);
      expect(sessionIds).toEqual(["ses_a", "ses_a"]);
      for (const event of received) {
        expect(String(event["session_id"])).not.toMatch(/^session-/);
      }
      await (dispose as () => Promise<void>)();
    } finally {
      server.stop(true);
      delete process.env.OPENCODE_OBSERVABILITY_URL;
    }
  });

  test("cleanup aborts the subscription, disposes hooks and clears state", async () => {
    const { ctx, disposed, signalOf } = createFakeCtx();
    const dispose = (await plugin.setup(ctx as never)) as () => Promise<void>;
    // Give the background loop a tick to start subscribing.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signalOf()?.aborted).toBe(false);
    await dispose();
    expect(signalOf()?.aborted).toBe(true);
    expect(disposed.sort()).toEqual(["execute.after", "execute.before"]);
    // Disposing twice is safe.
    await dispose();
  });
});
