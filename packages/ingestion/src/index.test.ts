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
    },
  ]);
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
  assert.equal(record.normalizedFindings[0]?.toothNumber, 14);
  assert.equal(record.observability.sourceArtifacts.trace.length, 1);
});
