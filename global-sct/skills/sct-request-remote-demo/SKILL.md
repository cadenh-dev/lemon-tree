---
name: sct-request-remote-demo
description: Ask a paired relay recipient to run the fixed global.sct environment demo with the secrets of one relay transfer that it imported. The recipient approves on its own Mac.
---

# Request a remote global.sct demo run

Call `relay_status` first. Select a `sent` row with `state: "received"`. Its `messageId` is the grant ID.
Then call the `request_remote_demo` MCP tool with that grant ID.

```json
{"grantId":"00000000-0000-4000-8000-000000000001"}
```

CLI equivalent:

```sh
printf '%s' '{"grantId":"00000000-0000-4000-8000-000000000001"}' | sct agent request_remote_demo --stdin
```

Replace the example ID with an actual message ID.
The user must approve this exact request in the local global.sct window.
The result contains `taskId` and `status: "queued"`. The global.sct desktop app encrypts and sends the task. It must be open.
The recipient must approve the task on its own Mac within 24 hours.
The task can only run the fixed demo with the secrets of that grant. It accepts no command, executable, or other operation.

Read the outcome later with `relay_status`. Find the `tasks` row with `direction: "sent"` and the same `messageId` as `taskId`.
`delivered` means that the recipient saved the task. It does not mean approval or execution.
Report success only if `state` is `completed`, `exitCode` is `0`, and `secretPresent` is `true`.
Report `refused`, `expired`, `failed`, and `uncertain` as they are. `uncertain` means that the recipient app stopped during the run.
The result contains no process output or secret value.
Do not submit the same request again automatically. A new request needs a new local approval and a new remote approval.
