import test from 'node:test';
import assert from 'node:assert/strict';
import { hasClinicalSignal, isReadyForStructuredExtraction } from './extraction-gating';

test('hasClinicalSignal detects perio language in fragmented transcripts', () => {
  assert.equal(hasClinicalSignal('Has four millimeter pockets'), true);
  assert.equal(hasClinicalSignal('bleeding on probing'), true);
  assert.equal(hasClinicalSignal('Patient [PATIENT_NAME] [PHONE]'), false);
});

test('isReadyForStructuredExtraction waits for explicit tooth reference', () => {
  assert.equal(isReadyForStructuredExtraction('Has four millimeter pockets'), false);
  assert.equal(isReadyForStructuredExtraction('Has four millimeter pockets on fourth'), false);
  assert.equal(isReadyForStructuredExtraction('Has four millimeter pockets on tooth 14'), true);
  assert.equal(isReadyForStructuredExtraction('Bleeding on probing around tooth fourteen'), true);
});
