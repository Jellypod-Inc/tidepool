import { describe, it, expect, vi, afterEach } from "vitest";
import { createTimeoutController } from "../src/streaming.js";

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
