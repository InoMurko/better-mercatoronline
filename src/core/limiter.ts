/** A tiny semaphore: at most `max` tasks run at once, the rest wait in order. */
export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(readonly max: number) {
    if (max < 1) throw new Error("Limiter needs max >= 1");
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
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

/** One-at-a-time lock (cart writes, checkout): calls run in the order they were made. */
export class Mutex {
  private chain: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  get busy() {
    return this.waiting > 0;
  }
  lock<T>(task: () => Promise<T>): Promise<T> {
    this.waiting++;
    const next = this.chain.then(task).finally(() => this.waiting--);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
