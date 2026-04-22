# AWS Infrastructure

This package contains the AWS CDK scaffold for AuraDent's async backend.

Current scope:

- session-close queue,
- dead-letter queue,
- placeholder Lambda function,
- queue-to-worker event source mapping.

Next step:

- replace the inline placeholder Lambda with a deployed artifact from `apps/worker`.
