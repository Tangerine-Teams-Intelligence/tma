import "@testing-library/jest-dom";

// v2.0-alpha.2 — reactflow on the home dashboard pulls in DOM measurement
// APIs that jsdom doesn't implement. Stub them globally so any test that
// renders a component containing <WorkflowGraph /> (notably the /today
// route smoke test) doesn't throw on mount.
const __g = globalThis as unknown as {
  ResizeObserver?: unknown;
  DOMMatrixReadOnly?: unknown;
  DOMMatrix?: unknown;
};
if (typeof __g.ResizeObserver === "undefined") {
  class StubResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  __g.ResizeObserver = StubResizeObserver;
}
if (typeof __g.DOMMatrixReadOnly === "undefined") {
  class StubDOMMatrix {
    m22 = 1;
    constructor(_t?: unknown) {}
  }
  __g.DOMMatrixReadOnly = StubDOMMatrix;
  __g.DOMMatrix = StubDOMMatrix;
}
