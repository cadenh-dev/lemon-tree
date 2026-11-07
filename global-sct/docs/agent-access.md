# Local Agent Access

global.sct exposes its core operations through a TypeScript CLI and a stdio MCP server.
Both interfaces use the same request checks and local approval window.
Responses contain metadata and fixed outcomes, without secret values or process logs.
Local project operations require no relay configuration, paired device, or network connection.

## Build and install

From the repository root, run:

```sh
bun run package:mac
bun run install:cli
```

The first command builds and signs the app, CLI, MCP server, SDK, fixed demo, and skills. See [signing setup](macos-signing.md).
The second command installs the `sct` command script in `~/.local/bin`.
Use `bun run build:demo` to rebuild only the demo at `out/demo/index.cjs`.

## CLI

Inspect the available operations and input schemas:

```sh
sct agent --help
sct agent --schema
```

Supply a JSON object through stdin:

```sh
printf '%s' '{}' | sct agent list_secrets --stdin
```

The example selects the nearest registered parent of the caller's working directory.
Supply `projectId` to select a specific registered project.
`project_setup` returns that ID when it finds or registers a folder.
Use secret IDs from `list_secrets`. IDs are references, not credential values.

The CLI also accepts an envelope through `sct agent --stdin`:

```json
{
  "operation": "list_secrets",
  "input": {}
}
```

The result contains `requestId`, `status`, and an operation result or a fixed error.
The status is `completed`, `refused`, `expired`, or `failed`.
The CLI returns exit code 0 only for a completed request.
Stop after refusal or expiry. A retry requires a new request and local approval.

## Operations

Each operation has the same name in MCP and the CLI.
The `projectId` field is optional where the table lists it.
All operations also accept an optional ISO 8601 `expiresAt` deadline.

| Operation | Input fields | Result |
|---|---|---|
| `project_setup` | `directory`, optional `name` | Existing or newly registered project metadata |
| `list_secrets` | `projectId` | Secret IDs and environment names in one project |
| `describe_secret` | `projectId`, `secretId` | One secret's metadata |
| `delete_secret` | `projectId`, `secretId` | The deleted secret ID |
| `run_demo` | `projectId`, `secretId` | `exitCode` and `secretPresent` for the fixed demo |
| `sharing_state` | None | This device, verified AirDrop recipients, and pending transfer metadata |
| `pair_device` | `action: "export"`, or `action: "verify"` with `path` | A public device card path or verified device metadata |
| `send_secrets_to` | `projectId`, `secretIds`, `recipientId` | An encrypted transfer path and `awaiting-transport` status |
| `relay_status` | None | Relay connection and cached peer, inbox, sent, and remote task metadata |
| `request_remote_demo` | `grantId` | The `taskId` and `queued` status of a remote demo task |

Unknown fields and arbitrary commands fail request checks.
Keep vault storage outside source folders. No operation creates an `.env` file or replacement secret file in the project.

## Caller authentication

global.sct identifies the calling program before it checks the request.
It reads the parent processes up to the first process with a listed agent name.
Then the platform signature check tests that running process against the agent's requirement.

| Agent | Executable name | macOS | Windows | Linux |
|---|---|---|---|---|
| Claude Code | `claude`, `claude.exe` | Identifier `com.anthropic.claude-code`, Apple Developer ID, Team ID `Q6L2SF6YDW` | Authenticode signature with an `Anthropic` subject | No code signature. The caller is unverified |
| Visual Studio Code | `code`, `Code`, `Code.exe` | Identifier `com.microsoft.VSCode`, Apple signature anchor, Team ID `UBF8T346G9` | Valid Authenticode signature with a `Microsoft Corporation` subject and `Visual Studio Code` product metadata | No code signature. The caller is unverified |

The macOS reader uses the full executable path and matches its complete name.
It uses `lsof` when `ps` reports a short name. It does not match a partial or generic name.
The signature check still checks the running process by PID.

The official [VS Code 1.145.0 macOS package](https://vscode.download.prss.microsoft.com/dbazure/download/stable/a717861c07586a53d83b80d742cd3f59b20a6273/VSCode-darwin-arm64.zip) confirms the app identifier and Team ID.
Its `Code Helper (Plugin)` executable has signing identifier `com.microsoft.VSCode.helper` and Team ID `UBF8T346G9`.
The requested `com.microsoft.VSCode.helper.plugin` identifier remains unconfirmed, so the known caller list omits that helper.
The caller walk continues to the main app ancestor.

`src/main/caller.ts` contains this list.
The MCP client is usually the direct parent of `sct mcp`.
A shell tool usually starts `sct agent`, so the agent is a more distant ancestor.

- A listed agent that passes its check becomes a verified caller. The approval window shows its name.
- A process with a listed agent name that fails the macOS or Windows check is an impostor. global.sct rejects each request before local approval.
  The result has status `failed` and names the failed signature check.
- On Linux, a listed agent name gives an unverified caller. Linux has no code signature to check.
- If no listed agent is among the ancestors, the approval window labels the caller as unverified.
  Before approval, the user must also select **I started this request myself**.

Caller authentication identifies the program. It does not replace local approval.
A verified agent can still request an operation that the user must refuse.
Another program that the verified agent starts also passes this check.

## VS Code client

The VS Code extension uses the local CLI. It receives secret names and IDs only.
The command **Open terminal with global.sct secrets** opens a terminal with `sct run --interactive -- <shell>`.
The extension host never receives the values.
See [VS Code extension](vscode.md).

## Local approval

Each request requires explicit approval in the local global.sct window.
The window shows the operation, project, selected secret names, request ID, and deadline where applicable.
The default deadline is two minutes. A caller can request up to five minutes from submission.
Refusal, expiry, or disconnection prevents a pending request from receiving approval.
Approval applies to one request only. It cannot authorize another task or secret selection.
A `send_secrets_to` request that the user approves then enters the share gate.
The share dialog shows the recipient, project, and secret names, and asks for the vault passphrase.
The agent never receives or supplies the passphrase.
The share gate releases one operation and expires after two minutes.

The agent cannot approve through CLI input, MCP, or a tool response.
Host approval in an MCP client does not replace the local global.sct decision.
`run_demo` accepts only the fixed environment demo, without arbitrary commands or unrestricted process logs.
The child and its descendants can read or copy injected values.

## Stdio MCP

Configure an MCP client with the installed executable:

```json
{
  "mcpServers": {
    "sct": {
      "command": "/Users/YOUR_USER/.local/bin/sct",
      "args": ["mcp"]
    }
  }
}
```

Replace the command path with your installed CLI path. Claude Code also accepts `${HOME}/.local/bin/sct`.
On Windows, a direct MCP client cannot start the `sct.cmd` shim. Use the full `sct.exe` path, or start the shim through `cmd`:

```json
{
  "mcpServers": {
    "sct": {
      "command": "cmd",
      "args": ["/c", "sct", "mcp"]
    }
  }
}
```

This configuration contains no credentials and needs no environment settings for local operations.
The client must connect stdin and stdout through private pipes.
Stdout carries MCP messages only. Fixed diagnostics use stderr without submitted contents.
Closing stdin ends the MCP process and cancels pending requests.

The server exposes the operations above as tools.
It also exposes each workflow as a prompt with the operation name and a Markdown resource at `global-sct://skills/<operation>`.
MCP `run_demo` requires a saved `secretId`. MCP does not accept a plaintext credential value.
See [the Claude Code demo project](../examples/claude-code/README.md) for a configuration that allows only the `sct` server.
Claude Code permission decisions apply first. Each allowed call still requires the local global.sct decision.
PR #48 checked discovery, approval, refusal, expiry, reused approvals, rejected inputs, and transcripts through Claude Code 2.1.287.

## Skills

The repository contains one skill for each operation under `skills/sct-<operation-name>/SKILL.md`.
Skill folder names replace underscores with hyphens.
Inspect the installed bundle:

```sh
sct skills
```

The result contains the bundled directory and skill names.
For offline installation, copy the desired skill folders into your agent's skill directory.
Common locations are `~/.agents/skills` for Codex and `~/.claude/skills` for Claude Code.
If the skills CLI is available, install from GitHub:

```sh
npx skills add cadenh-dev/global.sct
```

Select the workflows you need. A skill does not grant access or bypass local approval.
MCP clients can also read the bundled prompts and resources without copying files.

## Private stdin input

Use saved references when possible. Never place secret values in arguments, shell substitutions, inline shell text, logs, or MCP calls.
The private CLI channel supports an unsaved value for the fixed demo.
The calling process writes an envelope with `operation: "run_demo"`, `input`, and a top-level `stdinValue`.
Omit `input.secretId` when supplying `stdinValue`. Supply exactly one source.
Do not save the envelope in the project folder or print its contents.

The selected value enters the fixed demo as `SCT_DEMO_TOKEN` in the child environment.
The result reports presence and the exit code. It does not return the value or process output.
An empty value counts as present.

## Pairing, sending, and relay scope

`pair_device` uses the existing public AirDrop device cards.
The user compares the code on both Macs before local approval of pairing.
Exchange cards and complete local pairing on both Macs for sharing in both directions.
`sharing_state` returns the verified recipient IDs for `send_secrets_to`.

Sending encrypts the selected secrets for one verified recipient and opens the AirDrop picker.
The user must choose that same recipient in macOS.
The agent approval and the share passphrase are two separate local steps.
`awaiting-transport` does not prove delivery, receipt, or import.
The recipient accepts the file and imports it through the desktop app.

`relay_status` and `request_remote_demo` start the relay connection only for an approved request. Other operations open no connection.
`relay_status` returns metadata without tokens, payloads, wrapped keys, or private keys.
Identify rows as cached when `connection` is not `connected`. Use `updatedAt` to report their age.
This interface does not provide relay pairing, publication, or delivery acknowledgments.

`request_remote_demo` asks the recipient of a relay transfer to run the fixed demo with that grant.
The `grantId` is the `messageId` of a sent transfer with `state: "received"`.
The agent session writes an encrypted request file. The global.sct desktop app sends the task and must be open.
The recipient approves the task on its own Mac. Read the outcome in the `tasks` rows of `relay_status`.
`delivered` means that the recipient saved the task. It does not mean approval or execution.
See [remote demo tasks](architecture.md#remote-demo-tasks).
See [relay configuration](relay.md) for `SCT_RELAY` and the cache behavior.

## Standalone runtime

`sct run` needs no Agent Access approval. For a manual demo, save `SCT_DEMO_TOKEN` in a registered project and run from that project:

```sh
sct run -- node /absolute/path/to/global.sct/out/demo/index.cjs
```

The demo prints presence only. It creates no project files and uses no network service.
