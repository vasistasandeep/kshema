import type {
  DashboardSummary, VitalityDay, SentinelPolicy, HyperlocalProfile,
  Invoice, PanchangaCard, Anchor,
} from "../types";
import * as mock from "../mock/data";
import { getLiveDashboard, liveEnabled } from "./live";

/**
 * Data-access layer. Every UI component reads through these functions. The
 * observer dashboard uses the live Fastify API when configured
 * (KSHEMA_API_BASE_URL + KSHEMA_DEMO_OBSERVER_ID) and otherwise resolves rich
 * mock data. Detail surfaces that the API does not yet expose (vitality history,
 * policy, billing) use mock data today and are wired to their endpoints as they
 * come online. The UI is identical across modes.
 */

const API = process.env.KSHEMA_API_BASE_URL || "";

async function apiGet<T>(path: string, fallback: T): Promise<T> {
  if (!API) return fallback;
  try {
    const res = await fetch(API + path, { cache: "no-store" });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

export async function getDashboard(): Promise<DashboardSummary> {
  const live = await getLiveDashboard();
  if (live) return live;
  return mock.dashboardSummary;
}

export async function getAnchor(id: string): Promise<Anchor | undefined> {
  const d = await getDashboard();
  return d.anchors.find((a) => a.id === id) ?? mock.findAnchor(id);
}

export async function getVitality(anchorId: string): Promise<VitalityDay[]> {
  return mock.vitalityHistory(anchorId);
}

export async function getSentinelPolicy(): Promise<SentinelPolicy> {
  return mock.sentinelPolicy;
}

export async function getHyperlocal(): Promise<HyperlocalProfile> {
  return mock.hyperlocalProfile;
}

export async function getInvoices(): Promise<Invoice[]> {
  return mock.invoices;
}

export async function getPanchanga(): Promise<PanchangaCard> {
  return mock.panchanga;
}

export const isDemoMode = !liveEnabled();
