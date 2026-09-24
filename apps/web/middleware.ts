import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge middleware for the public brand & trust portal.
 *
 * Job: **geo currency hint (R30.4).** The edge geo country (from the platform's
 * geo header) is forwarded as a `country` query param so the statically
 * generated pricing page can pick the presentment currency without any
 * server-side geo lookup. A manual `?currency=` override always wins, and a
 * missing/unknown country falls back to USD in `detectCurrency`.
 *
 * The geo header name varies by host (`x-vercel-ip-country`, `cf-ipcountry`,
 * `x-geo-country`); we read the first that is present. The bare `/` landing is
 * intentionally left to the app's root route rather than force-redirected here,
 * so the public portal is entered at an explicit `/{locale}` path.
 */
export function middleware(req: NextRequest): NextResponse {
  const { nextUrl } = req;

  // Forward a geo country hint to the pricing page for currency detection.
  if (nextUrl.pathname.endsWith("/pricing") && !nextUrl.searchParams.has("country")) {
    const country =
      req.headers.get("x-vercel-ip-country") ??
      req.headers.get("cf-ipcountry") ??
      req.headers.get("x-geo-country");
    if (country) {
      const url = nextUrl.clone();
      url.searchParams.set("country", country);
      return NextResponse.rewrite(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/:locale/pricing"],
};
