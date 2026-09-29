import { NextResponse } from "next/server";
import { apiFetch } from "@/lib/api";
export const runtime = "nodejs";
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const name = String(body.name || "").trim() || "My Circle";
  const res = await apiFetch("/api/v1/circles", { method: "POST", body: JSON.stringify({ name }) });
  const j = await res.json().catch(() => ({}));
  return NextResponse.json(j, { status: res.status });
}
