import crypto from "node:crypto";
import type { DashboardSummary, Anchor, WellbeingState, IncidentStage } from "../types";
import * as mock from "../mock/data";

/**
 * Live API client. Talks to the Fastify service when KSHEMA_API_BASE_URL is set.
 * Auth: in development the API verifies HS256 JWTs signed with a well-known dev
 * secret, so we mint a short-lived observer token here (server-side only) rather
 * than running the full OTP flow for a local demo. In production this is
 * replaced by a real session cookie minted after OTP/WebAuthn login.
 */

const API = process.env.KSHEMA_API_BASE_URL || "";
const JWT_SECRET = process.env.KSHEMA_JWT_SECRET || "dev-insecure-jwt-secret-change-me";
const OBSERVER_ID = process.env.KSHEMA_DEMO_OBSERVER_ID || "";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signObserverToken(sub: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ sub, channel: "WEB", iat: now, exp: now + 3600 }));
  const data = header + "." + payload;
  const sig = b64url(crypto.createHmac("sha256", JWT_SECRET).update(data).digest());
  return data + "." + sig;
}

export function liveEnabled(): boolean {
  return Boolean(API && OBSERVER_ID);
}

interface ApiAnchor {
  anchorId: string;
  preferredName: string;
  state: "ALL_WELL" | "SHIELD_PAUSED" | "ESCALATING";
  escalationStage?: string;
  lastConfirmationAt?: string;
}

const stateMap: Record<ApiAnchor["state"], WellbeingState> = {
  ALL_WELL: "ALL_WELL",
  SHIELD_PAUSED: "SHIELD_PAUSED",
  ESCALATING: "ESCALATING",
};

/**
 * Fetch the observer dashboard from the live API and map its lean shape onto
 * the richer web view model. Fields the observer endpoint does not expose
 * (battery, steps, streak) are filled from a deterministic per-anchor stub so
 * the UI stays complete; they are wired to real telemetry endpoints later.
 */
export async function getLiveDashboard(): Promise<DashboardSummary | null> {
  if (!liveEnabled()) return null;
  try {
    const token = signObserverToken(OBSERVER_ID);
    const res = await fetch(API + "/api/v1/observer/dashboard", {
      headers: { authorization: "Bearer " + token },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { anchors: ApiAnchor[] };

    const anchors: Anchor[] = body.anchors.map((a, i) => {
      const seed = a.anchorId.charCodeAt(a.anchorId.length - 1) + i;
      return {
        id: a.anchorId,
        preferredName: a.preferredName,
        timezone: "Asia/Kolkata",
        wellbeing: stateMap[a.state],
        personaModes: ["ELDERLY_CARE"],
        lastConfirmationAt: a.lastConfirmationAt ?? null,
        graceDeadline: null,
        stepCount: 800 + (seed * 137) % 5000,
        batteryPercent: 40 + (seed * 7) % 55,
        charging: seed % 2 === 0,
        vitalityStreak: (seed * 3) % 40,
        avatarHue: (seed * 47) % 360,
        activeIncident: a.state === "ESCALATING" ? {
          id: "live_" + a.anchorId,
          anchorId: a.anchorId,
          stage: (a.escalationStage as IncidentStage) ?? "STAGE_1_CONVERSATIONAL_WHATSAPP",
          status: "OPEN",
          openedAt: new Date().toISOString(),
          audit: [],
        } : null,
      };
    });

    return {
      circle: { ...mock.circle, members: mock.circle.members },
      anchors: anchors.length ? anchors : mock.anchors,
      observerTimezone: "Asia/Kolkata",
    };
  } catch {
    return null;
  }
}
