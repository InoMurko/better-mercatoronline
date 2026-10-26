/** A tiny semaphore: at most `max` tasks run at once, the rest wait in order. */
export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(readonly max: number) {
    if (max < 1) throw new Error("Limiter needs max >= 1");
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    // a waiter inherits the slot of the task that finishes – so `active` can never exceed `max`
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    else this.active++;
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
  get running() {
    return this.active;
  }
}

/** Run `fn` over `items` with at most `max` in flight; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], max: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const limiter = new Limiter(max);
  return Promise.all(items.map((item, i) => limiter.run(() => fn(item, i))));
}

/**
 * One-at-a-time lock (cart writes, checkout): calls run in the order they were made.
 * A call that waits longer than `waitMs` for its turn gives up with an error instead of queueing forever
 * (it never runs late – the task is skipped once it has given up).
 */
export class Mutex {
  private chain: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  constructor(readonly waitMs = Infinity) {}
  get busy() {
    return this.waiting > 0;
  }
  lock<T>(task: () => Promise<T>): Promise<T> {
    this.waiting++;
    let gaveUp = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const turn = this.chain.then(() => {
      clearTimeout(timer);
      if (gaveUp) throw new Error("skipped – gave up waiting");
      return task();
    });
    this.chain = turn.catch(() => undefined);
    const result = Number.isFinite(this.waitMs)
      ? Promise.race([
          turn,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              gaveUp = true;
              reject(new Error(`the cart is busy with another task for over ${Math.round(this.waitMs / 60_000)} min – try again later`));
            }, this.waitMs);
          }),
        ])
      : turn;
    return result.finally(() => this.waiting--);
  }
}
