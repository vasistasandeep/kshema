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

/** Send a passive telemetry heartbeat as the current Anchor (R5.2). A screen
 * unlock or a positive step delta is a confirming signal that clears an open
 * incident (R13.1/R13.2). Returns the ack. */
export async function sendHeartbeat(input?: { screenUnlock?: boolean; stepDelta?: number; battery?: number; charging?: boolean }): Promise<{ id: string; receivedAt: string } | null> {
  const nowIso = new Date().toISOString();
  const body = {
    deviceId: "mobile-" + (getCurrentUserId() ?? "dev"),
    screenUnlocks: (input?.screenUnlock ?? true) ? [nowIso] : [],
    stepDelta: input?.stepDelta ?? 0,
    battery: input?.battery ?? 82,
    chargerState: (input?.charging ? "PLUGGED" : "UNPLUGGED") as "PLUGGED" | "UNPLUGGED",
    capturedAt: nowIso,
  };
  try {
    return await req<{ id: string; receivedAt: string }>("/api/v1/telemetry/heartbeat", { method: "POST", body: JSON.stringify(body) });
  } catch {
    return null;
  }
}

export interface BlackBoxCiphertext {
  boxId: string;
  encryptedPayload: string;
  iv: string;
  authTag: string;
  wrappedKey: string;
  capturedRange: { start: string; end: string };
}

export interface BlackBoxDenied { error: string; message: string; }

export type BlackBoxResult =
  | { ok: true; box: BlackBoxCiphertext }
  | { ok: false; status: number; message: string };

/**
 * Gated Encrypted_Black_Box fetch by anchor (R8.7/8.8/9.3/19.6). Calls the
 * anchor-scoped API route, which resolves the anchor's OPEN incident within a
 * circle the caller belongs to and applies the release gate. Returns the
 * ciphertext on grant (200) or the gate's reason on 403/404. Server-blind: the
 * client receives ciphertext only and never a plaintext or private key.
 */
export async function fetchBlackBox(anchorId: string): Promise<BlackBoxResult> {
  const res = await fetch(getApiBaseUrl() + "/api/v1/anchors/" + encodeURIComponent(anchorId) + "/blackbox", {
    method: "POST",
    headers: accessToken ? { authorization: "Bearer " + accessToken } : {},
  });
  if (res.ok) {
    const box = (await res.json()) as BlackBoxCiphertext;
    return { ok: true, box };
  }
  let message = "Request failed (" + res.status + ")";
  try {
    const j = (await res.json()) as BlackBoxDenied;
    if (j && (j.message || j.error)) message = j.message || j.error;
  } catch { /* keep default */ }
  return { ok: false, status: res.status, message };
}
