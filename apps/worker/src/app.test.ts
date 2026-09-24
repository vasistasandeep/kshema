import { describe, expect, it, vi } from "vitest";

import { buildWorkerApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createRedisConnection } from "./redis.js";
import { QUEUE_NAMES } from "./queues/definitions.js";
import { createEventsQueueProcessor } from "./events/consumers.js";
import type { PrismaClient } from "@kshema/database";

/**
 * A minimal stand-in for the Prisma client. The foundation processors are
 * stubs that never query, so an empty object typed as PrismaClient is enough to
 * satisfy the factory without a live DB.
 */
const fakePrisma = {} as unknown as PrismaClient;

/** Silent logger so tests don't spew stub logs. */
const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * Build a worker app with an injected, lazily-connecting Redis connection so no
 * socket is ever opened. `autorun: false` keeps the workers from starting their
 * blocking Redis loops.
 */
function buildTestApp() {
  const env = loadEnv({ NODE_ENV: "test" });
  const connection = createRedisConnection(env.REDIS_URL);
  const app = buildWorkerApp({
    env,
    prisma: fakePrisma,
    connection,
    logger: silentLogger,
    autorun: false,
  });
  return { app, connection };
}

describe("buildWorkerApp — construction without a live Redis", () => {
  it("constructs the five Sentinel queues", async () => {
    const { app } = buildTestApp();
    try {
      expect(Object.keys(app.queues).sort()).toEqual([...QUEUE_NAMES].sort());
      for (const name of QUEUE_NAMES) {
        expect(app.queues[name].name).toBe(name);
      }
    } finally {
      await app.close();
    }
  });

  it("constructs one worker per queue plus an events consumer", async () => {
    const { app } = buildTestApp();
    try {
      expect(Object.keys(app.workers).sort()).toEqual([...QUEUE_NAMES].sort());
      expect(app.eventsWorker).toBeDefined();
      // The events queue name aligns with what apps/api produces onto.
      expect(app.eventsQueue.name).toBe(app.env.EVENTS_QUEUE_NAME);
    } finally {
      await app.close();
    }
  });

  it("builds and closes cleanly without a reachable Redis", async () => {
    const { app } = buildTestApp();
    await expect(app.close()).resolves.toBeUndefined();
  });

  it("never reaches a ready (live-Redis) connection during construction", async () => {
    const { app, connection } = buildTestApp();
    try {
      // With lazyConnect + autorun:false the connection may begin dialing but
      // must never complete a handshake to a live server in the test env.
      expect(connection.status).not.toBe("ready");
    } finally {
      await app.close();
    }
  });
});

describe("events queue processor routing", () => {
  it("dispatches known events to their handler", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const process = createEventsQueueProcessor({
      "telemetry.received": handler,
      "ghost.received": vi.fn(),
      "incident.resolved": vi.fn(),
      "sos.triggered": vi.fn(),
    });

    await process(
      { name: "telemetry.received", data: { name: "telemetry.received", payload: { deviceId: "d1" } } },
      { prisma: fakePrisma, logger: silentLogger },
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const [event] = handler.mock.calls[0]!;
    expect(event).toEqual({
      name: "telemetry.received",
      payload: { deviceId: "d1" },
    });
  });

  it("ignores unknown events without throwing", async () => {
    const process = createEventsQueueProcessor({
      "telemetry.received": vi.fn(),
      "ghost.received": vi.fn(),
      "incident.resolved": vi.fn(),
      "sos.triggered": vi.fn(),
    });

    await expect(
      process(
        { name: "unknown.event", data: {} },
        { prisma: fakePrisma, logger: silentLogger },
      ),
    ).resolves.toEqual({ ignored: true, event: "unknown.event" });
  });
});
