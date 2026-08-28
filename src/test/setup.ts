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

// pdf.js (PdfViewer) touches DOMMatrix at module scope
// (`const SCALE_MATRIX = new DOMMatrix()`), which jsdom doesn't provide.
// Rendering never runs under jsdom — this only needs to keep module
// evaluation alive. Methods mirror the small surface pdf.js calls.
if (typeof globalThis.DOMMatrix === "undefined") {
  class DOMMatrixStub {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    constructor(init?: unknown) {
      if (Array.isArray(init) && init.length === 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init as number[];
      }
    }
    translate(): DOMMatrixStub { return this; }
    scale(): DOMMatrixStub { return this; }
    multiply(): DOMMatrixStub { return this; }
    multiplySelf(): DOMMatrixStub { return this; }
    preMultiplySelf(): DOMMatrixStub { return this; }
    invertSelf(): DOMMatrixStub { return this; }
    rotate(): DOMMatrixStub { return this; }
    translateSelf(): DOMMatrixStub { return this; }
    scaleSelf(): DOMMatrixStub { return this; }
    static fromMatrix(): DOMMatrixStub { return new DOMMatrixStub(); }
  }
  (globalThis as unknown as Record<string, unknown>).DOMMatrix = DOMMatrixStub;
}
