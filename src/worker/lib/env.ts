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
  /** Report + moderation-hold notifications. Wrangler Secret. */
  DISCORD_WEBHOOK?: string;
  /** Phase 2 moderation chain. Wrangler Secret. */
  ANTHROPIC_API_KEY?: string;
}
