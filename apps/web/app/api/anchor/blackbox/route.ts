import { NextResponse } from "next/server";
import { prisma } from "@kshema/database";
import { bearerForSession, getSessionUserId } from "@/lib/session";

export const runtime = "nodejs";

const API = process.env.KSHEMA_API_BASE_URL || "";

/**
 * Gated Encrypted_Black_Box fetch (web parity with the API contract).
 *
 * The observer dashboard does not expose real incident ids, so this route
 * takes an anchorId, resolves the anchor's most recent OPEN incident, mints a
 * bearer for the CURRENT SESSION USER (the requesting Observer), and calls the
 * Fastify API `POST /api/v1/incidents/:id/blackbox`. All access control lives
 * in the API: the caller must be a CircleMember with canAccessBlackBox=true AND
 * the box must be RELEASED (Stage-4 Hyperlocal_Dispatch or Shadow_SOS). This
 * route is server-blind too — it forwards the ciphertext response verbatim and
 * never decrypts (R8.6, R19.3).
 */
export async function POST(req: Request) {
  try {
    if (!API) return NextResponse.json({ error: "API base URL not configured" }, { status: 500 });
    const body = await req.json().catch(() => ({}));
    const anchorId = String(body.anchorId || "");
    let incidentId = String(body.incidentId || "");
    if (!anchorId && !incidentId) {
      return NextResponse.json({ error: "anchorId or incidentId required" }, { status: 400 });
    }

    // The requesting Observer is the current session user.
    const observerId = getSessionUserId();
    if (!observerId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const bearer = bearerForSession();
    if (!bearer) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    // Resolve the real OPEN incident id for this anchor when not supplied.
    if (!incidentId && anchorId) {
      const inc = await prisma.safetyIncident.findFirst({
        where: { anchorId, status: "OPEN" },
        orderBy: { openedAt: "desc" },
        select: { id: true },
      });
      if (!inc) {
        return NextResponse.json(
          { error: "Not Found", message: "No active incident for this anchor." },
          { status: 404 },
        );
      }
      incidentId = inc.id;
    }

    const res = await fetch(API + "/api/v1/incidents/" + encodeURIComponent(incidentId) + "/blackbox", {
      method: "POST",
      headers: { authorization: "Bearer " + bearer },
      cache: "no-store",
    });
    const payload = await res.json().catch(() => ({}));
    // Forward the API status + body so the UI can distinguish granted (200),
    // denied (403), and not-found (404) exactly as the gate decided.
    return NextResponse.json(payload, { status: res.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
