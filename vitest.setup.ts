// Shared test setup. Node 20+ provides WebCrypto, CompressionStream and
// ReadableStream globally, which core/ relies on (FR-17, 8.2.1, 8.4).

// jsdom (used per-file via `// @vitest-environment jsdom`) lacks a few APIs the
// UI touches; provide minimal stand-ins so component tests can run.
if (typeof globalThis.matchMedia !== "function") {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof globalThis.matchMedia;
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}
