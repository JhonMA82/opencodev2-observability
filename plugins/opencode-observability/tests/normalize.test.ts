import { describe, expect, test } from "bun:test";
import {
  normalizeStreamEvent,
  normalizeToolAfter,
  normalizeToolBefore,
} from "../src/normalize";

const APP = "my-project";

describe("tool.execute.before", () => {
  test("maps V2 hook input to the normalized event", () => {
    const normalized = normalizeToolBefore(APP, {
      tool: "read",
      sessionID: "ses_123",
      agent: "build",
      messageID: "msg_1",
      id: "call_1",
      input: { path: "/tmp/a.txt" },
    });
    expect(normalized).toEqual({
      source_app: APP,
      session_id: "ses_123",
      event_type: "tool.execute.before",
      tool_name: "read",
      tool_input: { path: "/tmp/a.txt" },
      payload: { agent: "build", messageID: "msg_1", callID: "call_1" },
    });
  });

  test("drops observations without an authoritative sessionID", () => {
    expect(
      normalizeToolBefore(APP, {
        tool: "read",
        sessionID: "",
        agent: "build",
        messageID: "msg_1",
        id: "call_1",
        input: {},
      }),
    ).toBeUndefined();
  });
});

describe("tool.execute.after", () => {
  test("completed status keeps the result and the duration", () => {
    const normalized = normalizeToolAfter(
      APP,
      {
        tool: "bash",
        sessionID: "ses_123",
        agent: "build",
        messageID: "msg_1",
        id: "call_1",
        input: { command: "ls" },
        status: "completed",
        result: { content: "ok" },
      },
      42,
    );
    expect(normalized?.event_type).toBe("tool.execute.after");
    expect(normalized?.session_id).toBe("ses_123");
    expect(normalized?.tool_name).toBe("bash");
    expect(normalized?.tool_output).toEqual({ content: "ok" });
    expect(normalized?.payload).toMatchObject({
      status: "completed",
      callID: "call_1",
      durationMs: 42,
    });
  });

  test("error status is never reported as success", () => {
    const normalized = normalizeToolAfter(APP, {
      tool: "bash",
      sessionID: "ses_123",
      agent: "build",
      messageID: "msg_1",
      id: "call_1",
      input: { command: "exit 1" },
      status: "error",
      error: { message: "exit code 1" },
    });
    expect(normalized?.event_type).toBe("tool.execute.after");
    expect(normalized?.payload).toMatchObject({ status: "error" });
    expect(normalized?.tool_output).toEqual({ error: "exit code 1" });
  });

  test("drops observations without an authoritative sessionID", () => {
    expect(
      normalizeToolAfter(APP, {
        tool: "bash",
        sessionID: "",
        agent: "build",
        messageID: "msg_1",
        id: "call_1",
        input: {},
        status: "completed",
        result: {},
      }),
    ).toBeUndefined();
  });
});

describe("session correlation", () => {
  test("every normalized event keeps the real OpenCode sessionID", () => {
    for (const type of [
      "session.created",
      "session.execution.started",
      "session.step.started",
      "session.idle",
    ]) {
      const normalized = normalizeStreamEvent(APP, {
        type,
        data: { sessionID: "ses_real", agent: "build", model: { id: "m", providerID: "p" } },
      });
      expect(normalized?.session_id).toBe("ses_real");
    }
  });

  test("events without sessionID are dropped, never reinvented", () => {
    expect(normalizeStreamEvent(APP, { type: "session.created", data: {} })).toBeUndefined();
    expect(normalizeStreamEvent(APP, { type: "session.created" })).toBeUndefined();
    expect(
      normalizeStreamEvent(APP, { type: "session.created", data: { sessionID: "" } }),
    ).toBeUndefined();
  });

  test("unknown event types are ignored", () => {
    expect(
      normalizeStreamEvent(APP, { type: "tui.toast.show", data: { sessionID: "ses_1" } }),
    ).toBeUndefined();
  });
});

describe("V2 session lifecycle events", () => {
  test("step.started keeps agent, model, message and start time", () => {
    const normalized = normalizeStreamEvent(APP, {
      type: "session.step.started",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "asst_1",
        agent: "build",
        model: { id: "model-x", providerID: "openrouter", variant: "standard" },
        started: 123,
      },
    });
    expect(normalized?.payload).toEqual({
      assistantMessageID: "asst_1",
      agent: "build",
      model: { id: "model-x", providerID: "openrouter", variant: "standard" },
      started: 123,
    });
  });

  test("step.ended keeps finish, tokens and cost", () => {
    const tokens = { input: 10, output: 20, reasoning: 0, cache: { read: 1, write: 2 } };
    const normalized = normalizeStreamEvent(APP, {
      type: "session.step.ended",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "asst_1",
        finish: "stop",
        cost: 0.001,
        tokens,
      },
    });
    expect(normalized?.payload).toMatchObject({ finish: "stop", cost: 0.001, tokens });
  });

  test("step.failed keeps the error summary", () => {
    const normalized = normalizeStreamEvent(APP, {
      type: "session.step.failed",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "asst_1",
        error: { type: "provider", message: "boom", status: 500 },
      },
    });
    expect(normalized?.payload).toMatchObject({
      error: { type: "provider", message: "boom", status: 500 },
    });
  });

  test("execution.failed keeps the error, interrupted keeps the reason", () => {
    const failed = normalizeStreamEvent(APP, {
      type: "session.execution.failed",
      data: { sessionID: "ses_1", error: { type: "x", message: "bad" } },
    });
    expect(failed?.payload).toEqual({ error: { type: "x", message: "bad" } });

    const interrupted = normalizeStreamEvent(APP, {
      type: "session.execution.interrupted",
      data: { sessionID: "ses_1", reason: "user" },
    });
    expect(interrupted?.payload).toEqual({ reason: "user" });
  });

  test("compaction.ended uses the real V2 event name", () => {
    const normalized = normalizeStreamEvent(APP, {
      type: "session.compaction.ended",
      data: { sessionID: "ses_1", reason: "auto" },
    });
    expect(normalized?.event_type).toBe("session.compaction.ended");
  });

  test("session.status preserves the structured V2 status object", () => {
    const normalized = normalizeStreamEvent(APP, {
      type: "session.status",
      data: {
        sessionID: "ses_1",
        status: { type: "retry", attempt: 2, message: "rate limited", next: 1234 },
      },
    });
    expect(normalized?.payload).toEqual({
      status: { type: "retry", attempt: 2, message: "rate limited", next: 1234 },
    });
  });

  test("permission.replied keeps request and reply", () => {
    const normalized = normalizeStreamEvent(APP, {
      type: "permission.replied",
      data: { sessionID: "ses_1", requestID: "req_1", reply: { kind: "allow" } },
    });
    expect(normalized?.payload).toMatchObject({ requestID: "req_1" });
  });
});
