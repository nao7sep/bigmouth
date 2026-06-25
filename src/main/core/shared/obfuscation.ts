/**
 * Toy obfuscation for the API keys in the storage-root secrets file
 * (~/.bigmouth/api-keys.json).
 *
 * This is NOT encryption. It only makes keys not plainly visible when someone
 * glances at the file; the real protection is that file's 0600 permissions and
 * its place outside any git-versionable workspace.
 *
 * The algorithm: reverse the string, then base64-encode it.
 */

export function obfuscate(plain: string): string {
  if (!plain) return "";
  const reversed = plain.split("").reverse().join("");
  return Buffer.from(reversed, "utf-8").toString("base64");
}

export function deobfuscate(encoded: string): string {
  if (!encoded) return "";
  const reversed = Buffer.from(encoded, "base64").toString("utf-8");
  return reversed.split("").reverse().join("");
}
