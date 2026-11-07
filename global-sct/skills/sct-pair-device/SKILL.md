---
name: sct-pair-device
description: Exchange public global.sct device cards and request local verification of another Mac before encrypted AirDrop sharing.
---

# Pair global.sct devices

Export this Mac's public card with the `pair_device` MCP tool:

```json
{"action":"export"}
```

The user must approve the request. The AirDrop picker lets the user send the card to the other Mac.
The result's `path` identifies a public `.sct-device` file. It contains no secret credential.

Request verification of the other Mac's card:

```json
{"action":"verify","path":"/absolute/path/to/device.sct-device"}
```

CLI equivalents:

```sh
printf '%s' '{"action":"export"}' | sct agent pair_device --stdin
printf '%s' '{"action":"verify","path":"/absolute/path/to/device.sct-device"}' | sct agent pair_device --stdin
```

The local global.sct window displays the device fingerprint and pairing code.
The user must compare that code on both Macs before approval.
Do not compare the code on the user's behalf or approve through another interface.
Exchange and verify cards on the other Mac for sharing in both directions.
Use `sharing_state` to obtain the verified recipient ID after completion.
This workflow verifies AirDrop device cards. It does not create a relay pair.
Stop if the codes differ, or after refusal, expiry, or failure.
