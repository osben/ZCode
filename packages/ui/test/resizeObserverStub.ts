// jsdom has no ResizeObserver. Upstream 4.0.0 status capsules (ComposerStatusRow) measure with it,
// so suites that mount ConversationComposer import this stub before rendering.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}
