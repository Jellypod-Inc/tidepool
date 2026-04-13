import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildFailedEvent,
  createTimeoutController,
  formatSSEEvent,
  parseSSELine,
} from "../src/streaming.js";

describe("formatSSEEvent", () => {
  it("formats a JSON object as an SSE data line", () => {
    const event = { kind: "status-update", taskId: "t1" };
    const result = formatSSEEvent(event);
    expect(result).toBe(`data: ${JSON.stringify(event)}\n\n`);
  });
});

describe("parseSSELine", () => {
  it("parses a data: prefixed line into a JSON object", () => {
    const obj = { kind: "status-update", taskId: "t1" };
    const line = `data: ${JSON.stringify(obj)}`;
    const result = parseSSELine(line);
    expect(result).toEqual(obj);
  });

  it("returns null for empty lines", () => {
    expect(parseSSELine("")).toBeNull();
    expect(parseSSELine("\n")).toBeNull();
  });

  it("returns null for comment lines", () => {
    expect(parseSSELine(": keepalive")).toBeNull();
  });

  it("returns null for non-data lines", () => {
    expect(parseSSELine("event: update")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseSSELine("data: {not json")).toBeNull();
  });
});

describe("buildFailedEvent", () => {
  it("builds a TASK_STATE_FAILED status update event", () => {
    const event = buildFailedEvent("task-1", "ctx-1", "Stream timed out");
    expect(event.kind).toBe("status-update");
    expect(event.taskId).toBe("task-1");
    expect(event.contextId).toBe("ctx-1");
    expect(event.status.state).toBe("TASK_STATE_FAILED");
    expect(event.status.message?.parts[0].text).toBe("Stream timed out");
    expect(event.final).toBe(true);
  });
});

describe("createTimeoutController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onTimeout after the specified duration with no reset", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();

    const controller = createTimeoutController(5000, onTimeout);

    vi.advanceTimersByTime(4999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();

    controller.clear();
  });

  it("does not fire if reset is called before timeout", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();

    const controller = createTimeoutController(5000, onTimeout);

    vi.advanceTimersByTime(3000);
    controller.reset();

    vi.advanceTimersByTime(4999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();

    controller.clear();
  });

  it("does not fire after clear", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();

    const controller = createTimeoutController(5000, onTimeout);
    controller.clear();

    vi.advanceTimersByTime(10000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
