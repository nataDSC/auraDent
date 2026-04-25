import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildSessionClosePayload, writeSessionClosePayloadToDisk } from '../apps/gateway/src/session-close';
import { createSessionPersistenceAdapter } from '../apps/worker/src/persistence';
import { processSessionClosePayload } from '../apps/worker/src/process-session-close';
import type { SessionClosePayload } from '../packages/shared/src/events';

test('gateway payload replay flows through worker persistence end to end', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'auradent-replay-'));
  const payloadDirectory = path.join(tempDir, 'session-close');
  const persistenceFile = path.join(tempDir, 'persisted-records.jsonl');

  delete process.env.AURADENT_DATABASE_URL;
  process.env.AURADENT_PERSISTENCE_FILE = persistenceFile;

  const payload = buildSessionClosePayload({
    sessionId: 'replay-session',
    patientId: 'demo-patient',
    closedAt: '2026-04-25T16:45:00.000Z',
    artifacts: {
      transcriptEntries: [
        {
          utteranceId: 'utt-1',
          text: 'Patient James Brown. Phone number, 415-555-1212.',
          redactedText: 'Patient [PATIENT_NAME]. Phone number, [PHONE].',
        },
        {
          utteranceId: 'utt-2',
          text: 'Has four millimeter pockets on tooth 14.',
        },
      ],
      findings: [
        {
          toothNumber: 14,
          probingDepthMm: 4,
          bleedingOnProbing: true,
          confidence: 0.98,
          sourceUtteranceId: 'utt-2',
        },
      ],
      traceEvents: [
        {
          step: 'agent.completed',
          detail: 'AI SDK extraction produced 1 structured finding.',
          confidence: 0.98,
          ts: '2026-04-25T16:45:01.000Z',
        },
      ],
      metrics: [
        {
          name: 'ttft',
          value: 118,
          unit: 'ms',
          ts: '2026-04-25T16:45:00.100Z',
        },
      ],
    },
  });

  const paths = await writeSessionClosePayloadToDisk({
    payload,
    directory: payloadDirectory,
  });

  const savedPayload = JSON.parse(await readFile(paths.latestPath, 'utf8')) as SessionClosePayload;
  const persistence = await createSessionPersistenceAdapter();

  try {
    const summary = await processSessionClosePayload(savedPayload, persistence, {
      runtime: 'local',
    });

    assert.equal(summary.sessionId, 'replay-session');
    assert.equal(summary.findings, 1);
    assert.equal(summary.persistence, 'local-file');
    assert.equal(summary.insuranceStatus, 'approved');
  } finally {
    await persistence.close();
  }

  const persisted = JSON.parse(await readFile(persistenceFile, 'utf8')) as {
    normalizedFindings: Array<{ toothNumber: number; bleedingOnProbing: boolean }>;
    observability: {
      processing: {
        payloadSha256: string;
        runtime: string;
      };
    };
    postOpInstruction: { fileName: string };
    transcript: { finalText: string };
  };

  assert.equal(persisted.normalizedFindings[0]?.toothNumber, 14);
  assert.equal(persisted.normalizedFindings[0]?.bleedingOnProbing, true);
  assert.equal(persisted.postOpInstruction.fileName, 'post-op-replay-session.pdf');
  assert.match(persisted.transcript.finalText, /\[PATIENT_NAME\]/);
  assert.equal(persisted.observability.processing.runtime, 'local');
  assert.match(persisted.observability.processing.payloadSha256, /^[a-f0-9]{64}$/);
});
