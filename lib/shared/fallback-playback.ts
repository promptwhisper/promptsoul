export const DEFAULT_FALLBACK_PLAYBACK_ATTEMPTS = 3;
export const DEFAULT_FALLBACK_RETRY_DELAY_MS = 120;

export interface FallbackPlaybackState<Key> {
  inFlight: Set<Key>;
  played: Set<Key>;
}

export interface FallbackPlaybackOptions {
  canAttempt: () => boolean;
  play: () => boolean | Promise<boolean>;
  maxAttempts?: number;
  retryDelayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
}

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function resolveMaxAttempts(value: number | undefined): number {
  const attempts = value ?? DEFAULT_FALLBACK_PLAYBACK_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new RangeError("Fallback playback attempts must be an integer from 1 to 10");
  }
  return attempts;
}

function resolveRetryDelay(value: number | undefined): number {
  const delayMs = value ?? DEFAULT_FALLBACK_RETRY_DELAY_MS;
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 5_000) {
    throw new RangeError("Fallback retry delay must be between 0 and 5000 milliseconds");
  }
  return delayMs;
}

/**
 * Deduplicates one fallback while it is loading and confirms that playback was
 * accepted before recording success. The caller owns turn/model freshness.
 */
export async function playFallbackWithRetry<Key>(
  key: Key,
  state: FallbackPlaybackState<Key>,
  options: FallbackPlaybackOptions,
): Promise<boolean> {
  const maxAttempts = resolveMaxAttempts(options.maxAttempts);
  const retryDelayMs = resolveRetryDelay(options.retryDelayMs);
  const wait = options.wait ?? waitForDelay;

  if (state.played.has(key) || state.inFlight.has(key) || !options.canAttempt()) {
    return false;
  }

  state.inFlight.add(key);
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (!options.canAttempt()) return false;

      let started = false;
      try {
        started = await options.play() === true;
      } catch {
        started = false;
      }

      if (started) {
        if (!options.canAttempt()) return false;
        state.played.add(key);
        return true;
      }
      if (attempt === maxAttempts || !options.canAttempt()) return false;

      await wait(retryDelayMs * attempt);
    }
    return false;
  } finally {
    state.inFlight.delete(key);
  }
}
