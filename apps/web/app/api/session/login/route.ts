import { NextResponse } from "next/server";
import { upsertUser, setSessionCookie } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Session login. In the production shape this verifies an OTP; in dev we trust
 * the verified phone (the OTP UI still drives the flow) and mint a real session
 * for the upserted User. Body: { phone, preferredName?, timezone? }.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const phone = String(body.phone || "").trim();
    if (!phone) return NextResponse.json({ error: "phone required" }, { status: 400 });
    const userId = await upsertUser(phone, body.preferredName, body.timezone);
    await setSessionCookie(userId);
    return NextResponse.json({ ok: true, userId });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
