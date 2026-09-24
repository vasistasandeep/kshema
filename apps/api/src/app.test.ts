/**
 * Smoke test for the Fastify skeleton (task 3.1).
 *
 * Proves the app boots and answers `/api/v1/health` WITHOUT a live Redis or
 * database: a fake Prisma client and a fake event emitter are injected, and
 * the BullMQ producer's ioredis connection is never created (it is only built
 * when no emitter is injected, and even then connects lazily). This keeps the
 * test hermetic.
 */
import { describe, expect, it, vi } from "vitest";
import { buildApp, type BuildAppOptions } from "./app.js";
import { loadEnv } from "./config/env.js";
import type { EventEmitter, SentinelEventName } from "./plugins/events.js";

function testEnv() {
  return loadEnv({
    NODE_ENV: "test",
    JWT_SECRET: "test-secret",
    WEB_ORIGIN: "http://localhost:3000",
    REDIS_URL: "redis://127.0.0.1:0", // never connected to
    PORT: "0",
  });
}

/** A fake emitter capturing emitted events; no Redis involved. */
function makeFakeEmitter() {
  const events: { name: SentinelEventName; payload: unknown }[] = [];
  const emitter: EventEmitter = {
    emit: vi.fn(async (name, payload) => {
      events.push({ name, payload });
    }),
    close: vi.fn(async () => undefined),
  };
  return { emitter, events };
}

/** Minimal fake Prisma — the health path never touches it. */
const fakePrisma = {
  $disconnect: vi.fn(async () => undefined),
} as unknown as BuildAppOptions["prisma"];

describe("buildApp skeleton", () => {
  it("boots and answers GET /api/v1/health without live Redis/DB", async () => {
    const { emitter } = makeFakeEmitter();
    const app = await buildApp({
      env: testEnv(),
      prisma: fakePrisma,
      eventEmitter: emitter,
      loggerEnabled: false,
    });

    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("ok");
      expect(body.service).toBe("@kshema/api");
      expect(typeof body.time).toBe("string");
    } finally {
      await app.close();
    }
  });

  it("decorates the instance with prisma, events, and the authenticate guard", async () => {
    const { emitter } = makeFakeEmitter();
    const app = await buildApp({
      env: testEnv(),
      prisma: fakePrisma,
      eventEmitter: emitter,
      loggerEnabled: false,
    });

    try {
      expect(app.hasDecorator("prisma")).toBe(true);
      expect(app.hasDecorator("events")).toBe(true);
      expect(app.hasDecorator("authenticate")).toBe(true);
      expect(typeof app.authenticate).toBe("function");
    } finally {
      await app.close();
    }
  });

  it("routes emitted domain events to the injected producer (no live Redis)", async () => {
    const { emitter, events } = makeFakeEmitter();
    const app = await buildApp({
      env: testEnv(),
      prisma: fakePrisma,
      eventEmitter: emitter,
      loggerEnabled: false,
    });

    try {
      await app.events.emit("telemetry.received", { deviceId: "dev-1" });
      expect(events).toHaveLength(1);
      expect(events[0]?.name).toBe("telemetry.received");
    } finally {
      await app.close();
    }
  });

  it("returns 401 from the authenticate guard when no bearer token is present", async () => {
    const { emitter } = makeFakeEmitter();
    const app = await buildApp({
      env: testEnv(),
      prisma: fakePrisma,
      eventEmitter: emitter,
      loggerEnabled: false,
    });
    // Register a throwaway protected route to exercise the guard.
    app.get("/api/v1/_protected", { onRequest: [app.authenticate] }, async () => ({
      ok: true,
    }));

    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/_protected" });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
