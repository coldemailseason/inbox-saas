import { db, type Database } from "@inbox-saas/db";
import { getAccessibleControlPlane, getUserAccessGrants } from "@inbox-saas/product";

import type { RouterClient } from "@orpc/server";

import { protectedProcedure, publicProcedure } from "../index";

export function createAppRouter(database: Database) {
  return {
    healthCheck: publicProcedure.handler(() => {
      return "OK";
    }),
    controlPlane: protectedProcedure.handler(async ({ context }) => {
      const grants = await getUserAccessGrants(database, context.session.user.id);

      return getAccessibleControlPlane(database, grants);
    }),
  };
}

export const appRouter = createAppRouter(db);
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
