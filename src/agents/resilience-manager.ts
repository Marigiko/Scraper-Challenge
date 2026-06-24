import type { RetryPolicy, FailureContext, BackoffResult } from '../types/index.js';
import { logger } from '../utils/logger.js';

const DEFAULT_POLICY: RetryPolicy = {
  maxRetries: Number(process.env.MAX_RETRIES) || 5,
  baseDelayMs: Number(process.env.BASE_DELAY_MS) || 1000,
  maxDelayMs: Number(process.env.MAX_DELAY_MS) || 60000,
  jitterFactor: Number(process.env.JITTER_FACTOR) || 0.25,
};

export function calculateBackoff(
  attempt: number,
  policy: Partial<RetryPolicy> = {},
): number {
  const { baseDelayMs, maxDelayMs, jitterFactor } = { ...DEFAULT_POLICY, ...policy };
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxDelayMs);
  const jitterRange = capped * jitterFactor;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.min(Math.round(capped + jitter), maxDelayMs));
}

export function shouldRetry(
  attempt: number,
  policy: Partial<RetryPolicy> = {},
): boolean {
  const { maxRetries } = { ...DEFAULT_POLICY, ...policy };
  return attempt < maxRetries;
}

export function handleFailure(ctx: FailureContext): BackoffResult {
  const policy: RetryPolicy = {
    ...DEFAULT_POLICY,
  };

  const retryable = isRetryableError(ctx.statusCode);
  if (!retryable) {
    logger.warn(`Non-retryable error for ${ctx.docId} (HTTP ${ctx.statusCode}): ${ctx.errorMessage}`);
    return {
      delayMs: 0,
      attempt: ctx.attempt,
      isFinalAttempt: true,
    };
  }

  if (!shouldRetry(ctx.attempt, policy)) {
    logger.error(`Max retries reached for ${ctx.docId} after ${ctx.attempt} attempts`);
    return {
      delayMs: 0,
      attempt: ctx.attempt,
      isFinalAttempt: true,
    };
  }

  let delayMs: number;
  if (ctx.retryAfter !== null) {
    delayMs = ctx.retryAfter * 1000;
    logger.info(`Using Retry-After header: ${delayMs}ms`);
  } else {
    delayMs = calculateBackoff(ctx.attempt, policy);
  }

  logger.warn(`Backoff for ${ctx.docId}: ${delayMs}ms (attempt ${ctx.attempt + 1}/${policy.maxRetries})`);

  return {
    delayMs,
    attempt: ctx.attempt,
    isFinalAttempt: false,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;

  const seconds = parseInt(headerValue, 10);
  if (!isNaN(seconds) && seconds >= 0) return seconds;

  const date = new Date(headerValue);
  if (!isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }

  return null;
}

export function isRetryableError(statusCode: number | null): boolean {
  if (statusCode === null) return true;
  if (statusCode === 429 || statusCode === 503 || statusCode === 502 || statusCode === 504) return true;
  if (statusCode >= 500) return true;
  return false;
}
