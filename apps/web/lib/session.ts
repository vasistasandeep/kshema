import crypto from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@kshema/database";

/**
 * Server-side session auth for the web app.
 *
 * A session is an HS256 JWT (same dev secret the Fastify API verifies with)
 * stored in an httpOnly cookie. login() upserts a real User in Postgres for the
 * phone and mints the token; getSession() reads + verifies the cookie. This is
 * the production-shaped session (OTP UI drives it); the dev environment skips
 * the SMS round-trip by trusting the verified phone.
 */
const JWT_SECRET = process.env.KSHEMA_JWT_SECRET || "dev-insecure-jwt-secret-change-me";
const COOKIE = "kshema_session";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlJson(o: unknown): string { return b64url(JSON.stringify(o)); }

export function signToken(sub: string, channel = "WEB"): string {
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64urlJson({ sub, channel, iat: now, exp: now + 7 * 24 * 3600 });
  const data = header + "." + payload;
  const sig = b64url(crypto.createHmac("sha256", JWT_SECRET).update(data).digest());
  return data + "." + sig;
}

export function verifyToken(token: string): { sub: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = b64url(crypto.createHmac("sha256", JWT_SECRET).update(h + "." + p).digest());
  if (s !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { sub: payload.sub };
  } catch { return null; }
}

/** A stable dev RSA public key PEM so otp/verify-style upserts have a value. */
const DEV_PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\nMFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBALc3\n-----END PUBLIC KEY-----\n";

/** Upsert a real User for the phone and return its id. */
export async function upsertUser(phone: string, preferredName?: string, timezone = "Asia/Kolkata"): Promise<string> {
  const user = await prisma.user.upsert({
    where: { phone },
    create: { phone, publicKeyPem: DEV_PUBLIC_KEY_PEM, timezone, ...(preferredName ? { preferredName } : {}) },
    update: { ...(preferredName ? { preferredName } : {}) },
    select: { id: true },
  });
  return user.id;
}

export async function setSessionCookie(userId: string): Promise<void> {
  cookies().set(COOKIE, signToken(userId), {
    httpOnly: true, sameSite: "lax", path: "/",
    maxAge: 7 * 24 * 3600,
  });
}

export function clearSessionCookie(): void {
  cookies().delete(COOKIE);
}

/** Read the current session user id from the cookie, or a demo fallback. */
export function getSessionUserId(): string | null {
  const c = cookies().get(COOKIE);
  if (c) {
    const v = verifyToken(c.value);
    if (v) return v.sub;
  }
  // Demo fallback: the seeded observer, so the dashboard works before login.
  return process.env.KSHEMA_DEMO_OBSERVER_ID || null;
}

/** Bearer token for calling the API as the current session user. */
export function bearerForSession(): string | null {
  const uid = getSessionUserId();
  return uid ? signToken(uid) : null;
}

/**
 * Resolve the caller's active circle: prefer a circle they founded (MUTUAL with
 * full permissions), else their first membership, else the demo circle.
 */
export async function resolveActiveCircleId(): Promise<string | null> {
  const me = getSessionUserId();
  if (me) {
    const founded = await prisma.circleMember.findFirst({
      where: { userId: me, role: "MUTUAL", canTriggerIVR: true, canAccessBlackBox: true },
      select: { circleId: true },
      orderBy: { id: "desc" },
    });
    if (founded) return founded.circleId;
    const any = await prisma.circleMember.findFirst({ where: { userId: me }, select: { circleId: true }, orderBy: { id: "desc" } });
    if (any) return any.circleId;
  }
  return process.env.KSHEMA_DEMO_CIRCLE_ID || null;
}
