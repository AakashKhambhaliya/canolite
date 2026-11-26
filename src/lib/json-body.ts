/**
 * Bounded JSON body parsing.
 *
 * `next.config.mjs` raises the middleware body limit to ~111 MB so video
 * uploads fit, which means every other route would happily buffer and
 * JSON.parse a body that large into the V8 heap. Routes that only ever take a
 * few fields read their body through here with a small cap instead.
 */

export const SMALL_JSON_LIMIT = 64 * 1024;

export class BodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413
  ) {
    super(message);
    this.name = "BodyError";
  }
}

/**
 * Read and parse a JSON body of at most `maxBytes`. Throws `BodyError` (400 for
 * malformed JSON, 413 for oversize) — callers turn that into a response.
 * An empty body parses as `{}` so routes that accept "no options" keep working.
 */
export async function readJsonBody<T = unknown>(
  request: Request,
  maxBytes: number = SMALL_JSON_LIMIT
): Promise<T> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyError("Request body too large", 413);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyError("Request body too large", 413);
      }
      chunks.push(value);
    }
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BodyError("Invalid JSON body", 400);
  }
}

/** Convert a thrown `BodyError` into a JSON response; rethrow anything else. */
export function bodyErrorResponse(error: unknown): Response | null {
  if (error instanceof BodyError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return null;
}

/** Upper bound for a template save (a design document plus its metadata). */
export const TEMPLATE_JSON_LIMIT = 20 * 1024 * 1024;

/**
 * Like `readJsonBody`, but malformed JSON yields `null` (so schema validation
 * reports it) while an oversized body still throws a 413 `BodyError`.
 */
export async function readJsonBodyOrNull<T = unknown>(
  request: Request,
  maxBytes: number
): Promise<T | null> {
  try {
    return await readJsonBody<T>(request, maxBytes);
  } catch (error) {
    if (error instanceof BodyError && error.status === 413) throw error;
    return null;
  }
}
