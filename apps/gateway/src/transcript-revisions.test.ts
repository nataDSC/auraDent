import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTranscriptRevision } from './transcript-revisions';

test('reconcileTranscriptRevision suppresses duplicate partials', () => {
  const first = reconcileTranscriptRevision({
    utteranceId: 'utt-1',
    text: 'Has four millimeter',
    isFinal: false,
    store: new Map(),
  });

  const duplicate = reconcileTranscriptRevision({
    utteranceId: 'utt-1',
    text: 'Has four millimeter',
    isFinal: false,
    store: first.nextStore,
  });

  assert.equal(first.shouldEmit, true);
  assert.equal(duplicate.shouldEmit, false);
  assert.equal(duplicate.shouldQueueExtraction, false);
});

test('reconcileTranscriptRevision ignores stale partials after final text exists', () => {
  const partial = reconcileTranscriptRevision({
    utteranceId: 'utt-2',
    text: 'on tooth 14',
    isFinal: false,
    store: new Map(),
  });

  const final = reconcileTranscriptRevision({
    utteranceId: 'utt-2',
    text: 'on tooth 14 with bleeding on probing.',
    isFinal: true,
    store: partial.nextStore,
  });

  const stalePartial = reconcileTranscriptRevision({
    utteranceId: 'utt-2',
    text: 'on tooth 14',
    isFinal: false,
    store: final.nextStore,
  });

  assert.equal(final.shouldEmit, true);
  assert.equal(final.shouldQueueExtraction, true);
  assert.equal(stalePartial.shouldEmit, false);
});

test('reconcileTranscriptRevision re-queues extraction when a final revision changes', () => {
  const firstFinal = reconcileTranscriptRevision({
    utteranceId: 'utt-3',
    text: 'Has four millimeter pockets on tooth 14.',
    isFinal: true,
    store: new Map(),
  });

  const revisedFinal = reconcileTranscriptRevision({
    utteranceId: 'utt-3',
    text: 'Has four millimeter pockets on tooth 14 with bleeding on probing.',
    isFinal: true,
    store: firstFinal.nextStore,
  });

  assert.equal(firstFinal.shouldQueueExtraction, true);
  assert.equal(revisedFinal.shouldEmit, true);
  assert.equal(revisedFinal.shouldQueueExtraction, true);
});
