/**
 * Process-global rolling-window rate limiter + concurrency semaphore.
 *
 *   - proactive: at most N acquisitions per W seconds
 *   - reactive:  when 429 is observed, set a cooldown so all callers wait
 *   - concurrency: at most K streams open simultaneously
 *
 * Both queues are strict FIFO and admit exactly one caller per slot.
 */

export interface RateLimiter {
  /** Block until an acquisition slot is available (counts against window). */
  waitIfBlocked(): Promise<void>;
  /** Wait only for the reactive 429 cooldown; does NOT consume a rate slot. */
  waitForCooldown(): Promise<void>;
  /** Grab a concurrency slot; returns a release callback. */
  acquireConcurrencySlot(): Promise<() => void>;
  /** Set a reactive global cooldown (seconds). */
  setBlocked(seconds: number): void;
}

export function createRateLimiter(opts: {
  rateLimit: number;
  windowSec: number;
  maxConcurrency: number;
}): RateLimiter {
  const windowMs = opts.windowSec * 1000;
  const times: number[] = [];
  const waitingOnProactive: Array<() => void> = [];
  let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  let blockedUntilMs = 0;
  let inFlight = 0;
  const waitingOnSemaphore: Array<() => void> = [];

  function pruneTimes(now: number): void {
    const cutoff = now - windowMs;
    while (times.length > 0 && times[0]! <= cutoff) times.shift();
  }

  // Single scheduler — admits waiters in FIFO order and arms at most one
  // timer. Called synchronously on each enqueue, and by its own timer.
  function drainProactive(): void {
    scheduledTimer = null;
    const now = Date.now();
    if (now < blockedUntilMs) {
      scheduledTimer = setTimeout(drainProactive, blockedUntilMs - now);
      return;
    }
    pruneTimes(now);
    while (waitingOnProactive.length > 0 && times.length < opts.rateLimit) {
      times.push(Date.now());
      waitingOnProactive.shift()!();
    }
    if (waitingOnProactive.length > 0 && times.length > 0) {
      const waitMs = Math.max(1, times[0]! + windowMs - Date.now());
      scheduledTimer = setTimeout(drainProactive, waitMs);
    }
  }

  function waitIfBlocked(): Promise<void> {
    return new Promise<void>((resolve) => {
      waitingOnProactive.push(resolve);
      // If no timer is armed, make progress now; otherwise let the scheduled
      // one pick this waiter up in FIFO order.
      if (scheduledTimer === null) drainProactive();
    });
  }

  function waitForCooldown(): Promise<void> {
    const remaining = blockedUntilMs - Date.now();
    if (remaining <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }

  function drainSemaphore(): void {
    while (waitingOnSemaphore.length > 0 && inFlight < opts.maxConcurrency) {
      inFlight++;
      waitingOnSemaphore.shift()!();
    }
  }

  async function acquireConcurrencySlot(): Promise<() => void> {
    // A reactive 429 cooldown must gate even fresh callers that would
    // otherwise pass the FIFO/maxConcurrency check. Without this, a burst
    // arriving right after `setBlocked` slips past the cooldown. Use
    // waitForCooldown (not waitIfBlocked) so this gate doesn't consume a
    // rate slot — that's the caller's responsibility before each fetch.
    await waitForCooldown();
    // Strict FIFO: if anyone is already queued, queue behind them even when
    // inFlight momentarily dipped under maxConcurrency.
    if (waitingOnSemaphore.length === 0 && inFlight < opts.maxConcurrency) {
      inFlight++;
      return makeRelease();
    }
    return new Promise<() => void>((resolve) => {
      waitingOnSemaphore.push(() => resolve(makeRelease()));
    });
  }

  function makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight--;
      drainSemaphore();
    };
  }

  function setBlocked(seconds: number): void {
    const until = Date.now() + seconds * 1000;
    if (until > blockedUntilMs) blockedUntilMs = until;
  }

  return { waitIfBlocked, waitForCooldown, acquireConcurrencySlot, setBlocked };
}
