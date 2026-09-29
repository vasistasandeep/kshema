import { NextResponse } from "next/server";
import { apiFetch } from "@/lib/api";
export const runtime = "nodejs";
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const circleId = String(body.circleId || "");
  const role = body.role;
  if (!circleId) return NextResponse.json({ error: "circleId required" }, { status: 400 });
  const res = await apiFetch(`/api/v1/circles/${circleId}/invitations`, { method: "POST", body: JSON.stringify(role ? { role } : {}) });
  const j = await res.json().catch(() => ({}));
  return NextResponse.json(j, { status: res.status });
}
