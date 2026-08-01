/**
 * Notion integration token leasing.
 *
 * `live` tasks hit a real workspace, and docs/PLAN.md caps throughput at ~2.5 req/s
 * per token with a token pool sized to concurrency. A trial must hold a token for
 * its whole duration so two concurrent trials never share one (which would both
 * halve the effective rate budget and let one trial's fixtures be visible to
 * another's `search`).
 *
 * TODO(fixtures): the host-side token bucket and the orphan reaper belong with
 * fixture provisioning, not here. This is only the lease.
 */

export interface TokenLease {
  token: string;
  release(): void;
}

export class TokenPool {
  /** Total tokens in the pool — NOT how many are currently free. */
  readonly capacity: number;
  private readonly free: string[];
  private readonly waiters: Array<(lease: TokenLease) => void> = [];

  constructor(tokens: string[]) {
    this.free = [...tokens];
    this.capacity = tokens.length;
  }

  /** Build from `NOTION_API_TOKEN` / `NOTIONBENCH_NOTION_TOKENS` (comma-separated). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): TokenPool {
    const multi = (env.NOTIONBENCH_NOTION_TOKENS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (multi.length > 0) return new TokenPool(multi);
    const single = env.NOTION_API_TOKEN?.trim();
    return new TokenPool(single ? [single] : []);
  }

  get size(): number {
    return this.capacity;
  }

  /** Tokens free right now. */
  get available(): number {
    return this.free.length;
  }

  get isEmpty(): boolean {
    return this.capacity === 0;
  }

  async acquire(): Promise<TokenLease | undefined> {
    // An empty pool means an offline-only run — resolve immediately with no lease
    // rather than blocking forever on a token that will never exist.
    if (this.capacity === 0) return undefined;
    const token = this.free.pop();
    if (token !== undefined) return this.makeLease(token);
    return new Promise<TokenLease>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private makeLease(token: string): TokenLease {
    let released = false;
    return {
      token,
      release: () => {
        if (released) return;
        released = true;
        const waiter = this.waiters.shift();
        if (waiter) waiter(this.makeLease(token));
        else this.free.push(token);
      },
    };
  }
}
