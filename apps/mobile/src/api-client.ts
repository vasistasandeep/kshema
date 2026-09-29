/**
 * Mobile API client for the Kshema backend.
 *
 * Talks to the Fastify API for the real end-to-end flow: dev login (mints a
 * real session), the Observer dashboard, and incident open/resolve. On the
 * Android emulator the host API is reachable at 10.0.2.2; a physical device or
 * a custom base URL can override via EXPO_PUBLIC_API_BASE_URL.
 *
 * A single in-memory access token is held for the session. The private key
 * never transits (R1.8) — only the public key is sent at registration.
 */
import Constants from "expo-constants";
import type { AnchorWellBeing } from "@kshema/types";

const DEFAULT_BASE =
  (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)?.apiBaseUrl ??
  process.env.EXPO_PUBLIC_API_BASE_URL ??
  "http://10.0.2.2:3001";

let accessToken: string | null = null;
let currentUserId: string | null = null;

export function getApiBaseUrl(): string {
  return DEFAULT_BASE.replace(/\/$/, "");
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getCurrentUserId(): string | null {
  return currentUserId;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (accessToken) headers.authorization = "Bearer " + accessToken;
  const res = await fetch(getApiBaseUrl() + path, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("API " + res.status + " " + path + " " + text);
  }
  return (await res.json()) as T;
}

export interface DevLoginResult { userId: string; accessToken: string; }

/** Dev login: mint a real session for a phone (non-production API). */
export async function devLogin(phone: string, preferredName?: string, clientPublicKeyPem?: string): Promise<DevLoginResult> {
  const body: Record<string, unknown> = { phone, timezone: "Asia/Kolkata" };
  if (preferredName) body.preferredName = preferredName;
  if (clientPublicKeyPem) body.clientPublicKeyPem = clientPublicKeyPem;
  const r = await req<DevLoginResult>("/api/v1/auth/dev/login", { method: "POST", body: JSON.stringify(body) });
  accessToken = r.accessToken;
  currentUserId = r.userId;
  return r;
}

export function clearSession(): void {
  accessToken = null;
  currentUserId = null;
}

export type { AnchorWellBeing };

/** Observer dashboard for the current session (R15). */
export async function fetchDashboard(): Promise<{ anchors: AnchorWellBeing[] }> {
  return req<{ anchors: AnchorWellBeing[] }>("/api/v1/observer/dashboard");
}

/** Send a passive telemetry heartbeat (confirms life; R5.2). */
export async function sendHeartbeat(input: { screenUnlock?: boolean; stepDelta?: number; batteryPercent?: number; chargerConnected?: boolean }): Promise<void> {
  await req("/api/v1/telemetry/heartbeat", {
    method: "POST",
    body: JSON.stringify({
      screenUnlock: input.screenUnlock ?? true,
      stepDelta: input.stepDelta ?? 0,
      batteryPercent: input.batteryPercent ?? 80,
      chargerConnected: input.chargerConnected ?? false,
      capturedAt: new Date().toISOString(),
    }),
  }).catch(() => { /* heartbeat is best-effort */ });
}
