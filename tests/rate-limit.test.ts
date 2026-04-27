import { describe, expect, test } from "bun:test";
import { createRateLimiter } from "../src/rate-limit.ts";

describe("createRateLimiter", () => {
  test("admits up to rateLimit calls immediately", async () => {
    const rl = createRateLimiter({
      rateLimit: 3,
      windowSec: 60,
      maxConcurrency: 10,
    });
    const start = Date.now();
    await Promise.all([rl.waitIfBlocked(), rl.waitIfBlocked(), rl.waitIfBlocked()]);
    expect(Date.now() - start).toBeLessThan(50);
  });

  test("queues callers beyond rateLimit until window slides", async () => {
    const rl = createRateLimiter({
      rateLimit: 1,
      windowSec: 0.2,
      maxConcurrency: 10,
    });
    await rl.waitIfBlocked();
    const start = Date.now();
    await rl.waitIfBlocked();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });

  test("waitForCooldown resolves immediately when not blocked", async () => {
    const rl = createRateLimiter({
      rateLimit: 1,
      windowSec: 60,
      maxConcurrency: 1,
    });
    const start = Date.now();
    await rl.waitForCooldown();
    expect(Date.now() - start).toBeLessThan(50);
  });

  test("setBlocked makes waitForCooldown wait", async () => {
    const rl = createRateLimiter({
      rateLimit: 10,
      windowSec: 60,
      maxConcurrency: 10,
    });
    rl.setBlocked(0.2);
    const start = Date.now();
    await rl.waitForCooldown();
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
  });

  test("setBlocked only extends; never shortens", async () => {
    const rl = createRateLimiter({
      rateLimit: 10,
      windowSec: 60,
      maxConcurrency: 10,
    });
    rl.setBlocked(2);
    rl.setBlocked(0.05); // shorter — should be ignored
    const start = Date.now();
    // Don't actually wait 2s in tests — just sanity-check that the cooldown
    // hasn't been shortened to ~50ms by polling once after a small delay.
    await new Promise((r) => setTimeout(r, 100));
    // setBlocked(0.05) is older than 100ms; if it had won, cooldown done.
    // The longer 2s cooldown should still be active.
    let resolved = false;
    rl.waitForCooldown().then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false);
    void start;
  });

  test("acquireConcurrencySlot enforces max concurrency", async () => {
    const rl = createRateLimiter({
      rateLimit: 100,
      windowSec: 60,
      maxConcurrency: 2,
    });
    const r1 = await rl.acquireConcurrencySlot();
    const r2 = await rl.acquireConcurrencySlot();

    let acquired3 = false;
    const p3 = rl.acquireConcurrencySlot().then((rel) => {
      acquired3 = true;
      return rel;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(acquired3).toBe(false);

    r1();
    const r3 = await p3;
    expect(acquired3).toBe(true);
    r2();
    r3();
  });

  test("release is idempotent", async () => {
    const rl = createRateLimiter({
      rateLimit: 100,
      windowSec: 60,
      maxConcurrency: 1,
    });
    const r1 = await rl.acquireConcurrencySlot();
    r1();
    r1(); // double-release must not pop a phantom slot

    // A second acquire should succeed without a third release leaking.
    const r2 = await rl.acquireConcurrencySlot();

    let acquired3 = false;
    rl.acquireConcurrencySlot().then(() => {
      acquired3 = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(acquired3).toBe(false);
    r2();
  });
});
