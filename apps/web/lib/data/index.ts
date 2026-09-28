import type {
  DashboardSummary, VitalityDay, SentinelPolicy, HyperlocalProfile,
  Invoice, PanchangaCard, Anchor,
} from "../types";
import * as mock from "../mock/data";

/**
 * Data-access layer. Every UI component reads through these functions. When
 * KSHEMA_API_BASE_URL is set (live mode) they call the Fastify API; otherwise
 * they resolve rich mock data. This keeps the UI identical across modes and
 * makes the app scalable to the real backend without component changes.
 */

const API = process.env.KSHEMA_API_BASE_URL || "";
const DEMO = !API || process.env.NEXT_PUBLIC_DEMO_MODE === "true";

async function apiGet<T>(path: string, fallback: T): Promise<T> {
  if (DEMO) return fallback;
  try {
    const res = await fetch(`${API}${path}`, { cache: "no-store" });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

export async function getDashboard(): Promise<DashboardSummary> {
  return apiGet("/api/v1/observer/dashboard", mock.dashboardSummary);
}

export async function getAnchor(id: string): Promise<Anchor | undefined> {
  const d = await getDashboard();
  return d.anchors.find((a) => a.id === id) ?? mock.findAnchor(id);
}

export async function getVitality(anchorId: string): Promise<VitalityDay[]> {
  return apiGet(`/api/v1/web/vitality/rhythm?anchorId=${anchorId}&days=30`, mock.vitalityHistory(anchorId));
}

export async function getSentinelPolicy(): Promise<SentinelPolicy> {
  return apiGet("/api/v1/observer/sentinel-policy", mock.sentinelPolicy);
}

export async function getHyperlocal(): Promise<HyperlocalProfile> {
  return apiGet("/api/v1/observer/hyperlocal", mock.hyperlocalProfile);
}

export async function getInvoices(): Promise<Invoice[]> {
  return apiGet("/api/v1/web/billing/invoices", mock.invoices);
}

export async function getPanchanga(): Promise<PanchangaCard> {
  return apiGet("/api/v1/panchanga", mock.panchanga);
}

export const isDemoMode = DEMO;
