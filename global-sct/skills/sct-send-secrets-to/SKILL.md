---
name: sct-send-secrets-to
description: Share selected global.sct secret references with a verified AirDrop recipient after local approval, without reading credential values.
---

# Share selected global.sct secrets

Obtain secret IDs through `list_secrets`. Obtain the intended verified `recipientId` through `sharing_state`.
Request only the secrets and recipient that the user specifies.
All selected secrets must belong to one project.

Call the `send_secrets_to` MCP tool:

```json
{"projectId":"00000000-0000-4000-8000-000000000001","secretIds":["00000000-0000-4000-8000-000000000002"],"recipientId":"verified-device-id"}
```

CLI equivalent:

```sh
printf '%s' '{"secretIds":["00000000-0000-4000-8000-000000000002"],"recipientId":"verified-device-id"}' | sct agent send_secrets_to --stdin
```

Replace the example IDs with actual metadata IDs.
The CLI example selects the project from the working directory.
The user must approve the selection in the local global.sct window.
The app encrypts the transfer for that verified recipient and opens the AirDrop picker.
The user must choose the same recipient in macOS.
Report `awaiting-transport` when the operation returns that status.
Do not report delivery, receipt, or import from the operation's completion alone.
The recipient must accept the file and import its secrets through the desktop app.
Do not read or print the encrypted file contents.
This operation uses AirDrop, not relay delivery.
Stop after refusal, expiry, or failure. Do not send again automatically.
