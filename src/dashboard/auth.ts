import crypto from "node:crypto";
import type http from "node:http";

interface AuthSuccess { ok: true }
interface AuthFailure { ok: false; status: number; error: string }

/**
 * Verify a Bearer token from the Authorization header using a timing-safe comparison.
 * Returns an object describing the auth result.
 */
export function checkDashboardAuth(authHeader: string | undefined): AuthSuccess | AuthFailure {
  // Read token lazily — allows env injection in tests and avoids caching a secret in memory longer than needed.
  const token = process.env.BOX_DASHBOARD_TOKEN?.trim() || "";

  // Fail-safe: if operator did not configure a token, mutations must be blocked.
  if (!token) {
    return { ok: false, status: 403, error: "Dashboard auth token not configured — set BOX_DASHBOARD_TOKEN" };
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const provided = authHeader.slice(7); // strip "Bearer "
  if (!provided) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  // Constant-time comparison to prevent timing attacks.
  // Pad both buffers to equal length before comparison.
  const tokenBuf = Buffer.from(token, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");

  if (tokenBuf.length !== providedBuf.length) {
    // Lengths differ — do a dummy comparison to keep timing consistent, then reject.
    crypto.timingSafeEqual(tokenBuf, tokenBuf);
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  if (!crypto.timingSafeEqual(tokenBuf, providedBuf)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  return { ok: true };
}

/**
 * Enforce Bearer token auth on a mutation request.
 * Writes a JSON error response and returns false if the request is not authorized.
 * Returns true if the caller should proceed.
 */
export function requireDashboardAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const result = checkDashboardAuth(req.headers["authorization"]);
  if (!result.ok) {
    const fail = result as AuthFailure;
    res.writeHead(fail.status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: fail.error }));
    return false;
  }
  return true;
}
