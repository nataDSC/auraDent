import process from 'node:process';
import { CREATE_AURADENT_SESSION_RECORDS_TABLE_SQL } from './schema';
import { loadWorkerLocalEnv } from './load-local-env';

loadWorkerLocalEnv();

async function main() {
  const connectionString = process.env.AURADENT_DATABASE_URL;
  if (!connectionString) {
    throw new Error('AURADENT_DATABASE_URL is required for migrate:local.');
  }

  const { Client } = await import('pg');
  const client = new Client({
    connectionString,
    ssl: resolvePostgresSsl(),
  });

  try {
    await client.connect();
    await client.query(CREATE_AURADENT_SESSION_RECORDS_TABLE_SQL);
    console.log(
      JSON.stringify({
        level: 'info',
        message: 'Applied AuraDent worker migration',
        table: 'auradent_session_records',
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
      message: error instanceof Error ? error.message : 'Local migration failed.',
    }),
  );
  process.exitCode = 1;
});
