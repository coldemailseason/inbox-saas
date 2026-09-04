import { describe, expect, it } from "vitest";

import { MicrosoftWorkLimiter } from "../../src/microsoft-work-limiter.js";

describe("MicrosoftWorkLimiter", () => {
  it("allows three permits for one organization and blocks a fourth", async () => {
    const limiter = new MicrosoftWorkLimiter();
    const releases = await Promise.all([
      limiter.acquire("organization-1"),
      limiter.acquire("organization-1"),
      limiter.acquire("organization-1"),
    ]);
    const fourth = limiter.acquire("organization-1");
    let fourthAcquired = false;
    void fourth.then(() => {
      fourthAcquired = true;
    });

    await Promise.resolve();
    expect(fourthAcquired).toBe(false);

    releases[0]?.();
    await expect(fourth).resolves.toEqual(expect.any(Function));
  });

  it("allows five permits globally and blocks a sixth", async () => {
    const limiter = new MicrosoftWorkLimiter();
    const releases = await Promise.all(
      Array.from({ length: 5 }, (_, index) => limiter.acquire(`organization-${index}`)),
    );
    const sixth = limiter.acquire("organization-6");
    let sixthAcquired = false;
    void sixth.then(() => {
      sixthAcquired = true;
    });

    await Promise.resolve();
    expect(sixthAcquired).toBe(false);

    releases[0]?.();
    await expect(sixth).resolves.toEqual(expect.any(Function));
  });

  it("wakes a blocked waiter after a permit is released", async () => {
    const limiter = new MicrosoftWorkLimiter();
    const releases = await Promise.all([
      limiter.acquire("organization-1"),
      limiter.acquire("organization-1"),
      limiter.acquire("organization-1"),
    ]);
    const waitingPermit = limiter.acquire("organization-1");

    releases[0]?.();
    await expect(waitingPermit).resolves.toEqual(expect.any(Function));
  });

  it("makes release idempotent", async () => {
    const limiter = new MicrosoftWorkLimiter();
    const release = await limiter.acquire("organization-1");

    release();
    release();

    await expect(limiter.acquire("organization-1")).resolves.toEqual(expect.any(Function));
  });
});
