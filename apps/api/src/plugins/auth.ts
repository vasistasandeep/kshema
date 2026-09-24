/**
 * JWT bearer auth plugin.
 *
 * Registers `@fastify/jwt` (HS256, secret from env) and exposes an
 * `authenticate` decorator usable as a route `preHandler` / `onRequest` guard.
 * This task only wires the plugin and the guard — the OTP routes that actually
 * *issue* tokens land in task 3.2. Every protected route added later can simply
 * do `{ onRequest: [app.authenticate] }`.
 *
 * The access-token payload carries the authenticated user id and (optionally)
 * the circle role; only public-key material ever transits elsewhere, so no
 * secret/private-key data is embedded here (R1.8).
 */
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";
import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";

export interface AuthPluginOptions {
  jwtSecret: string;
}

/** Shape of the signed JWT access-token payload. */
export interface AccessTokenPayload {
  /** Authenticated user id (Prisma cuid). */
  sub: string;
  /** Login channel the token was issued through. */
  channel?: "MOBILE" | "WEB";
  /**
   * Token type. Access tokens omit this; refresh tokens set `"refresh"` so a
   * refresh token cannot be replayed as a bearer access token.
   */
  typ?: "refresh";
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    user: AccessTokenPayload;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    /** Route guard: verifies the bearer token or replies 401. */
    authenticate: onRequestHookHandler;
  }
}

async function authPlugin(
  app: FastifyInstance,
  opts: AuthPluginOptions,
): Promise<void> {
  await app.register(fastifyJwt, {
    secret: opts.jwtSecret,
    // Tokens are supplied as `Authorization: Bearer <token>`.
    formatUser: (payload) => payload,
  });

  const authenticate: onRequestHookHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    try {
      await request.jwtVerify();
    } catch {
      await reply
        .code(401)
        .send({ error: "Unauthorized", message: "Missing or invalid token" });
    }
  };

  if (!app.hasDecorator("authenticate")) {
    app.decorate("authenticate", authenticate);
  }
}

export default fp(authPlugin, {
  name: "kshema-auth",
});
