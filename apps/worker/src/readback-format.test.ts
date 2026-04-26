import test from 'node:test';
import assert from 'node:assert/strict';
import type { PersistableSessionRecord } from '@auradent/ingestion';
import { buildReadbackResponse } from './readback-format';

test('buildReadbackResponse surfaces audit-friendly summaries', () => {
  const record: PersistableSessionRecord = {
    sessionId: 'demo-session',
    patientId: 'demo-patient',
    closedAt: '2026-04-25T04:37:27.413Z',
    transcript: {
      finalText: 'Patient demo-patient has four millimeter pockets on tooth 14.',
    },
    normalizedFindings: [
      {
        sessionId: 'demo-session',
        patientId: 'demo-patient',
        toothNumber: 14,
        probingDepthMm: 4,
        bleedingOnProbing: false,
        sourceUtteranceId: 'utt-14',
        confidence: 0.98,
        provenance: {
          dedupeKey: 'tooth-14',
          duplicateCount: 0,
          mergedSourceUtteranceIds: ['utt-14'],
          resolution: 'highest-confidence-then-latest',
        },
      },
    ],
    postOpInstruction: {
      fileName: 'post-op-demo-session.pdf',
      mimeType: 'application/pdf',
      byteLength: 420,
      previewText: 'AuraDent Post-Op Instructions',
      sha256Digest: 'a'.repeat(64),
      storage: {
        persistedAt: '2026-04-25T04:37:29.000Z',
        storageKind: 'filesystem',
        outputPath: '/tmp/auradent/post-op-demo-session.pdf',
      },
    },
    insurancePreAuthorization: {
      requestId: 'preauth-demo-session',
      status: 'approved',
      payerName: 'Mock Dental Mutual',
      procedureCodes: ['D0180'],
      referenceNumber: 'MDM-SESSION',
      submittedAt: '2026-04-25T04:37:28.000Z',
      rationale: 'Routine rule matched.',
    },
    observability: {
      sourceArtifacts: {
        trace: [{ step: 'agent.completed' }],
        metrics: [{ name: 'ttft', value: 140, unit: 'ms' }],
      },
      processing: {
        processedAt: '2026-04-25T04:37:29.000Z',
        processingDurationMs: 22,
        runtime: 'local',
        persistenceMode: 'postgres',
        traceEventCount: 1,
        metricCount: 1,
        payloadSha256: 'b'.repeat(64),
        recordSha256: 'c'.repeat(64),
      },
    },
  };

  const response = buildReadbackResponse(
    [
      {
        session_id: 'demo-session',
        patient_id: 'demo-patient',
        insurance_status: 'approved',
        closed_at: '2026-04-25T04:37:27.413Z',
        record,
      },
    ],
    true,
  );

  assert.equal(response.count, 1);
  assert.equal(response.summaries[0]?.artifactOutputPath, '/tmp/auradent/post-op-demo-session.pdf');
  assert.equal(response.summaries[0]?.dedupeDuplicateCount, 0);
  assert.equal(response.summaries[0]?.dedupeResolution, 'highest-confidence-then-latest');
  assert.equal(response.summaries[0]?.sessionId, 'demo-session');
  assert.equal(response.summaries[0]?.findingsCount, 1);
  assert.deepEqual(response.summaries[0]?.mergedUtteranceProvenance, []);
  assert.equal(response.summaries[0]?.runtime, 'local');
  assert.equal(response.summaries[0]?.persistenceMode, 'postgres');
  assert.equal(response.summaries[0]?.postOpFile, 'post-op-demo-session.pdf');
  assert.match(response.summaries[0]?.payloadSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(response.records?.[0]?.sessionId, 'demo-session');
});

test('buildReadbackResponse tolerates older persisted records without source artifacts', () => {
  const legacyRecord = {
    sessionId: 'legacy-session',
    patientId: 'legacy-patient',
    closedAt: '2026-04-25T04:37:27.413Z',
    transcript: {
      finalText: 'Legacy persisted transcript',
    },
    normalizedFindings: [],
    postOpInstruction: {
      fileName: 'legacy-post-op.pdf',
    },
    insurancePreAuthorization: {
      status: 'approved',
    },
    observability: {},
  } as unknown as PersistableSessionRecord;

  const response = buildReadbackResponse(
    [
      {
        session_id: 'legacy-session',
        patient_id: 'legacy-patient',
        insurance_status: 'approved',
        closed_at: '2026-04-25T04:37:27.413Z',
        record: legacyRecord,
      },
    ],
    false,
  );

  assert.equal(response.count, 1);
  assert.equal(response.summaries[0]?.artifactOutputPath, null);
  assert.equal(response.summaries[0]?.dedupeDuplicateCount, 0);
  assert.equal(response.summaries[0]?.dedupeResolution, null);
  assert.equal(response.summaries[0]?.sessionId, 'legacy-session');
  assert.equal(response.summaries[0]?.traceEventCount, 0);
  assert.equal(response.summaries[0]?.metricCount, 0);
  assert.deepEqual(response.summaries[0]?.mergedUtteranceProvenance, []);
  assert.equal(response.summaries[0]?.runtime, 'unknown');
  assert.equal(response.summaries[0]?.postOpFile, 'legacy-post-op.pdf');
  assert.equal(response.summaries[0]?.transcriptPreview, 'Legacy persisted transcript');
});

test('buildReadbackResponse surfaces merged utterance provenance for deduplicated findings', () => {
  const dedupedRecord = {
    sessionId: 'dedupe-session',
    patientId: 'dedupe-patient',
    closedAt: '2026-04-26T02:00:00.000Z',
    transcript: {
      finalText: 'Patient has revised findings on tooth 14.',
    },
    normalizedFindings: [
      {
        sessionId: 'dedupe-session',
        patientId: 'dedupe-patient',
        toothNumber: 14,
        probingDepthMm: 4,
        bleedingOnProbing: true,
        sourceUtteranceId: 'utt-2000',
        confidence: 0.95,
        provenance: {
          dedupeKey: 'tooth-14',
          duplicateCount: 2,
          mergedSourceUtteranceIds: ['utt-1000', 'utt-1500', 'utt-2000'],
          resolution: 'highest-confidence-then-latest',
        },
      },
    ],
    postOpInstruction: {
      fileName: 'post-op-dedupe-session.pdf',
    },
    insurancePreAuthorization: {
      status: 'approved',
    },
    observability: {
      sourceArtifacts: {
        trace: [],
        metrics: [],
      },
    },
  } as unknown as PersistableSessionRecord;

  const response = buildReadbackResponse(
    [
      {
        session_id: 'dedupe-session',
        patient_id: 'dedupe-patient',
        insurance_status: 'approved',
        closed_at: '2026-04-26T02:00:00.000Z',
        record: dedupedRecord,
      },
    ],
    false,
  );

  assert.equal(response.summaries[0]?.dedupeDuplicateCount, 2);
  assert.equal(response.summaries[0]?.dedupeResolution, 'highest-confidence-then-latest');
  assert.deepEqual(response.summaries[0]?.mergedUtteranceProvenance, [
    {
      duplicateCount: 2,
      mergedSourceUtteranceIds: ['utt-1000', 'utt-1500', 'utt-2000'],
      sourceUtteranceId: 'utt-2000',
      toothNumber: 14,
    },
  ]);
});
