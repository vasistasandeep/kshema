import type {
  DashboardSummary, VitalityDay, SentinelPolicy, HyperlocalProfile,
  Invoice, PanchangaCard, Anchor,
} from "../types";
import * as mock from "../mock/data";
import { getLiveDashboard, getLiveVitality, liveEnabled } from "./live";

/**
 * Data-access layer. The observer dashboard and vitality history use the live
 * Fastify API when a session exists, falling back to rich mock data otherwise.
 * Policy / hyperlocal / billing use mock data (their observer-facing GET
 * endpoints are managed through the config write flow).
 */
export async function getDashboard(): Promise<DashboardSummary> {
  const live = await getLiveDashboard();
  return live ?? mock.dashboardSummary;
}

export async function getAnchor(id: string): Promise<Anchor | undefined> {
  const d = await getDashboard();
  return d.anchors.find((a) => a.id === id) ?? mock.findAnchor(id);
}

export async function getVitality(anchorId: string): Promise<VitalityDay[]> {
  const live = await getLiveVitality(anchorId);
  return live ?? mock.vitalityHistory(anchorId);
}

export async function getSentinelPolicy(): Promise<SentinelPolicy> { return mock.sentinelPolicy; }
export async function getHyperlocal(): Promise<HyperlocalProfile> { return mock.hyperlocalProfile; }
export async function getInvoices(): Promise<Invoice[]> { return mock.invoices; }
export async function getPanchanga(): Promise<PanchangaCard> { return mock.panchanga; }

export function isDemoMode(): boolean { return !liveEnabled(); }
