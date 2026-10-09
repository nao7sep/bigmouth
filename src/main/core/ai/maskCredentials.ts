/**
 * A provider call's record with its credentials masked (data-lifecycle-conventions, Records): a
 * header that carries a credential keeps its name and loses its value, an Authorization value keeps
 * its scheme, and any occurrence of the call's own key elsewhere, such as an error that echoes it,
 * is replaced too. Everything else, and the structure, is kept. The live request is never touched:
 * this works on the copy that is recorded.
 */

export const MASK = "[REDACTED]";

const CREDENTIAL_HEADERS = new Set(["x-api-key", "authorization", "proxy-authorization", "cookie", "set-cookie"]);

// A key shorter than this would mask ordinary words; real keys are far longer.
const MIN_SECRET_LENGTH = 8;

export function maskCredentials<T>(value: T, secrets: readonly (string | null | undefined)[]): T {
  const known = secrets.filter((secret): secret is string => typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH);
  const seen = new WeakMap<object, unknown>();

  const maskText = (text: string): string => known.reduce((masked, secret) => masked.split(secret).join(MASK), text);

  const maskHeader = (name: string, headerValue: unknown): unknown => {
    if (typeof headerValue !== "string") return MASK;
    if (name === "authorization" || name === "proxy-authorization") {
      const scheme = /^(\S+)\s+\S/.exec(headerValue)?.[1];
      return scheme ? `${scheme} ${MASK}` : MASK;
    }
    return MASK;
  };

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return maskText(node);
    if (node === null || typeof node !== "object") return node;
    if (seen.has(node)) return seen.get(node);
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      seen.set(node, out);
      for (const item of node) out.push(walk(item));
      return out;
    }
    const out: Record<string, unknown> = {};
    seen.set(node, out);
    for (const [key, child] of Object.entries(node)) {
      out[key] = CREDENTIAL_HEADERS.has(key.toLowerCase()) ? maskHeader(key.toLowerCase(), child) : walk(child);
    }
    return out;
  };

  return walk(value) as T;
}
