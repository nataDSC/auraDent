# AuraDent Investor Architecture Brief

## Summary

AuraDent is a real-time AI workflow layer for dental practices. It listens during live exams, turns spoken findings into structured chart updates, and completes post-visit administrative work automatically.

The platform is designed to reduce chairside documentation burden while preserving auditability, clinician trust, and privacy controls.

## Why It Matters

Dental teams lose time to manual charting, fragmented systems, and after-hours administrative work. AuraDent addresses that by pairing real-time transcription with an agentic workflow engine that can structure findings, call practice-management tools, and trigger downstream operational tasks after the session ends.

## How The System Works

### 1. Ambient clinical interface

A premium React dashboard captures microphone audio and shows live transcript updates, waveform activity, and chart changes as the clinician speaks.

### 2. Real-time intelligence pipeline

Audio is streamed through a Node.js gateway into Deepgram for low-latency transcription. Partial results appear immediately and finalize in place as confidence increases.

### 3. Safe agentic extraction

Before any transcript text reaches the model layer, PII is redacted. The agent then uses typed tools and Zod-validated outputs to convert natural language into structured clinical records.

### 4. Asynchronous operational backend

When a session closes, AuraDent pushes a standardized payload into AWS SQS. Lambda workers then handle heavier tasks like post-op PDF generation, mock insurance pre-authorization, and final record enrichment without slowing down the live clinical experience.

## Competitive Strengths

- Real-time workflow instead of after-the-fact dictation.
- Visible trace and confidence signals to support clinician trust.
- Schema-safe structured extraction rather than fragile freeform note generation.
- Event-driven backend that cleanly separates chairside UX from asynchronous ops.
- Built-in privacy guardrails that redact patient identifiers before provider calls.

## Technical Moat

AuraDent’s advantage is not just transcription. The defensible layer is the combination of:

- live, low-latency speech-to-structure conversion,
- domain-specific tool calling for dental workflows,
- normalization into clinical data models,
- and an asynchronous orchestration pipeline for downstream business actions.

## MVP Scope

The initial product should focus on perio charting and a narrow session wrap-up flow. That is enough to demonstrate:

- real-time clinical value,
- strong UX differentiation,
- privacy-aware AI operations,
- and extensibility into broader practice automation.

## Expansion Path

After MVP validation, AuraDent can expand into:

- restorative and hygiene workflows,
- production EHR integrations,
- analytics and QA dashboards,
- claims and revenue-cycle automation,
- and provider-specific workflow customization.
