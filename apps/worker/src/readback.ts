import process from 'node:process';
import { loadWorkerLocalEnv } from './load-local-env';
import { buildReadbackResponse, type PersistedSessionRow } from './readback-format';

loadWorkerLocalEnv();

async function main() {
  const connectionString = process.env.AURADENT_DATABASE_URL;
  if (!connectionString) {
    throw new Error('AURADENT_DATABASE_URL is required for readback:local.');
  }

  const args = process.argv.slice(2);
  const showFullRecords = args.includes('--full');
  const sessionId = args.find((arg) => !arg.startsWith('--'));
  const limit = Number(process.env.AURADENT_READBACK_LIMIT ?? '5');
  const { Client } = await import('pg');
  const client = new Client({
    connectionString,
    ssl: resolvePostgresSsl(),
  });

  try {
    await client.connect();

    const result = sessionId
      ? await client.query(
          `
            select
              session_id,
              patient_id,
              insurance_status,
              closed_at,
              record
            from auradent_session_records
            where session_id = $1
          `,
          [sessionId],
        )
      : await client.query(
          `
            select
              session_id,
              patient_id,
              insurance_status,
              closed_at,
              record
            from auradent_session_records
            order by updated_at desc
            limit $1
          `,
          [limit],
        );

    const response = buildReadbackResponse(
      result.rows as PersistedSessionRow[],
      showFullRecords || Boolean(sessionId),
    );

    console.log(JSON.stringify(response));
  } finally {
    await client.end();
  }
}

function resolvePostgresSsl() {
  if (process.env.AURADENT_DATABASE_SSL === 'disable') {
    return false;
  }

  return process.env.AURADENT_DATABASE_SSL === 'require'
    ? { rejectUnauthorized: false }
    : undefined;
}

void main().catch((error) => {
  console.error(
    JSON.stringify({
      level: 'error',
      message: error instanceof Error ? error.message : 'Local readback failed.',
    }),
  );
  process.exitCode = 1;
});
