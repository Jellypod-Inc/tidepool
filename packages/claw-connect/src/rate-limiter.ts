export interface RateLimitConfig {
  tokens: number;
  windowMs: number;
}

export interface ConsumeResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

const VALID_UNITS: Record<string, number> = {
  hour: 3_600_000,
  minute: 60_000,
  second: 1_000,
};

export function parseRateLimit(rateLimit: string): RateLimitConfig {
  const match = rateLimit.match(/^(\d+)\/(hour|minute|second)$/);
  if (!match) {
    throw new Error(
      `Invalid rate limit format: "${rateLimit}". Expected "N/hour", "N/minute", or "N/second".`,
    );
  }

  const tokens = parseInt(match[1], 10);
  if (tokens <= 0) {
    throw new Error(`Rate limit tokens must be positive, got ${tokens}`);
  }

  const windowMs = VALID_UNITS[match[2]];
  return { tokens, windowMs };
}

/**
 * Simple token bucket rate limiter.
 *
 * In-memory, resets on server restart. Not a security boundary —
 * just a courtesy mechanism to protect the machine and agent compute.
 */
export class TokenBucket {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly windowMs: number;
  private lastRefill: number;

  constructor(maxTokens: number, windowMs: number) {
    this.maxTokens = maxTokens;
    this.windowMs = windowMs;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  consume(): ConsumeResult {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const msPerToken = this.windowMs / this.maxTokens;
    const retryAfterSeconds = Math.ceil(msPerToken / 1000);

    return { allowed: false, retryAfterSeconds };
  }

  remaining(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refillRate = this.maxTokens / this.windowMs;
    const newTokens = elapsed * refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }
}
