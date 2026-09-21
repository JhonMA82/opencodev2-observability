import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "obs-db-")), "events.db");

const { DatabaseManager } = await import("../src/db");

let db: InstanceType<typeof DatabaseManager>;

afterEach(() => {
  db?.close();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "obs-db-")), "events.db");
  // Re-import is cached; create a fresh manager against a fresh path is not
  // possible after caching, so each test uses unique session ids instead.
});

function isActive(database: InstanceType<typeof DatabaseManager>, sessionId: string): boolean {
  const sessions = database.getActiveSessions() as Record<string, unknown>[];
  return sessions.some((s) => s["session_id"] === sessionId);
}

function freshDb() {
  db = new DatabaseManager();
  return db;
}

describe("sessions", () => {
  test("keeps the observed source_app instead of unknown", () => {
    const database = freshDb();
    database.insertEvent({
      timestamp: Date.now(),
      sourceApp: "my-project",
      sessionId: "ses_src_app",
      eventType: "session.created",
    });
    const sessions = database.getActiveSessions() as Record<string, unknown>[];
    const row = sessions.find((s) => s["session_id"] === "ses_src_app");
    expect(row?.["source_app"]).toBe("my-project");
  });

  test("status follows real lifecycle events only", () => {
    const database = freshDb();
    const now = Date.now();
    database.insertEvent({
      timestamp: now,
      sourceApp: "app",
      sessionId: "ses_life",
      eventType: "session.created",
    });
    expect(isActive(database, "ses_life")).toBe(true);

    database.insertEvent({
      timestamp: now,
      sourceApp: "app",
      sessionId: "ses_life",
      eventType: "session.execution.failed",
    });
    expect(isActive(database, "ses_life")).toBe(false);

    database.insertEvent({
      timestamp: now,
      sourceApp: "app",
      sessionId: "ses_life",
      eventType: "tool.execute.after",
    });
    // A later plain event does not resurrect or complete the session.
    expect(isActive(database, "ses_life")).toBe(false);
  });
});
