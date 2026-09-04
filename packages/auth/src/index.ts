import { createDb, type Database } from "@inbox-saas/db";
import * as schema from "@inbox-saas/db/schema/auth";
import { env } from "@inbox-saas/env/server";
import { polar, checkout, portal } from "@polar-sh/better-auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { polarClient } from "./lib/payments";

export function createAuth(db: Database = createDb()) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: schema,
      transaction: true,
    }),
    emailAndPassword: {
      enabled: true,
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    user: {
      additionalFields: {
        initialOrganizationName: {
          type: "string",
          required: true,
          returned: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const initialOrganizationName =
              typeof user.initialOrganizationName === "string"
                ? user.initialOrganizationName.trim()
                : "";

            if (initialOrganizationName.length < 2 || initialOrganizationName.length > 100) {
              return false;
            }

            return { data: { ...user, initialOrganizationName } };
          },
        },
      },
    },
    plugins: [
      polar({
        client: polarClient,
        use: [
          checkout({
            products: [
              {
                productId: "92d6c0ee-951c-4376-8076-38caf36bf558",
                slug: "pro",
              },
            ],
            successUrl: env.POLAR_SUCCESS_URL,
            authenticatedUsersOnly: true,
          }),
          portal(),
        ],
      }),
    ],
  });
}

export const auth = createAuth();
