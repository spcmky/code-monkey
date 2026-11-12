import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import winston from "winston";
import logger from "./logger.js";

describe("logger", () => {
  let lines: Record<string, unknown>[];
  let transport: winston.transport;

  beforeEach(() => {
    lines = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
        callback();
      },
    });
    transport = new winston.transports.Stream({ stream: sink });
    logger.add(transport);
  });

  afterEach(() => {
    logger.remove(transport);
  });

  it("emits log entries", () => {
    logger.info("hello", { issueId: "abc" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "info",
      message: "hello",
      issueId: "abc",
    });
  });

  it("redacts sensitive keys at any depth", () => {
    logger.info("secrets", {
      password: "hunter2",
      nested: { token: "abc", safe: "ok" },
    });
    expect(lines[0]).toMatchObject({
      password: "[REDACTED]",
      nested: { token: "[REDACTED]", safe: "ok" },
    });
  });

  it("serializes Error values in metadata", () => {
    logger.error("failed", { error: new Error("boom") });
    const error = lines[0]?.error as { message: string; stack: string };
    expect(error.message).toBe("boom");
    expect(error.stack).toContain("boom");
  });
});
