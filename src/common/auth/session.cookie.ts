import type { CookieOptions } from 'express';

/**
 * The session cookie (frontend FR-W8, W-A9).
 *
 * The dashboard is a browser SPA, so the session token must never be
 * reachable from JavaScript: no `localStorage`, no `sessionStorage`, not even
 * a variable in module scope. An httpOnly cookie is the only transport that
 * makes that structurally true rather than a rule someone has to remember.
 *
 * The token itself is unchanged — the same HMAC-signed, stateless string
 * `SessionService` has always issued. Only the envelope moved.
 */
export const SESSION_COOKIE = 'rle_session';

/**
 * `SameSite=Lax` is the CSRF control, and it is load-bearing.
 *
 * Cookies are attached by the browser automatically, so a cookie session
 * without `SameSite` would let any site POST a decision on the reviewer's
 * behalf. `Lax` withholds the cookie from every cross-site POST while still
 * sending it on a top-level GET navigation, which is what keeps a bookmarked
 * `/leads/:id` working. Every state-changing route here is POST or PATCH, so
 * `Lax` covers the whole mutating surface without a token round-trip.
 *
 * `path: '/'` rather than `/api`: the logout clear must match the set, and
 * scoping to `/api` would hide the cookie from any future non-API route on
 * the same origin for no security gain — httpOnly is what protects it.
 */
export const sessionCookieOptions = (
  isProduction: boolean,
  maxAgeSeconds?: number,
): CookieOptions => ({
  httpOnly: true,
  sameSite: 'lax',
  // Only over TLS in production. Left off in dev because the Vite proxy
  // serves plain http on localhost and a `Secure` cookie would be dropped
  // silently — the failure mode being "login appears to work, every
  // subsequent request is 401".
  secure: isProduction,
  path: '/',
  ...(maxAgeSeconds === undefined ? {} : { maxAge: maxAgeSeconds * 1000 }),
});
