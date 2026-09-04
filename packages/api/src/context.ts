import type { createAuth } from "@inbox-saas/auth";
import type { Context as HonoContext } from "hono";

export type CreateContextOptions = {
  authInstance: ReturnType<typeof createAuth>;
  context: HonoContext;
};

export async function createContext({ authInstance, context }: CreateContextOptions) {
  const session = await authInstance.api.getSession({
    headers: context.req.raw.headers,
  });
  return {
    auth: null,
    session,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
