---
name: sct-run-demo
description: Request the fixed global.sct environment demo with one selected saved secret or private CLI stdin input, without exposing its value.
---

# Run the approved global.sct demo

Use the `run_demo` MCP tool with a registered `projectId` and a `secretId` from `list_secrets`.
MCP accepts saved secret references only. Do not supply a plaintext value through MCP.

```json
{"projectId":"00000000-0000-4000-8000-000000000001","secretId":"00000000-0000-4000-8000-000000000002"}
```

CLI equivalent with a saved reference:

```sh
printf '%s' '{"secretId":"00000000-0000-4000-8000-000000000002"}' | sct agent run_demo --stdin
```

Replace the example IDs with actual metadata IDs.
The CLI example selects the project from the working directory.
The user must approve this exact request in the local global.sct window.
The fixed demo receives the selected value as `SCT_DEMO_TOKEN` in its environment.
Its result contains `exitCode` and `secretPresent`, without process logs.
Report success only if the outcome completes with `exitCode: 0` and `secretPresent: true`.

For an unsaved value, use the private CLI channel with `sct agent --stdin`.
The calling process writes an envelope with `operation: "run_demo"`, `input`, and a top-level `stdinValue`.
Omit `input.secretId` for this source. Supply exactly one input source.
Do not place the value in arguments, inline shell text, logs, MCP calls, or a project file.
The child and its descendants can read or copy injected values.
This operation accepts no arbitrary executable, command, or task.
Stop after refusal, expiry, or failure. Do not repeat execution automatically.
