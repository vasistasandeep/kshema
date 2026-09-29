import { NextResponse } from "next/server";
import { prisma } from "@kshema/database";
import { resolveActiveCircleId } from "@/lib/session";
export const runtime = "nodejs";

export async function GET() {
  try {
    const circleId = await resolveActiveCircleId();
    if (!circleId) return NextResponse.json({ members: [] });
    const members = await prisma.circleMember.findMany({
      where: { circleId },
      select: { id: true, role: true, canTriggerIVR: true, canAccessBlackBox: true, user: { select: { preferredName: true, phone: true } } },
    });
    return NextResponse.json({
      circleId,
      members: members.map((mm) => ({
        id: mm.id, role: mm.role, canTriggerIVR: mm.canTriggerIVR, canAccessBlackBox: mm.canAccessBlackBox,
        name: mm.user?.preferredName ?? "Member",
        phoneLast4: (mm.user?.phone ?? "").slice(-4),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
