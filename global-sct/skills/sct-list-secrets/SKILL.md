---
name: sct-list-secrets
description: List saved secret IDs and environment names for one local global.sct project without displaying secret values.
---

# List global.sct secret metadata

Use the `list_secrets` MCP tool with the registered `projectId` from `project_setup` or an existing metadata result.
If `projectId` is absent, global.sct selects the nearest registered parent of the caller's working directory.

```json
{"projectId":"00000000-0000-4000-8000-000000000001"}
```

CLI equivalent:

```sh
printf '%s' '{}' | sct agent list_secrets --stdin
```

The CLI example selects the project from the working directory.
The user must approve the request in the local global.sct window.
The result contains `id`, `projectId`, and `name` for each saved secret.
Use these IDs for description, deletion, sharing, or the fixed demo.
An ID is a reference, not a secret value.
Do not use `sct run` to print environment values.
Stop after refusal, expiry, or failure. Do not repeat a refused request without a new user instruction.
