/**
 * The renderer's Content-Security-Policy, and how it reaches the page.
 *
 * It has to travel in the HTML. The packaged app loads the renderer over
 * `file://`, and a CSP delivered as an HTTP response header cannot apply to a
 * file: load — which is what the app used to do, so the shipped build ran with
 * no policy in force at all while the code read as though it had one. The
 * `<meta>` tag is injected at build time (see electron.vite.config.ts) rather
 * than written into src/renderer/index.html, because the dev server needs the
 * relaxed policy Vite's HMR client and React Fast Refresh require.
 *
 * Environment-neutral by construction: a string and two pure functions, so it
 * type-checks under both the node and web configs and the build config can
 * import it too.
 */

/**
 * Directives a `<meta http-equiv>` policy honours.
 *
 * `frame-ancestors` is deliberately absent: the HTML meta form ignores it (it
 * is header-only per the CSP spec), so listing it there would log a console
 * warning and protect nothing. Nothing frames this renderer — it is the whole
 * window of a desktop app — and `object-src 'none'` plus `base-uri 'self'`
 * carry the part that matters.
 *
 * `img-src` is what keeps a local-first app local: without it, previewing a
 * post pasted from the web, or a model's analysis output, silently fetches from
 * whatever host the markdown names.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // Inline styles: React sets element styles, and the markdown renderer emits them.
  "style-src 'self' 'unsafe-inline'",
  // data: for inline image URIs sanitized markdown may carry; the custom scheme
  // serves uploaded assets off disk.
  "img-src 'self' data: bigmouth-asset:",
  "font-src 'self'",
  "connect-src 'self' bigmouth-asset:",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** The tag as it appears in the built HTML. */
export function cspMetaTag(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`;
}

/**
 * Inserts the policy as the first thing in `<head>`, so it is in force before
 * any other element in the document is parsed. Throws rather than returning the
 * HTML unchanged if there is no `<head>`: a silent no-op here ships a build with
 * no policy, which is the exact failure this module exists to end.
 */
export function withCspMeta(html: string): string {
  const head = html.indexOf("<head>");
  if (head === -1) throw new Error("renderer HTML has no <head> to carry the Content-Security-Policy");
  const at = head + "<head>".length;
  return `${html.slice(0, at)}\n    ${cspMetaTag()}${html.slice(at)}`;
}
