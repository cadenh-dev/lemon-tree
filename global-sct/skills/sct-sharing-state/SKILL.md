---
name: sct-sharing-state
description: Inspect the local global.sct device, verified AirDrop recipients, and pending transfer metadata before pairing or sharing selected secrets.
---

# Inspect global.sct sharing metadata

Call the `sharing_state` MCP tool with an empty object.

```json
{}
```

CLI equivalent:

```sh
printf '%s' '{}' | sct agent sharing_state --stdin
```

The user must approve the request in the local global.sct window.
The result contains this `device`, verified `peers`, and pending `incoming` transfer metadata.
Use a verified peer's `id` as `recipientId` for `send_secrets_to`.
Use `pair_device` if the intended device is absent.
Do not substitute a device name for its ID.
This state describes the local AirDrop workflow. Use `relay_status` for relay metadata.
Do not claim receipt or successful import from a pending transfer.
Stop after refusal, expiry, or failure.
