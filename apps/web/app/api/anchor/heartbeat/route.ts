import { NextResponse } from "next/server";
import { signToken } from "@/lib/session";

export const runtime = "nodejs";

const API = process.env.KSHEMA_API_BASE_URL || "";
const DEMO_ANCHOR = process.env.KSHEMA_DEMO_ANCHOR_ID || "";

/**
 * Anchor "I am well" heartbeat (web parity with mobile).
 *
 * Mints a bearer for the Anchor and POSTs a real passive-signal heartbeat to
 * the Fastify API `/api/v1/telemetry/heartbeat`. A screen-unlock / positive
 * step delta is a confirming signal, so the API resolves the Anchor's OPEN
 * incident (R13.1/R13.2) exactly as the mobile "I am well" button does. The
 * browser cannot capture passive sensor data, so a confirming heartbeat is
 * synthesized on an explicit tap.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const anchorId = (body.anchorId as string) || DEMO_ANCHOR;
    if (!anchorId) return NextResponse.json({ error: "anchorId required" }, { status: 400 });
    if (!API) return NextResponse.json({ error: "API base URL not configured" }, { status: 500 });

    const bearer = signToken(anchorId);
    const now = new Date().toISOString();
    const res = await fetch(API + "/api/v1/telemetry/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + bearer },
      cache: "no-store",
      body: JSON.stringify({
        deviceId: "web-" + anchorId,
        screenUnlocks: [now],
        stepDelta: 25,
        battery: 82,
        chargerState: "UNPLUGGED",
        capturedAt: now,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json({ error: "heartbeat failed " + res.status + " " + text }, { status: 502 });
    }
    const ack = await res.json();
    return NextResponse.json({ ok: true, ack });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
