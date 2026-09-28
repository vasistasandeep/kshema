import type { WellbeingState, IncidentStage } from "./types";

export const stageLabel: Record<IncidentStage, string> = {
  STAGE_1_CONVERSATIONAL_WHATSAPP: "Gentle check-in",
  STAGE_2_GENTLE_DEVICE_CHIME: "Device chime",
  STAGE_3_OBSERVER_SILENT_ALERT: "Observer alert",
  STAGE_4_HYPERLOCAL_DISPATCH: "Nearby help dispatched",
};

export const stageIndex: Record<IncidentStage, number> = {
  STAGE_1_CONVERSATIONAL_WHATSAPP: 1,
  STAGE_2_GENTLE_DEVICE_CHIME: 2,
  STAGE_3_OBSERVER_SILENT_ALERT: 3,
  STAGE_4_HYPERLOCAL_DISPATCH: 4,
};

export interface StateVisual { label: string; fg: string; bg: string; dot: string; }

export function wellbeingVisual(s: WellbeingState): StateVisual {
  switch (s) {
    case "ALL_WELL":
      return { label: "All Well", fg: "text-healthy", bg: "bg-healthy/10", dot: "bg-healthy" };
    case "ESCALATING":
      return { label: "Needs attention", fg: "text-escalating", bg: "bg-escalating/10", dot: "bg-escalating" };
    case "SHIELD_PAUSED":
      return { label: "Shield Paused", fg: "text-typography/60", bg: "bg-black/5", dot: "bg-typography/40" };
    case "SANCTUARY":
      return { label: "Sanctuary", fg: "text-celebration", bg: "bg-celebration/10", dot: "bg-celebration" };
  }
}

export function relativeTime(isoStr: string | null): string {
  if (!isoStr) return "—";
  const diff = Date.now() - new Date(isoStr).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}

export function timeIn(tz: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date());
}
