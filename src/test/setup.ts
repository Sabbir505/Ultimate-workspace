// Global test setup for vitest (jsdom).
// jsdom has no ResizeObserver; components using @tanstack/react-virtual or
// direct ResizeObserver probes (e.g. ChatSessionRow) crash without a stub.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
}
