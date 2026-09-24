/**
 * Web Observer dashboard stream (task 20.2 — R28.5, R28.8, R28.9).
 *
 * Mounted under `/api/v1`, so the effective paths are:
 *   - `GET /api/v1/web/dashboard/stream`   Server-Sent Events (text/event-stream)
 *   - `GET /api/v1/web/dashboard/ws`       WebSocket-fallback snapshot (JSON)
 *
 * ---------------------------------------------------------------------------
 * WHY THE STREAM LIVES ON THE PERSISTENT FASTIFY SERVICE. The Observer web
 * dashboard connects this stream DIRECTLY to the always-on Fastify deployment
 * over CORS — never through a Next.js serverless route — because serverless
 * function execution timeouts would sever a long-lived SSE connection, whereas
 * the persistent service holds it open indefinitely (design "Observer web
 * portal"). CORS for the `apps/web` origin is configured in `buildApp`.
 *
 * SSE (`/web/dashboard/stream`, R28.5, R28.9). A `text/event-stream` channel
 * that pushes the per-Anchor well-being snapshot (state, active
 * `IncidentStage`, verified-morning timestamp) plus the dual-timezone tick, so
 * Ambient Desk Mode refreshes silently with NO page reload. The handler:
 *   1. hijacks the reply and writes SSE headers;
 *   2. emits an initial `snapshot` frame immediately;
 *   3. re-emits a fresh `snapshot` frame every `intervalMs` (default 15s) plus
 *      periodic `:keep-alive` comments so intermediaries don't drop the idle
 *      connection;
 *   4. tears the timer down on client disconnect / server close.
 * Each frame is the SAME `DashboardSnapshot` shape the WS fallback returns, so
 * the two transports never diverge.
 *
 * AUTH OVER SSE. A browser `EventSource` cannot set an `Authorization` header,
 * so this route accepts the bearer token EITHER in the `Authorization` header
 * (WebSocket/fetch clients) OR as a `?token=` query parameter (EventSource).
 * The token is verified with the same `app.jwt` used everywhere; an anonymous
 * or invalid caller is rejected `401` before the stream opens.
 *
 * WS FALLBACK (`/web/dashboard/ws`, design "interactive fallback"). A true
 * WebSocket upgrade needs a WS transport dependency this service does not carry
 * yet. Rather than fail, this endpoint returns the CURRENT
 * `DashboardSnapshot` as JSON — the exact frame a WS "snapshot" message would
 * carry — so a WS gateway (or a client polling the fallback) has a
 * bidirectional-friendly shim with identical semantics. When a WS transport is
 * added later it upgrades this same path and reuses `buildDashboardSnapshot`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { Readable } from "node:stream";
import { DashboardSnapshotSchema } from "@kshema/types";
import type { AccessTokenPayload } from "../plugins/auth.js";
import { buildDashboardSnapshot } from "../services/web-dashboard.js";

/** Query for both endpoints: optional `?token=` for `EventSource` auth. */
const DashboardStreamQuerySchema = z
  .object({
    token: z.string().trim().min(1).optional(),
  })
  .strict();

const UnauthorizedSchema = z
  .object({ error: z.literal("Unauthorized"), message: z.string().min(1) })
  .strict();

export interface WebDashboardRouteDeps {
  /** SSE snapshot cadence in ms (default 15s). Tests use a short interval. */
  intervalMs?: number;
  /** Keep-alive comment cadence in ms (default 20s). */
  keepAliveMs?: number;
  /** Clock injection for deterministic dual-timezone ticks in tests. */
  now?: () => number;
  /**
   * Max frames to emit before the SSE handler completes on its own. Unbounded
   * (`Infinity`) in production; tests set a small number so `app.inject`
   * returns the accumulated stream body instead of hanging on an open socket.
   */
  maxFrames?: number;
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_KEEPALIVE_MS = 20_000;

export async function webDashboardRoutes(
  app: FastifyInstance,
  deps: WebDashboardRouteDeps = {},
): Promise<void> {
  const {
    intervalMs = DEFAULT_INTERVAL_MS,
    keepAliveMs = DEFAULT_KEEPALIVE_MS,
    now = Date.now,
    maxFrames = Number.POSITIVE_INFINITY,
  } = deps;

  const typed = app.withTypeProvider<ZodTypeProvider>();

  // Live SSE stream cleanups, torn down once when the server closes (registered
  // here at route setup — NOT per-request, which would fail once listening).
  const streams = new Set<() => void>();
  app.addHook("onClose", async () => {
    for (const teardown of streams) teardown();
    streams.clear();
  });

  /**
   * Resolve the authenticated user id from either the bearer header or the
   * `?token=` query param. Returns `undefined` when neither yields a valid
   * token (the caller then replies 401).
   */
  function resolveUserId(
    request: FastifyRequest,
    queryToken: string | undefined,
  ): string | undefined {
    // 1. Authorization: Bearer <token>
    const header = request.headers.authorization;
    const raw =
      header && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length).trim()
        : queryToken;
    if (!raw) return undefined;
    try {
      const payload = app.jwt.verify<AccessTokenPayload>(raw);
      // A refresh token must not open a stream.
      if (payload.typ === "refresh") return undefined;
      return payload.sub;
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // GET /web/dashboard/stream — Server-Sent Events (R28.5, R28.8, R28.9).
  // -------------------------------------------------------------------------
  typed.get(
    "/web/dashboard/stream",
    {
      schema: {
        querystring: DashboardStreamQuerySchema,
        // No response schema: the reply body is a streamed text/event-stream.
      },
    },
    async (request, reply) => {
      const userId = resolveUserId(request, request.query.token);
      if (!userId) {
        return reply.code(401).send({
          error: "Unauthorized" as const,
          message: "A valid session token is required to open the dashboard stream.",
        });
      }

      // Stream the SSE protocol as a Node Readable body. Fastify pipes it to
      // the socket and keeps the connection open until the stream ends; this
      // works uniformly under a real server AND `app.inject` (which drains the
      // stream into the response payload), so the endpoint is directly
      // testable without hijacking the socket.
      const stream = new Readable({ read() {} });

      let closed = false;
      let framesSent = 0;
      let snapshotTimer: NodeJS.Timeout | undefined;
      let keepAliveTimer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (snapshotTimer) clearInterval(snapshotTimer);
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        stream.push(null); // end the SSE stream
      };

      const emitSnapshot = async () => {
        if (closed) return;
        try {
          const snapshot = await buildDashboardSnapshot(
            app,
            userId,
            new Date(now()),
          );
          if (closed) return;
          stream.push(`event: snapshot\n`);
          stream.push(`data: ${JSON.stringify(snapshot)}\n\n`);
          framesSent += 1;
          if (framesSent >= maxFrames) {
            cleanup();
          }
        } catch (err) {
          // A transient read error shouldn't kill the stream; log and continue.
          request.log.warn({ err }, "dashboard stream snapshot failed");
        }
      };

      // Tear down when the client goes away. (Server-close teardown is handled
      // once at route registration below, not per-request.)
      request.raw.on("close", cleanup);
      streams.add(cleanup);
      stream.on("close", () => streams.delete(cleanup));

      reply
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache, no-transform")
        .header("Connection", "keep-alive")
        // Disable proxy buffering so frames flush promptly.
        .header("X-Accel-Buffering", "no");

      // Initial frame, then periodic refresh + keep-alive. Skip the timers when
      // the stream is already closed (e.g. `maxFrames` reached on the initial
      // frame, as in tests).
      await emitSnapshot();
      if (!closed) {
        snapshotTimer = setInterval(() => {
          void emitSnapshot();
        }, intervalMs);
        keepAliveTimer = setInterval(() => {
          if (!closed) stream.push(`: keep-alive\n\n`);
        }, keepAliveMs);
        // Don't keep the event loop alive solely for these timers.
        snapshotTimer.unref?.();
        keepAliveTimer.unref?.();
      }

      return reply.send(stream);
    },
  );

  // -------------------------------------------------------------------------
  // GET /web/dashboard/ws — WebSocket-fallback snapshot (design fallback).
  // Returns the current DashboardSnapshot as JSON: the exact frame a WS
  // "snapshot" message carries. A WS transport later upgrades this same path.
  // -------------------------------------------------------------------------
  typed.get(
    "/web/dashboard/ws",
    {
      schema: {
        querystring: DashboardStreamQuerySchema,
        response: {
          200: DashboardSnapshotSchema,
          401: UnauthorizedSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = resolveUserId(request, request.query.token);
      if (!userId) {
        return reply.code(401).send({
          error: "Unauthorized" as const,
          message: "A valid session token is required for the dashboard channel.",
        });
      }
      return buildDashboardSnapshot(app, userId, new Date(now()));
    },
  );
}
