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

export function obfuscate(plain: string): string {
  if (!plain) return "";
  return MARKER + Buffer.from(Buffer.from(plain, "utf-8")).reverse().toString("base64");
}

export function deobfuscate(stored: string): string {
  if (!stored) return "";
  if (!stored.startsWith(MARKER)) return stored;
  return Buffer.from(Buffer.from(stored.slice(MARKER.length), "base64")).reverse().toString("utf-8");
}
