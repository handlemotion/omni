// `for await (… of readableStream)` for WebKit (Safari, and so the macOS desktop app), which
// lacks `ReadableStream.prototype[Symbol.asyncIterator]`. pdf.js reads a page's text that way,
// so without it every PDF preview failed there while thumbnails, which read no text, drew.
// Imported for its effect by `pdf-preview.tsx`, before pdf.js runs.
async function* iterate<T>(this: ReadableStream<T>) {
  const reader = this.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

if (typeof ReadableStream !== "undefined" && !(Symbol.asyncIterator in ReadableStream.prototype)) {
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: iterate,
  });
}
