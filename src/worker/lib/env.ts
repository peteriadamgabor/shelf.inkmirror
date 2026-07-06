export interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  SHELF_R2: R2Bucket;
  SHELF_DB: D1Database;
  RL_PUBLISH: RateLimit;
  RL_MANAGE: RateLimit;
  RL_REPORT: RateLimit;
  /** Per-(ip, work) cooldown so refresh spam doesn't inflate view counts. */
  RL_VIEWS: RateLimit;
  /** Password-gate unlock attempts, keyed `${ip}:${id}`. */
  RL_UNLOCK: RateLimit;
  /** Reader→author letters, keyed by ip. */
  RL_LETTER: RateLimit;
  /** Report + moderation-hold notifications. Wrangler Secret. */
  DISCORD_WEBHOOK?: string;
  /** Phase 2 moderation chain. Wrangler Secret. */
  ANTHROPIC_API_KEY?: string;
  /**
   * Global daily cap on moderation-chain runs (shadow AND listing gate) —
   * the code-side belt to the Anthropic console's spend-limit braces.
   * Plain var in wrangler.jsonc ("vars"), NOT a secret. Parsed as an int,
   * default 100, clamped 1..10000 (see chainDailyCap in moderation.ts).
   */
  CHAIN_DAILY_CAP?: string;
  /**
   * Operator toolkit auth (X-Admin-Secret on /api/admin/*). Wrangler Secret.
   * Unset = the whole admin surface answers 404, indistinguishable from an
   * unknown route.
   */
  ADMIN_SECRET?: string;
  /**
   * Optional Cloudflare Turnstile on the /w/:id/report page. BOTH must be
   * set to enable the widget + server-side verification; either unset =
   * current honeypot-only behavior. Wrangler Secrets.
   */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}
