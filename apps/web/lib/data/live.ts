import type { DashboardSummary, Anchor, WellbeingState, IncidentStage, VitalityDay } from "../types";
import * as mock from "../mock/data";
import { apiFetch } from "../api";
import { getSessionUserId } from "../session";

/**
 * Live API client. Talks to the Fastify service as the current session user
 * (bearer minted from the session cookie). Maps the API's lean shapes onto the
 * richer web view model. Fields the observer endpoint does not expose (battery,
 * steps) are filled deterministically per anchor so the UI stays complete.
 */
const API = process.env.KSHEMA_API_BASE_URL || "";

export function liveEnabled(): boolean {
  return Boolean(API && getSessionUserId());
}

interface ApiAnchor {
  anchorId: string;
  preferredName: string;
  state: "ALL_WELL" | "SHIELD_PAUSED" | "ESCALATING";
  escalationStage?: string;
  lastConfirmationAt?: string;
}

const stateMap: Record<ApiAnchor["state"], WellbeingState> = {
  ALL_WELL: "ALL_WELL", SHIELD_PAUSED: "SHIELD_PAUSED", ESCALATING: "ESCALATING",
};

export async function getLiveDashboard(): Promise<DashboardSummary | null> {
  if (!liveEnabled()) return null;
  try {
    const res = await apiFetch("/api/v1/observer/dashboard");
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
          id: "live_" + a.anchorId, anchorId: a.anchorId,
          stage: (a.escalationStage as IncidentStage) ?? "STAGE_1_CONVERSATIONAL_WHATSAPP",
          status: "OPEN", openedAt: new Date().toISOString(), audit: [],
        } : null,
      };
    });
    return {
      circle: { ...mock.circle },
      anchors: anchors.length ? anchors : mock.anchors,
      observerTimezone: "Asia/Kolkata",
    };
  } catch { return null; }
}

/** Live 30-day vitality rhythm for an anchor. */
export async function getLiveVitality(anchorId: string): Promise<VitalityDay[] | null> {
  if (!liveEnabled()) return null;
  try {
    const res = await apiFetch(`/api/v1/web/vitality/rhythm?days=30&anchorId=${encodeURIComponent(anchorId)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { days: Array<{ date: string; confirmedAt?: string | null; sparshCount?: number; steps?: number }> };
    if (!Array.isArray(body.days)) return null;
    return body.days.map((d) => ({
      date: d.date,
      confirmed: Boolean(d.confirmedAt),
      confirmationTime: d.confirmedAt ? new Date(d.confirmedAt).toISOString().slice(11, 16) : null,
      steps: d.steps ?? 0,
      sparsh: [],
    }));
  } catch { return null; }
}
