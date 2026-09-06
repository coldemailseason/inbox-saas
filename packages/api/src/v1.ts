import type { Database } from "@inbox-saas/db";
import {
  type AccessGrant,
  authenticateApiKey,
  getAccessibleControlPlane,
  getTenantValidationJob,
  startTenantValidation,
  type TenantCredentialCipher,
  type TenantValidationJobDto,
} from "@inbox-saas/product";
import { type Context, Hono } from "hono";
import { z } from "zod";

type V1Env = {
  Variables: {
    grant: AccessGrant;
  };
};

function unauthorized(c: Context<V1Env>) {
  c.header("WWW-Authenticate", "Bearer");
  return c.json({ code: "unauthorized" }, 401);
}

function invalidRequest(c: Context<V1Env>) {
  return c.json({ code: "invalid_request" }, 400);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

const tenantValidationRequestSchema = z.object({
  credentials: z.object({
    email: z
      .string()
      .refine((email) => email.trim().length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)),
    password: z.string().min(1),
  }),
});

type PublicTenantValidationJob = {
  id: TenantValidationJobDto["id"];
  operation: TenantValidationJobDto["operation"];
  status: "processing" | "completed" | "failed";
  failureCode: TenantValidationJobDto["failureCode"];
  retryable: TenantValidationJobDto["retryable"];
  createdAt: TenantValidationJobDto["createdAt"];
  updatedAt: TenantValidationJobDto["updatedAt"];
};

function toPublicTenantValidationJob(job: TenantValidationJobDto): PublicTenantValidationJob {
  let status: "processing" | "completed" | "failed";
  switch (job.state) {
    case "queued":
    case "running":
      status = "processing";
      break;
    case "completed":
      status = "completed";
      break;
    case "failed":
      status = "failed";
      break;
    case "cancelled":
      status = "failed";
      break;
    default:
      throw new Error(`Unknown tenant validation job state: ${job.state}`);
  }

  return {
    id: job.id,
    operation: job.operation,
    status,
    failureCode: job.failureCode,
    retryable: job.retryable,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function createV1App(database: Database, cipher: TenantCredentialCipher) {
  const app = new Hono<V1Env>();

  app.use("*", async (c, next) => {
    const authorization = c.req.header("Authorization");
    const match = authorization && /^Bearer\s+(\S+)$/i.exec(authorization);

    if (!match?.[1]) {
      return unauthorized(c);
    }

    const grant = await authenticateApiKey(database, match[1]);
    if (!grant) {
      return unauthorized(c);
    }

    c.set("grant", grant);
    await next();
  });

  app.get("/workspaces", async (c) => {
    const { workspaces } = await getAccessibleControlPlane(database, [c.var.grant]);
    return c.json({ workspaces });
  });

  app.post("/workspaces/:workspaceId/tenant-connections", async (c) => {
    const idempotencyKey = c.req.header("Idempotency-Key");
    const contentType = c.req.header("Content-Type");
    const workspaceId = c.req.param("workspaceId");
    if (
      !idempotencyKey ||
      idempotencyKey.trim().length === 0 ||
      !contentType ||
      !/^application\/json(?:;|$)/i.test(contentType) ||
      !isUuid(workspaceId)
    ) {
      return invalidRequest(c);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return invalidRequest(c);
    }
    const parsedBody = tenantValidationRequestSchema.safeParse(body);
    if (!parsedBody.success) {
      return invalidRequest(c);
    }

    const result = await startTenantValidation(
      database,
      [c.var.grant],
      {
        credentials: parsedBody.data.credentials,
        idempotencyKey,
        workspaceId,
      },
      cipher,
    );

    if (result.status === "not_found") {
      return c.json({ code: "not_found" }, 404);
    }
    if (result.status === "idempotency_conflict") {
      return c.json({ code: "idempotency_conflict" }, 409);
    }

    c.header("Idempotency-Key", idempotencyKey);
    return c.json(
      { job: toPublicTenantValidationJob(result.job), tenantConnection: result.tenantConnection },
      202,
    );
  });

  app.get("/jobs/:jobId", async (c) => {
    const jobId = c.req.param("jobId");
    if (!isUuid(jobId)) {
      return c.json({ code: "not_found" }, 404);
    }

    const result = await getTenantValidationJob(database, [c.var.grant], jobId);
    if (result.status === "not_found") {
      return c.json({ code: "not_found" }, 404);
    }

    return c.json({
      job: toPublicTenantValidationJob(result.job),
      tenantConnection: result.tenantConnection,
    });
  });

  return app;
}
