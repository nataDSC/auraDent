export const MAX_DEEPGRAM_RETRY_ATTEMPTS = 3;

export function getDeepgramReconnectDelayMs(attempt: number) {
  const boundedAttempt = Math.max(1, attempt);
  return Math.min(500 * 2 ** (boundedAttempt - 1), 4000);
}

export function shouldRetryDeepgramSession(args: {
  attempt: number;
  hasAudioSampleRate: boolean;
  isStopping: boolean;
}) {
  if (args.isStopping) {
    return false;
  }

  if (!args.hasAudioSampleRate) {
    return false;
  }

  return args.attempt < MAX_DEEPGRAM_RETRY_ATTEMPTS;
}
