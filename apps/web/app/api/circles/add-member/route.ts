import { NextResponse } from "next/server";
import { prisma } from "@kshema/database";
import { resolveActiveCircleId } from "@/lib/session";
export const runtime = "nodejs";
const DEV_PK = "-----BEGIN PUBLIC KEY-----\\nMFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBALc3\\n-----END PUBLIC KEY-----\\n";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { name, phone, role, canTriggerIVR, canAccessBlackBox } = body;
    let circleId = String(body.circleId || "");
    if (!name || !phone || !role) return NextResponse.json({ error: "name, phone, role required" }, { status: 400 });

    if (!circleId) { circleId = (await resolveActiveCircleId()) || ""; }
    if (!circleId) return NextResponse.json({ error: "no circle; create one first" }, { status: 400 });

    const user = await prisma.user.upsert({
      where: { phone: String(phone) },
      create: { phone: String(phone), publicKeyPem: DEV_PK, timezone: "Asia/Kolkata", preferredName: String(name) },
      update: { preferredName: String(name) },
      select: { id: true },
    });
    const member = await prisma.circleMember.upsert({
      where: { circleId_userId: { circleId, userId: user.id } },
      create: {
        circleId, userId: user.id, role,
        canTriggerIVR: Boolean(canTriggerIVR), canAccessBlackBox: Boolean(canAccessBlackBox),
        ...(role === "OBSERVER" || role === "MUTUAL" ? { observerPublicKeyPem: DEV_PK } : {}),
      },
      update: { role, canTriggerIVR: Boolean(canTriggerIVR), canAccessBlackBox: Boolean(canAccessBlackBox) },
      select: { id: true },
    });
    return NextResponse.json({ ok: true, memberId: member.id, userId: user.id, circleId });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
