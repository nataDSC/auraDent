import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDeepgramReconnectDelayMs,
  MAX_DEEPGRAM_RETRY_ATTEMPTS,
  shouldRetryDeepgramSession,
} from './deepgram-retry';

test('getDeepgramReconnectDelayMs uses bounded exponential backoff', () => {
  assert.equal(getDeepgramReconnectDelayMs(1), 500);
  assert.equal(getDeepgramReconnectDelayMs(2), 1000);
  assert.equal(getDeepgramReconnectDelayMs(3), 2000);
  assert.equal(getDeepgramReconnectDelayMs(4), 4000);
  assert.equal(getDeepgramReconnectDelayMs(5), 4000);
});

test('shouldRetryDeepgramSession only retries active live sessions within budget', () => {
  assert.equal(
    shouldRetryDeepgramSession({
      attempt: 0,
      hasAudioSampleRate: true,
      isStopping: false,
    }),
    true,
  );

  assert.equal(
    shouldRetryDeepgramSession({
      attempt: MAX_DEEPGRAM_RETRY_ATTEMPTS,
      hasAudioSampleRate: true,
      isStopping: false,
    }),
    false,
  );

  assert.equal(
    shouldRetryDeepgramSession({
      attempt: 1,
      hasAudioSampleRate: false,
      isStopping: false,
    }),
    false,
  );

  assert.equal(
    shouldRetryDeepgramSession({
      attempt: 1,
      hasAudioSampleRate: true,
      isStopping: true,
    }),
    false,
  );
});
