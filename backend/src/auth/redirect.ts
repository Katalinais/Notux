/**
 * True when `redirect` points inside one of the allowed frontend locations.
 * Compares parsed origins (so "http://localhost:8080.evil.com" never matches "http://localhost:8080")
 * and, when an allowed entry has a path (e.g. "https://user.github.io/notux/"), requires that path prefix.
 */
export function isAllowedRedirect(redirect: string | undefined, allowed: string[]): boolean {
  if (!redirect || redirect.length > 2048) return false;
  let target: URL;
  try {
    target = new URL(redirect);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  if (target.username || target.password) return false;

  return allowed.some((entry) => {
    let base: URL;
    try {
      base = new URL(entry);
    } catch {
      return false;
    }
    if (base.origin !== target.origin) return false;
    const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    return basePath === '/' || target.pathname === basePath.slice(0, -1) || target.pathname.startsWith(basePath);
  });
}

/** Adds query params to the frontend redirect, keeping its existing query and hash. */
export function withParams(redirect: string, params: Record<string, string>): string {
  const url = new URL(redirect);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
