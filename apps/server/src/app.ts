import { createContext } from "@inbox-saas/api/context";
import { createAppRouter } from "@inbox-saas/api/routers/index";
import { createV1App } from "@inbox-saas/api/v1";
import { createAuth } from "@inbox-saas/auth";
import type { Database } from "@inbox-saas/db";
import type { TenantCredentialCipher } from "@inbox-saas/product";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { createAuthMiddleware, type BetterAuthInstance } from "evlog/better-auth";
import { createFsDrain } from "evlog/fs";
import { evlog, type EvlogVariables } from "evlog/hono";
import { Hono } from "hono";

type CreateAppOptions = {
  database: Database;
  authInstance: ReturnType<typeof createAuth>;
  credentialCipher: TenantCredentialCipher;
};

export function createApp({ database, authInstance, credentialCipher }: CreateAppOptions) {
  const appRouter = createAppRouter(database);
  // SAFETY: authInstance is constructed internally by createAuth; this cast only bridges the
  // incompatible Better Auth SDK type boundary required by evlog and does not trust request input.
  const identifyUser = createAuthMiddleware(authInstance as BetterAuthInstance, {
    exclude: ["/api/auth/**", "/api/v1/**"],
    maskEmail: true,
  });
  const apiHandler = new OpenAPIHandler(appRouter, {
    plugins: [
      new OpenAPIReferencePlugin({
        schemaConverters: [new ZodToJsonSchemaConverter()],
      }),
    ],
    interceptors: [
      onError((error) => {
        console.error(error);
      }),
    ],
  });
  const rpcHandler = new RPCHandler(appRouter, {
    interceptors: [
      onError((error) => {
        console.error(error);
      }),
    ],
  });
  const app = new Hono<EvlogVariables>();

  app.use(evlog({ drain: process.env.NODE_ENV === "production" ? undefined : createFsDrain() }));
  app.route("/api/v1", createV1App(database, credentialCipher));
  app.use("*", async (c, next) => {
    await identifyUser(c.get("log"), c.req.raw.headers, c.req.path);
    await next();
  });

  app.on(["POST", "GET"], "/api/auth/*", (c) => authInstance.handler(c.req.raw));

  app.use("/*", async (c, next) => {
    const context = await createContext({ authInstance, context: c });

    const rpcResult = await rpcHandler.handle(c.req.raw, {
      prefix: "/rpc",
      context,
    });

    if (rpcResult.matched) {
      return c.newResponse(rpcResult.response.body, rpcResult.response);
    }

    const apiResult = await apiHandler.handle(c.req.raw, {
      prefix: "/api-reference",
      context,
    });

    if (apiResult.matched) {
      return c.newResponse(apiResult.response.body, apiResult.response);
    }

    await next();
  });

  app.get("/", (c) => c.text("OK"));

  return app;
}
