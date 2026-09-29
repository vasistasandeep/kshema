import { NextResponse } from "next/server";
import { prisma } from "@kshema/database";

export const runtime = "nodejs";

/**
 * Resolve all OPEN incidents for the demo anchor (or a given anchorId),
 * recording the auto-resolution source. Writes directly to Postgres so the
 * Observer dashboard returns to All Well. In production this goes through the
 * resolution queue; for the demo a direct conditional update is clearest.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const anchorId = (body.anchorId as string) || process.env.KSHEMA_DEMO_ANCHOR_ID || "";
    const source = (body.source as string) || "OBSERVER_OVERRIDE";
    if (!anchorId) return NextResponse.json({ error: "anchorId required" }, { status: 400 });
    const res = await prisma.safetyIncident.updateMany({
      where: { anchorId, status: "OPEN" },
      data: { status: "RESOLVED", resolutionSource: source as never, resolvedAt: new Date() },
    });
    return NextResponse.json({ ok: true, resolved: res.count });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
