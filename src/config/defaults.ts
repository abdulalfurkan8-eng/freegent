/** Central runtime limits. Keep operational magic numbers here. */
export const DEFAULTS = {
  browser: { loginTimeoutMs: 600_000, navigationTimeoutMs: 30_000, responseTimeoutMs: 300_000, responseIdleMs: 2_500, deepSeekBackoffBaseMs: 1_500, deepSeekBackoffMaxMs: 30_000 },
  agent: { maxIterations: 150, maxParallelWorkers: 4, maxFeedbackChars: 6_000, runtimeMaxBytes: 10 * 1024 * 1024, runtimeMaxEntries: 1000, maxReadableFileBytes: 500 * 1024 },
  memory: { maxEntries: 10_000, lockRetryMs: 40, lockTimeoutMs: 5_000, lockStaleMs: 30_000 },
  checkpoints: { maxEntries: 200 },
  computer: { groundingMinConfidence: 0.45, groundingMaxAgeMs: 10_000, postconditionTimeoutMs: 800, actionTimeoutMs: 10_000 },
  terminal: { maxTimeoutMs: 10 * 60 * 1000, defaultTimeoutMs: 60 * 1000 },
} as const;
