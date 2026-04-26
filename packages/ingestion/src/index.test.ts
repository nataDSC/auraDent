import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPersistableSessionRecord,
  generatePostOpInstructionArtifact,
  normalizeExtraction,
  simulateInsurancePreAuthorization,
} from './index';
import type { AgentExtraction, SessionClosePayload } from '@auradent/shared';

test('normalizeExtraction maps findings into persistence-ready records', () => {
  const extraction: AgentExtraction = {
    sessionId: 'session-123',
    patientId: 'patient-abc',
    requiresReview: false,
    noteSummary: 'Patient has 4mm pockets on tooth 14.',
    findings: [
      {
        toothNumber: 14,
        probingDepthMm: 4,
        bleedingOnProbing: true,
        confidence: 0.97,
        sourceUtteranceId: 'utt-14',
      },
    ],
  };

  const normalized = normalizeExtraction(extraction);

  assert.deepEqual(normalized, [
    {
      sessionId: 'session-123',
      patientId: 'patient-abc',
      toothNumber: 14,
      probingDepthMm: 4,
      bleedingOnProbing: true,
      sourceUtteranceId: 'utt-14',
      confidence: 0.97,
      provenance: {
        dedupeKey: 'tooth-14',
        duplicateCount: 0,
        mergedSourceUtteranceIds: ['utt-14'],
        resolution: 'highest-confidence-then-latest',
      },
    },
  ]);
});

test('normalizeExtraction dedupes revised findings for the same tooth and preserves provenance', () => {
  const extraction: AgentExtraction = {
    sessionId: 'session-456',
    patientId: 'patient-xyz',
    requiresReview: false,
    noteSummary: 'Patient has revised perio findings on tooth 14.',
    findings: [
      {
        toothNumber: 14,
        probingDepthMm: 3,
        bleedingOnProbing: false,
        confidence: 0.71,
        sourceUtteranceId: 'utt-1000',
      },
      {
        toothNumber: 14,
        probingDepthMm: 4,
        bleedingOnProbing: true,
        confidence: 0.95,
        sourceUtteranceId: 'utt-2000',
      },
      {
        toothNumber: 14,
        probingDepthMm: 4,
        bleedingOnProbing: false,
        confidence: 0.91,
        sourceUtteranceId: 'utt-1500',
      },
    ],
  };

  const normalized = normalizeExtraction(extraction);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.toothNumber, 14);
  assert.equal(normalized[0]?.probingDepthMm, 4);
  assert.equal(normalized[0]?.bleedingOnProbing, true);
  assert.equal(normalized[0]?.confidence, 0.95);
  assert.equal(normalized[0]?.sourceUtteranceId, 'utt-2000');
  assert.deepEqual(normalized[0]?.provenance, {
    dedupeKey: 'tooth-14',
    duplicateCount: 2,
    mergedSourceUtteranceIds: ['utt-1000', 'utt-1500', 'utt-2000'],
    resolution: 'highest-confidence-then-latest',
  });
});

test('buildPersistableSessionRecord assembles artifact and insurance metadata', () => {
  const payload: SessionClosePayload = {
    sessionId: 'session-123',
    patientId: 'patient-abc',
    closedAt: '2026-04-25T12:00:00.000Z',
    transcript: {
      finalText: 'Patient has 4mm pockets on tooth 14.',
    },
    structuredFindings: [
      {
        toothNumber: 14,
        probingDepthMm: 4,
        bleedingOnProbing: true,
        confidence: 0.97,
        sourceUtteranceId: 'utt-14',
      },
    ],
    artifacts: {
      trace: [{ step: 'agent.completed' }],
      metrics: [{ name: 'ttft', value: 123, unit: 'ms' }],
    },
  };

  const normalized = normalizeExtraction({
    sessionId: payload.sessionId,
    patientId: payload.patientId,
    requiresReview: false,
    noteSummary: payload.transcript.finalText,
    findings: payload.structuredFindings,
  });
  const postOpInstruction = generatePostOpInstructionArtifact(payload, normalized);
  const insurance = simulateInsurancePreAuthorization(payload, normalized);
  const record = buildPersistableSessionRecord({
    payload,
    normalizedFindings: normalized,
    postOpInstruction,
    persistedPostOpInstruction: {
      persistedAt: '2026-04-25T12:00:01.000Z',
      storageKind: 'filesystem',
      outputPath: '/tmp/post-op-session-123.pdf',
    },
    insurancePreAuthorization: insurance,
  });

  assert.equal(postOpInstruction.mimeType, 'application/pdf');
  assert.ok(postOpInstruction.byteLength > 0);
  assert.match(postOpInstruction.previewText, /Tooth 14 4mm/);
  assert.match(postOpInstruction.sha256Digest, /^[a-f0-9]{64}$/);
  assert.equal(insurance.status, 'approved');
  assert.equal(record.insurancePreAuthorization.status, 'approved');
  assert.equal(record.postOpInstruction.fileName, 'post-op-session-123.pdf');
  assert.match(record.postOpInstruction.sha256Digest, /^[a-f0-9]{64}$/);
  assert.equal(record.postOpInstruction.storage?.outputPath, '/tmp/post-op-session-123.pdf');
  assert.equal(record.normalizedFindings[0]?.toothNumber, 14);
  assert.equal(record.observability.sourceArtifacts.trace.length, 1);
});

test('generatePostOpInstructionArtifact wraps PDF text across multiple lines', () => {
  const payload: SessionClosePayload = {
    sessionId: 'session-wrap',
    patientId: 'patient-wrap',
    closedAt: '2026-04-25T12:00:00.000Z',
    transcript: {
      finalText:
        'Patient has detailed follow-up instructions requiring enough content to exceed a single line in the PDF stub.',
    },
    structuredFindings: [
      {
        toothNumber: 14,
        probingDepthMm: 4,
        bleedingOnProbing: true,
        confidence: 0.97,
        sourceUtteranceId: 'utt-wrap',
      },
    ],
    artifacts: {
      trace: [],
      metrics: [],
    },
  };

  const normalized = normalizeExtraction({
    sessionId: payload.sessionId,
    patientId: payload.patientId,
    requiresReview: false,
    noteSummary: payload.transcript.finalText,
    findings: payload.structuredFindings,
  });
  const postOpInstruction = generatePostOpInstructionArtifact(payload, normalized);
  const decodedPdf = Buffer.from(postOpInstruction.contentBase64, 'base64').toString('utf8');

  assert.match(decodedPdf, /16 TL/);
  assert.match(decodedPdf, /T\*/);
});
