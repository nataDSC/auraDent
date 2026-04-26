# AuraDent Hugging Face Space Deployment

This guide packages the current AuraDent demo into a single Hugging Face Docker Space.

## Deployment Shape

The Docker Space runs:

- the React/Vite frontend as static files served by `nginx`
- the Fastify realtime gateway as a Node process on an internal port
- `nginx` as the public reverse proxy on port `7860`

The browser app connects to the gateway over the same public hostname, so the deployed demo behaves like one app.

AWS remains responsible for the async closeout path:

- SQS queue
- Lambda worker

## Files Added for the Space

- [Dockerfile](/Users/nataliep/Documents/New%20project/Dockerfile)
- [deploy/huggingface/nginx.conf](/Users/nataliep/Documents/New%20project/deploy/huggingface/nginx.conf)
- [deploy/huggingface/start-space.sh](/Users/nataliep/Documents/New%20project/deploy/huggingface/start-space.sh)
- [deploy/huggingface/SPACE_README.md](/Users/nataliep/Documents/New%20project/deploy/huggingface/SPACE_README.md)
- [.dockerignore](/Users/nataliep/Documents/New%20project/.dockerignore)

## Create the Space

1. Create a new Hugging Face Space.
2. Choose `Docker` as the SDK.
3. Push this repo, or a deployment-focused copy of it, to the Space repository.
4. Use [deploy/huggingface/SPACE_README.md](/Users/nataliep/Documents/New%20project/deploy/huggingface/SPACE_README.md) as the Space repository README.

## Required Secrets / Variables

At minimum, set these Space runtime secrets or variables:

```bash
DEEPGRAM_API_KEY=...
AI_GATEWAY_API_KEY=...
```

Recommended runtime variables:

```bash
DEEPGRAM_MODEL=nova-3
AURADENT_AGENT_MODEL=openai/gpt-4.1-mini
AURADENT_AWS_REGION=us-east-1
AURADENT_SESSION_CLOSE_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/819175935827/AuraDentAsyncStack-SessionCloseQueue6A2BC351-XKUrjT40yFVA
```

If you want the deployed Space to publish session-close payloads to AWS SQS, also provide AWS credentials with permission to send to that queue:

```bash
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

If you use temporary AWS credentials, also set:

```bash
AWS_SESSION_TOKEN=...
```

## Runtime Behavior

- public traffic enters through `nginx` on port `7860`
- `/realtime/*` and `/health` are proxied to the internal gateway on port `8787`
- all other routes serve the built frontend app

## Local Docker Smoke Test

You can test the same deployment shape locally with:

```bash
docker build -t auradent-space .
docker run --rm -p 7860:7860 \
  -e DEEPGRAM_API_KEY=your_key_here \
  -e AI_GATEWAY_API_KEY=your_key_here \
  -e DEEPGRAM_MODEL=nova-3 \
  -e AURADENT_AGENT_MODEL=openai/gpt-4.1-mini \
  auradent-space
```

Then open:

```text
http://localhost:7860
```

## Notes

- if AWS queue env vars are omitted, the gateway can still run the public demo without publishing session-close payloads to SQS
- worker persistence inside AWS Lambda remains ephemeral when no external database or durable artifact store is configured
- Space disk should also be treated as non-durable unless you deliberately add Hugging Face persistent storage or an external store
- this deployment path is appropriate for demos and staging, not yet the final production hosting shape for a clinical realtime gateway
