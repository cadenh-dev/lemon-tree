---
name: sct-describe-secret
description: Identify a saved global.sct secret by project and secret ID when an agent needs metadata for a selected credential.
---

# Describe a global.sct secret

Use the `describe_secret` MCP tool with `projectId` and `secretId` from `list_secrets`.
Do not infer a secret ID from its environment name.

```json
{"projectId":"00000000-0000-4000-8000-000000000001","secretId":"00000000-0000-4000-8000-000000000002"}
```

CLI equivalent:

```sh
printf '%s' '{"secretId":"00000000-0000-4000-8000-000000000002"}' | sct agent describe_secret --stdin
```

Replace the example IDs with actual metadata IDs.
The CLI example selects the project from the working directory.
The user must approve the request in the local global.sct window.
The result contains only `id`, `projectId`, and `name`.
This operation does not reveal, copy, or test the credential value.
Stop after refusal, expiry, or failure. Do not search another project without user instruction.
