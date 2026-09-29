import { NextResponse } from "next/server";
import { upsertUser, setSessionCookie } from "@/lib/session";
import { apiFetch } from "@/lib/api";
export const runtime = "nodejs";
const DEV_PK = "-----BEGIN PUBLIC KEY-----\\\\nMFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBALc3\\\\n-----END PUBLIC KEY-----\\\\n";
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { inviteToken, role, phone, preferredName } = body;
  if (!inviteToken || !role || !phone) return NextResponse.json({ error: "inviteToken, role, phone required" }, { status: 400 });
  // Establish a session for the joining user first.
  const userId = await upsertUser(String(phone), preferredName);
  await setSessionCookie(userId);
  const joinBody: Record<string, unknown> = { inviteToken, role };
  if (role === "OBSERVER" || role === "MUTUAL") joinBody.observerPublicKeyPem = DEV_PK;
  const res = await apiFetch("/api/v1/circles/join", { method: "POST", body: JSON.stringify(joinBody) });
  const j = await res.json().catch(() => ({}));
  return NextResponse.json(j, { status: res.status });
}
