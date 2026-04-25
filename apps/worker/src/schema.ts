export const CREATE_AURADENT_SESSION_RECORDS_TABLE_SQL = `
  create table if not exists auradent_session_records (
    session_id text primary key,
    patient_id text not null,
    closed_at timestamptz not null,
    insurance_status text not null,
    record jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
`;
