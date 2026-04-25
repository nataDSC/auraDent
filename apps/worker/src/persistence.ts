import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { PersistableSessionRecord } from '@auradent/ingestion';
import { CREATE_AURADENT_SESSION_RECORDS_TABLE_SQL } from './schema';

export type SessionPersistenceAdapter = {
  kind: 'postgres' | 'local-file';
  persist: (record: PersistableSessionRecord) => Promise<void>;
  close: () => Promise<void>;
};

export async function createSessionPersistenceAdapter(): Promise<SessionPersistenceAdapter> {
  if (process.env.AURADENT_DATABASE_URL) {
    return createPostgresPersistenceAdapter(process.env.AURADENT_DATABASE_URL);
  }

  return createLocalFilePersistenceAdapter(
    process.env.AURADENT_PERSISTENCE_FILE ?? '/tmp/auradent-session-records.jsonl',
  );
}

async function createLocalFilePersistenceAdapter(filePath: string): Promise<SessionPersistenceAdapter> {
  await mkdir(path.dirname(filePath), { recursive: true });

  return {
    kind: 'local-file',
    persist: async (record) => {
      await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
    },
    close: async () => {},
  };
}

async function createPostgresPersistenceAdapter(connectionString: string): Promise<SessionPersistenceAdapter> {
  const { Client } = await import('pg');
  const client = new Client({
    connectionString,
    ssl: resolvePostgresSsl(),
  });

  await client.connect();
  await client.query(CREATE_AURADENT_SESSION_RECORDS_TABLE_SQL);

  return {
    kind: 'postgres',
    persist: async (record) => {
      await client.query(
        `
          insert into auradent_session_records (
            session_id,
            patient_id,
            closed_at,
            insurance_status,
            record
          )
          values ($1, $2, $3, $4, $5::jsonb)
          on conflict (session_id)
          do update set
            patient_id = excluded.patient_id,
            closed_at = excluded.closed_at,
            insurance_status = excluded.insurance_status,
            record = excluded.record,
            updated_at = now();
        `,
        [
          record.sessionId,
          record.patientId,
          record.closedAt,
          record.insurancePreAuthorization.status,
          JSON.stringify(record),
        ],
      );
    },
    close: async () => {
      await client.end();
    },
  };
}

function resolvePostgresSsl() {
  if (process.env.AURADENT_DATABASE_SSL === 'disable') {
    return false;
  }

  return process.env.AURADENT_DATABASE_SSL === 'require'
    ? { rejectUnauthorized: false }
    : undefined;
}
