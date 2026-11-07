---
name: sct-project-setup
description: Find or register a local global.sct project when an agent needs its ID for secret metadata, sharing, or approved execution.
---

# global.sct project setup

Use the `project_setup` MCP tool to find or register an existing source folder.
Use an absolute `directory`. Supply `name` when the folder has no registered project.

```json
{"directory":"/absolute/path/to/project","name":"My project"}
```

CLI equivalent:

```sh
printf '%s' '{"directory":"/absolute/path/to/project","name":"My project"}' | sct agent project_setup --stdin
```

The user must approve the request in the local global.sct window.
The result contains the project `id`, `name`, and `directory`.
Reuse that `id` as `projectId` in later calls.
If `directory` is absent, global.sct uses the caller's working directory.
Keep vault storage outside the source folder. Create no project-local secret file.
Stop after refusal, expiry, or failure. Do not repeat a refused request without a new user instruction.
Use `sct agent --schema` to inspect the current input schema.
