/**
 * Reads a fetch Response body with a byte-size cap to prevent unbounded
 * memory consumption. Cancels the stream and throws when the limit is
 * exceeded.
 */
export async function readResponseWithLimit(
  response: { body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Response has no body');
  }

  let totalBytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel().catch(() => {});
        throw new Error(`Response exceeds maximum size of ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 1) return Buffer.from(chunks[0]);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Buffer.from(merged);
}
