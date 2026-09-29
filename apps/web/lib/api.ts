import { bearerForSession } from "./session";

const API = process.env.KSHEMA_API_BASE_URL || "";

/** Call the Fastify API as the current session user. Server-only. */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const bearer = bearerForSession();
  const headers = new Headers(init?.headers);
  if (bearer) headers.set("authorization", "Bearer " + bearer);
  headers.set("content-type", "application/json");
  return fetch(API + path, { ...init, headers, cache: "no-store" });
}
