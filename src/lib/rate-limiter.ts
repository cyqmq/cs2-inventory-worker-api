/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — in-memory rate limiter (cooldown map)
 *
 *  Port of api/utils/rate-limiter.server.ts. setTimeout works on Workers.
 *--------------------------------------------------------------------------------------------*/

export class RateLimiter {
  private cooldowns = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly ms: number) {}

  isLimited(key: string): boolean {
    return this.cooldowns.has(key);
  }

  consume(key: string): void {
    clearTimeout(this.cooldowns.get(key) ?? null);
    this.cooldowns.set(
      key,
      setTimeout(() => this.cooldowns.delete(key), this.ms)
    );
  }
}