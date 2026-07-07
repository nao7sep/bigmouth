/**
 * Toy obfuscation for the API keys in the storage-root secrets file
 * (~/.bigmouth/api-keys.json), per the api-key-storage-conventions.
 *
 * This is NOT encryption. It only makes keys not plainly visible when someone
 * glances at the file; the real protection is that file's 0600 permissions and
 * its place outside any git-versionable workspace.
 *
 * The algorithm: `obf:` + base64 of the reversed UTF-8 bytes. Operating on bytes
 * (not characters) keeps it byte-for-byte identical to the convention's `obf:`
 * algorithm in every language; for the ASCII keys stored in practice it is the
 * same result. An untagged value is treated as plaintext (a hand-pasted key).
 */

const MARKER = "obf:";

// Canonical base64 (RFC 4648, standard alphabet, required padding): the
// alphabet-and-length check a marked value must pass before it is decoded.
// Buffer.from(..., "base64") is a tolerant decoder — it silently drops any
// character outside the alphabet rather than rejecting the input — so a
// malformed stored value (e.g. "obf:!!!not-base64!!!") would otherwise decode
// to non-empty garbage that passes a truthiness check and gets sent to the
// provider as a key. Validating strictly first is what turns that into a
// clean "absent" instead.
const CANONICAL_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function isCanonicalBase64(value: string): boolean {
  return value.length % 4 === 0 && CANONICAL_BASE64_RE.test(value);
}

export function obfuscate(plain: string): string {
  if (!plain) return "";
  return MARKER + Buffer.from(Buffer.from(plain, "utf-8")).reverse().toString("base64");
}

/**
 * Decodes an `obf:`-marked value, or returns an untagged value as-is
 * (plaintext, a hand-pasted key).
 *
 * Returns:
 *   - `""` for an empty/missing stored value, or a marked value that decodes
 *     to nothing — both mean "no value," not an error.
 *   - `null` when a marked value's payload is NOT valid canonical base64. This
 *     is the strict-decode gate: rather than let Buffer.from's tolerant
 *     decoder turn a malformed value into non-empty garbage, an invalid
 *     payload is reported so the caller can treat the stored value as absent
 *     and warn (naming the key) at the resolution site, per the
 *     api-key-storage-conventions' "malformed value resolves to absent, never
 *     throwing" rule — this never throws, it returns a distinguishable value.
 *   - the decoded plaintext otherwise.
 */
export function deobfuscate(stored: string): string | null {
  if (!stored) return "";
  if (!stored.startsWith(MARKER)) return stored;
  const encoded = stored.slice(MARKER.length);
  if (!isCanonicalBase64(encoded)) return null;
  const decoded = Buffer.from(Buffer.from(encoded, "base64")).reverse().toString("utf-8");
  return decoded.length > 0 ? decoded : "";
}
