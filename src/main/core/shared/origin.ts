/**
 * Origin guard (CSRF protection) — pure decision, no Express.
 *
 * The server has no authentication, so any browser that can reach it could be
 * driven to make state-changing requests from a third-party page. This guard is
 * what prevents that: a request carrying a cross-site `Origin` is rejected. It
 * lives here as a side-effect-free function so the policy can be unit-tested
 * without standing up the server.
 *
 * Policy (a request with no `Origin` is decided by the caller, not here):
 *   - The loopback host on the listening port (production, same-origin client).
 *   - The Vite dev server on loopback (development).
 *   - Any origin the operator listed in app.json `allowedOrigins`.
 *   - Everything else is denied.
 */

// The development frontend (Vite). Kept in code rather than config because it is
// a fixed dev-only convenience, never a production allowance.
export const DEV_ORIGINS: readonly string[] = [
  "http://127.0.0.1:5273",
  "http://localhost:5273",
];

export function isAllowedOrigin(
  origin: string,
  port: number,
  allowedOrigins: readonly string[],
): boolean {
  if (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`) {
    return true;
  }
  if (DEV_ORIGINS.includes(origin)) return true;
  return allowedOrigins.includes(origin);
}
