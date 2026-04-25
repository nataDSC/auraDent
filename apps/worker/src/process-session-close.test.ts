import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionClosePayload } from '@auradent/shared';
import { createSessionPersistenceAdapter } from './persistence';
import { processSessionClosePayload } from './process-session-close';

test('processSessionClosePayload persists to local JSONL fallback and returns summary', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'auradent-worker-test-'));
  const persistenceFile = path.join(tempDir, 'session-records.jsonl');

  delete process.env.AURADENT_DATABASE_URL;
  process.env.AURADENT_PERSISTENCE_FILE = persistenceFile;

  const payload: SessionClosePayload = {
    sessionId: 'test-session',
    patientId: 'test-patient',
    closedAt: '2026-04-25T12:34:56.000Z',
    transcript: {
      finalText: 'Patient has four millimeter pockets on tooth 14.',
    },
    structuredFindings: [
      {
        toothNumber: 14,
        probingDepthMm: 4,
        confidence: 0.95,
        sourceUtteranceId: 'utt-14',
      },
    ],
    artifacts: {
      trace: [{ step: 'agent.completed' }],
      metrics: [{ name: 'ttft', value: 144, unit: 'ms' }],
    },
  };

  const persistence = await createSessionPersistenceAdapter();

  try {
    const summary = await processSessionClosePayload(payload, persistence, {
      runtime: 'local',
    });

    assert.equal(summary.persistence, 'local-file');
    assert.equal(summary.findings, 1);
    assert.equal(summary.sessionId, 'test-session');
    assert.ok(summary.processingDurationMs >= 0);
    assert.match(summary.recordSha256, /^[a-f0-9]{64}$/);
  } finally {
    await persistence.close();
  }

  const contents = await readFile(persistenceFile, 'utf8');
  const persisted = JSON.parse(contents.trim()) as {
    observability: {
      processing: {
        payloadSha256: string;
        persistenceMode: string;
        recordSha256: string;
        runtime: string;
      };
    };
    sessionId: string;
    postOpInstruction: { fileName: string };
    insurancePreAuthorization: { status: string };
  };

  assert.equal(persisted.sessionId, 'test-session');
  assert.equal(persisted.postOpInstruction.fileName, 'post-op-test-session.pdf');
  assert.equal(persisted.insurancePreAuthorization.status, 'approved');
  assert.equal(persisted.observability.processing.runtime, 'local');
  assert.equal(persisted.observability.processing.persistenceMode, 'local-file');
  assert.match(persisted.observability.processing.payloadSha256, /^[a-f0-9]{64}$/);
  assert.match(persisted.observability.processing.recordSha256, /^[a-f0-9]{64}$/);
});
