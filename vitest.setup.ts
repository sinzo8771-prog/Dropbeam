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

// jsdom's Blob predates `stream()`, which Sender uses to chunk a file. Every
// browser Dropbeam targets has it (Chrome 76+, Firefox 69+, Safari 14.1+), so
// this is a test-environment gap rather than a product one. Borrowing Node's
// implementation keeps component tests moving real bytes instead of stubbing
// the sender.
function blobStream(blob: Blob): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new Uint8Array(await blob.arrayBuffer()));
      controller.close();
    },
  });
}

if (typeof Blob !== "undefined" && typeof Blob.prototype.stream !== "function") {
  Object.defineProperty(Blob.prototype, "stream", {
    configurable: true,
    writable: true,
    value: function stream(this: Blob): ReadableStream<Uint8Array> {
      return blobStream(this);
    },
  });
}
