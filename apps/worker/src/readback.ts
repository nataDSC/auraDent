import process from 'node:process';
import { loadWorkerLocalEnv } from './load-local-env';

loadWorkerLocalEnv();

async function main() {
  const connectionString = process.env.AURADENT_DATABASE_URL;
  if (!connectionString) {
    throw new Error('AURADENT_DATABASE_URL is required for readback:local.');
  }

  const sessionId = process.argv[2];
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
              jsonb_pretty(record) as record
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
              jsonb_pretty(record) as record
            from auradent_session_records
            order by updated_at desc
            limit $1
          `,
          [limit],
        );

    console.log(
      JSON.stringify({
        level: 'info',
        message: 'Read AuraDent persisted session records',
        rows: result.rows,
      }),
    );
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
