import { NextResponse } from "next/server";
import { getEscalationQueue } from "@/lib/queue";

export const runtime = "nodejs";

const DEMO_CIRCLE = process.env.KSHEMA_DEMO_CIRCLE_ID || "";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const anchorId = body.anchorId as string;
    const circleId = (body.circleId as string) || DEMO_CIRCLE;
    if (!anchorId || !circleId) {
      return NextResponse.json({ error: "anchorId and circleId required" }, { status: 400 });
    }
    const queue = getEscalationQueue();
    const job = await queue.add("open", {
      circleId, anchorId,
      cause: "SIMULATED_MISSED_ROUTINE",
      simulated: true,
    });
    return NextResponse.json({ ok: true, jobId: job.id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
