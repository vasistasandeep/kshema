import { NextResponse } from "next/server";
import { prisma } from "@kshema/database";
import { signToken } from "@/lib/session";

export const runtime = "nodejs";

const API = process.env.KSHEMA_API_BASE_URL || "";
const DEMO_ANCHOR = process.env.KSHEMA_DEMO_ANCHOR_ID || "";
const DEMO_CIRCLE = process.env.KSHEMA_DEMO_CIRCLE_ID || "";

const SPARSH_TYPES = new Set([
  "MORNING_CHAI",
  "PRANAM_BLESSING",
  "MORNING_SUN",
  "MARIGOLD_FLOWER",
  "HEART_BLESSING",
]);

/**
 * Anchor one-tap Sparsh (web parity with mobile).
 *
 * Records a real Sparsh_Reaction via the Fastify API `POST /api/v1/sparsh`
 * (R22.8-R22.11). The API requires a recipient in the same circle, so this
 * resolves the Anchor's circle and sends the reaction to another member
 * (the first co-member found). Mints a bearer for the Anchor as the sender.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const anchorId = (body.anchorId as string) || DEMO_ANCHOR;
    const type = body.type as string;
    if (!anchorId) return NextResponse.json({ error: "anchorId required" }, { status: 400 });
    if (!type || !SPARSH_TYPES.has(type)) return NextResponse.json({ error: "valid sparsh type required" }, { status: 400 });
    if (!API) return NextResponse.json({ error: "API base URL not configured" }, { status: 500 });

    // Resolve a circle the anchor belongs to (fall back to the demo circle).
    const membership = await prisma.circleMember.findFirst({
      where: { userId: anchorId },
      select: { circleId: true },
      orderBy: { id: "desc" },
    });
    const circleId = membership?.circleId || DEMO_CIRCLE;
    if (!circleId) return NextResponse.json({ error: "no circle for anchor" }, { status: 400 });

    // Pick a co-member as the recipient of the warm hello.
    const other = await prisma.circleMember.findFirst({
      where: { circleId, userId: { not: anchorId } },
      select: { userId: true },
      orderBy: { id: "asc" },
    });
    if (!other) return NextResponse.json({ error: "no recipient in circle" }, { status: 400 });

    const bearer = signToken(anchorId);
    const res = await fetch(API + "/api/v1/sparsh", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + bearer },
      cache: "no-store",
      body: JSON.stringify({ circleId, toUserId: other.userId, type }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json({ error: "sparsh failed " + res.status + " " + text }, { status: 502 });
    }
    const ack = await res.json();
    return NextResponse.json({ ok: true, ack });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
