---
name: sct-relay-status
description: Inspect global.sct relay connection and cached peer, inbox, and sent metadata when the user needs relay availability or delivery status.
---

# Inspect global.sct relay status

Call the `relay_status` MCP tool with an empty object.

```json
{}
```

CLI equivalent:

```sh
printf '%s' '{}' | sct agent relay_status --stdin
```

The user must approve the request in the local global.sct window.
This operation can connect to the configured relay. Local project operations do not require that connection.
The result contains `connection`, `identity`, `registered`, `error`, `updatedAt`, `peers`, `inbox`, `sent`, and `tasks` metadata.
Each `tasks` row is a remote demo task that this Mac sent or received. A `delivered` task is saved on the recipient, not approved or run.
It contains no relay token, ciphertext, wrapped key, private key, or secret value.
Report `connection` explicitly: `off`, `connecting`, `connected`, or `offline`.
When the connection is not `connected`, identify the rows as cached and report `updatedAt` if available.
Do not treat cached rows as proof of current delivery.
Report a generic connection error without searching Keychain or exposing tokens.
This operation does not create relay pairs, publish secrets or tasks, or acknowledge delivery. The global.sct desktop app does those steps.
Use the existing AirDrop operations for device verification and sending.
Stop after refusal, expiry, or failure.
