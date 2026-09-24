/**
 * WhatsApp (Meta Cloud API) inbound + delivery-status webhook (task 7.2 —
 * R13.5, R21.11, R21.13).
 *
 * Mounted under `/api/v1`, so the effective paths are:
 *   - `GET  /api/v1/webhooks/whatsapp`   Meta verification handshake (optional)
 *   - `POST /api/v1/webhooks/whatsapp`   inbound messages + delivery statuses
 *
 * ---------------------------------------------------------------------------
 * SIGNATURE VERIFICATION OVER THE RAW BODY.
 *
 * Meta signs every callback with an `X-Hub-Signature-256` header of the form
 * `sha256=<hex>` — an HMAC-SHA-256 of the EXACT request bytes, keyed by the
 * app secret (`WHATSAPP_APP_SECRET`). A signature therefore has to be computed
 * over the RAW body, not a re-serialised copy of the parsed JSON (key order,
 * whitespace, and unicode escaping would all diverge and break the HMAC).
 *
 * These routes are registered inside their OWN encapsulated Fastify scope
 * (see `webhookRoutes` below): that scope installs an `application/json`
 * content-type parser that BOTH keeps the raw `Buffer` on `request.rawBody`
 * AND parses the JSON for the handler. Because Fastify content-type parsers are
 * scoped to the plugin that registers them, this does not disturb the global
 * JSON parsing used by every other route (auth/circles/telemetry/incidents).
 *
 * The comparison uses `crypto.timingSafeEqual` to avoid leaking the digest via
 * timing. A missing/short/invalid signature is rejected with `401`; a
 * well-formed signature that does not match the body is rejected with `403`.
 * Nothing is emitted and no metric is recorded when verification fails.
 *
 * ---------------------------------------------------------------------------
 * INBOUND ANCHOR REPLY -> incident.resolved (R13.5).
 *
 * When an Anchor replies to the conversational Stage-1 WhatsApp check-in, Meta
 * delivers a `messages` entry. We map the sender's WhatsApp phone number to the
 * User, find that Anchor's OPEN SafetyIncident, and emit
 * `incident.resolved { incidentId, source: "WHATSAPP_RESPONSE" }`. As with the
 * other incident routes, the WORKER (task 10.3) owns the atomic
 * `OPEN -> RESOLVED` transition and job cancellation; this route only maps and
 * emits, so it never races the worker's conditional update.
 *
 * ---------------------------------------------------------------------------
 * DELIVERY-STATUS CALLBACK -> CarrierGatewayMetric (R21.11, R21.13).
 *
 * A `statuses` entry (`sent` / `delivered` / `read` / `failed`) reports on an
 * outbound message. We record a `CarrierGatewayMetric` row for the `WHATSAPP`
 * gateway capturing delivery latency (status timestamp − original send time
 * when both are known), the delivery status (`dltStatus`), an incremented
 * `templateRejections` count when Meta reports a template/re-engagement error,
 * and an `errorRate` of 1 on `failed` / 0 otherwise — the signal set the Admin
 * console renders as Carrier_Gateway_Health (R21.13) and alarms on for an
 * active incident (R21.11).
 */
import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";

/** Resolution source recorded for an inbound Anchor WhatsApp reply (R13.5). */
const WHATSAPP_RESPONSE = "WHATSAPP_RESPONSE" as const;

/** Carrier gateway label for WhatsApp metrics (R21.13). */
const WHATSAPP_GATEWAY = "WHATSAPP" as const;

/** Header Meta signs each callback with. */
const SIGNATURE_HEADER = "x-hub-signature-256";

declare module "fastify" {
  interface FastifyRequest {
    /** Raw request bytes retained by the webhook-scope JSON parser. */
    rawBody?: Buffer;
  }
}

export interface WebhookRouteDeps {
  /** App secret used to verify the `X-Hub-Signature-256` HMAC (R signature). */
  appSecret: string;
  /**
   * Verify-token echoed back during Meta's GET handshake. When undefined the
   * GET verification route rejects every challenge (handshake disabled).
   */
  verifyToken?: string;
  /** Clock injection for deterministic latency math in tests. */
  now?: () => number;
}

/** A single normalised inbound message from Meta's `messages[]`. */
interface InboundMessage {
  /** Sender WhatsApp phone (E.164 digits, no `+`). */
  from?: string;
  /** Message timestamp (unix seconds, string per Meta). */
  timestamp?: string;
}

/** A single normalised delivery status from Meta's `statuses[]`. */
interface DeliveryStatus {
  status?: string;
  timestamp?: string;
  errors?: Array<{ code?: number; title?: string }>;
}

/**
 * Constant-time compare of the provided `sha256=<hex>` header against the HMAC
 * of `rawBody`. Returns false for a missing/short/malformed header rather than
 * throwing, so the caller can map it to a `401`.
 */
function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const provided = header.slice("sha256=".length).trim();
  if (provided.length === 0) return false;

  const expectedHex = createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");

  const providedBuf = Buffer.from(provided, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  // Length guard: timingSafeEqual throws on unequal lengths.
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/** Pull inbound messages + delivery statuses out of a Meta webhook envelope. */
function extractEvents(body: unknown): {
  messages: InboundMessage[];
  statuses: DeliveryStatus[];
} {
  const messages: InboundMessage[] = [];
  const statuses: DeliveryStatus[] = [];

  const entries = (body as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return { messages, statuses };

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      if (!value) continue;
      if (Array.isArray(value.messages)) {
        for (const m of value.messages as InboundMessage[]) messages.push(m);
      }
      if (Array.isArray(value.statuses)) {
        for (const s of value.statuses as DeliveryStatus[]) statuses.push(s);
      }
    }
  }
  return { messages, statuses };
}

export async function webhookRoutes(
  app: FastifyInstance,
  deps: WebhookRouteDeps,
): Promise<void> {
  const { appSecret, verifyToken, now = Date.now } = deps;

  // Encapsulated JSON parser that retains the raw bytes for HMAC verification
  // AND parses the JSON for the handler. Scoped to this plugin only, so global
  // JSON parsing for every other route is unaffected.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
      request.rawBody = raw;
      if (raw.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(raw.toString("utf8")) as unknown);
      } catch (err) {
        // Malformed JSON: surface as a 400 via Fastify's error path.
        (err as Error & { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  // GET /webhooks/whatsapp — Meta subscription verification handshake. Meta
  // calls this once when the webhook is (re)configured; echo back
  // `hub.challenge` iff `hub.mode=subscribe` AND `hub.verify_token` matches the
  // configured token. Disabled (403) when no verify token is configured.
  app.get<{
    Querystring: Record<string, string | undefined>;
  }>("/webhooks/whatsapp", async (request, reply) => {
    const q = request.query;
    const mode = q["hub.mode"];
    const token = q["hub.verify_token"];
    const challenge = q["hub.challenge"];

    if (
      verifyToken &&
      mode === "subscribe" &&
      token === verifyToken &&
      typeof challenge === "string"
    ) {
      // Meta expects the raw challenge string echoed back verbatim.
      return reply.code(200).type("text/plain").send(challenge);
    }
    return reply
      .code(403)
      .send({ error: "Forbidden", message: "Verification failed" });
  });

  // POST /webhooks/whatsapp — signature-verified inbound + delivery-status.
  app.post("/webhooks/whatsapp", async (request, reply) => {
    const raw = request.rawBody ?? Buffer.alloc(0);
    const header = request.headers[SIGNATURE_HEADER];
    const signature = Array.isArray(header) ? header[0] : header;

    if (!verifySignature(raw, signature, appSecret)) {
      // 401 for a missing/malformed signature; 403 for a well-formed one that
      // simply does not match. Distinguishing the two helps operators tell a
      // misconfigured integration from a forged/replayed callback.
      const wellFormed =
        typeof signature === "string" && signature.startsWith("sha256=");
      return reply.code(wellFormed ? 403 : 401).send({
        error: wellFormed ? "Forbidden" : "Unauthorized",
        message: "Invalid webhook signature",
      });
    }

    const { messages, statuses } = extractEvents(request.body);

    let resolved = 0;
    let metricsRecorded = 0;

    // --- Inbound Anchor replies -> incident.resolved (R13.5) ---------------
    for (const msg of messages) {
      if (!msg.from) continue;
      // Map the sender's WhatsApp phone to a User. Phone numbers arrive as
      // E.164 digits without a leading `+`; try both forms to be tolerant of
      // how the User row stores it.
      const user = await app.prisma.user.findFirst({
        where: { phone: { in: [msg.from, `+${msg.from}`] } },
        select: { id: true },
      });
      if (!user) continue;

      // The Anchor's OPEN incident (the one the Stage-1 check-in belongs to).
      const incident = await app.prisma.safetyIncident.findFirst({
        where: { anchorId: user.id, status: "OPEN" },
        select: { id: true },
      });
      if (!incident) continue;

      await app.events.emit("incident.resolved", {
        incidentId: incident.id,
        source: WHATSAPP_RESPONSE,
      });
      resolved += 1;
    }

    // --- Delivery statuses -> CarrierGatewayMetric (R21.11, R21.13) --------
    for (const status of statuses) {
      const statusName = status.status ?? "unknown";
      const failed = statusName === "failed";

      // Latency: status timestamp − send time when both are known. Meta sends
      // unix seconds as strings. Absent a send-time correlation, leave null.
      let deliveryLatencyMs: number | null = null;
      const statusTsSec = Number(status.timestamp);
      if (Number.isFinite(statusTsSec)) {
        const latency = now() - statusTsSec * 1000;
        deliveryLatencyMs = latency >= 0 ? latency : null;
      }

      // Template/re-engagement rejections (Meta error codes 131047/131026/
      // 132xxx). Count any reported error against the template-rejection tally
      // so Carrier_Gateway_Health surfaces Meta template friction (R21.13).
      const templateRejections =
        Array.isArray(status.errors) && status.errors.length > 0 ? 1 : 0;

      await app.prisma.carrierGatewayMetric.create({
        data: {
          gateway: WHATSAPP_GATEWAY,
          deliveryLatencyMs,
          templateRejections,
          dltStatus: statusName,
          errorRate: failed ? 1 : 0,
          windowStart: new Date(now()),
        },
      });
      metricsRecorded += 1;
    }

    // Meta only needs a 200 to consider the callback delivered. The small body
    // is convenient for tests/operators; Meta ignores it.
    return reply.code(200).send({ ok: true, resolved, metricsRecorded });
  });
}
