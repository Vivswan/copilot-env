import { createHash } from "node:crypto";

/** SHA-256 of a stream as lowercase hex, hashed as the bytes pass: release binaries and the deno
 *  sidecar archive run to tens of megabytes. */
export async function sha256Hex(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}
