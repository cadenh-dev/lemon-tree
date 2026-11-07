# VS Code extension

The VS Code extension is a local client of the global.sct app.
It shows secret metadata for the open workspace folder and opens a terminal with the project secrets.
It never receives a secret value or a private key.

## Requirements

- VS Code 1.145 or later.
- The global.sct app and the `sct` CLI installed on the same device.
- A workspace folder that is registered as a global.sct project.
- The vault unlocked in the global.sct app or through the CLI.

The extension starts the installed CLI. It does not bundle a second copy.
On Windows, the extension uses `sct.exe`, not the `sct.cmd` shim.
Set `SCT_CLI` to the full path of `sct.exe` when the CLI is not on `PATH`.

## Build and run

Run these commands from the repository root:

```sh
bun install
bun run build:vscode
code --extensionDevelopmentPath=packages/vscode
```

This writes `packages/vscode/dist/extension.js`.
The package is private. There is no VSIX release package yet.
Use the development host until a release package exists.

## Commands

Open the Command Palette and run one of these commands:

| Command | Result |
|---|---|
| `Show global.sct status` | Runs `sct --version` and shows the version and executable path |
| `Refresh global.sct secrets` | Reads secret names and IDs for the selected workspace folder |
| `Open terminal with global.sct secrets` | Opens a terminal that runs `sct run --interactive -- <shell>` |

### Secret metadata

The **global.sct secrets** view is in the Explorer.
Select **Refresh global.sct secrets** in the view title.

The extension runs this command in the selected workspace folder:

```sh
sct agent list_secrets --stdin
```

The request goes through the local Agent Access approval window in the global.sct app.
The extension receives names and IDs only.
It does not receive values, wrapped keys, or private keys.

If the workspace has more than one folder, the extension asks you to select one.
A vault that is locked stops the request. Unlock the vault and refresh again.

### Terminal with secrets

The terminal command opens a terminal with this command:

```sh
sct run --interactive -- <shell>
```

The working folder is the selected workspace folder.
Only this terminal gets the project secrets.
The extension host does not receive the values, and no other terminal gets them.

On Windows, the shell is the VS Code shell, for example PowerShell.
On macOS and Linux, it is the configured shell.

## Approval and caller identity

The global.sct app still owns the approval decision.
The extension does not add a second approval window.

The caller walk identifies the editor process:

- Windows: `Code.exe` with a valid Microsoft Authenticode signature and the `Visual Studio Code` product name.
- macOS: the `Code` app with the `com.microsoft.VSCode` identifier and the Microsoft Team ID.
- Linux: the name `code` gives an unverified caller. The approval window asks for the extra confirmation.

Open the global.sct app and approve the request.
The approval applies to one request and one deadline.

## Host check (2026-11-05)

The Windows host has VS Code 1.143.1.
The extension requires VS Code `^1.145.0`.
The development host does not load the extension because of this version difference.
Update VS Code to 1.145 or later before the live extension check.
The extension build passes.

## Limits

- The extension has no relay dependency.
- It does not put secrets in the extension host or in `environmentVariableCollection`.
- It uses the selected workspace folder as the project lookup path.
- It does not refresh metadata automatically. Use the refresh command.
- It does not start a second terminal with the same secrets.
- The current build passes type checks. A live VS Code check remains a release check.

## Troubleshooting

| Problem | Action |
|---|---|
| `Cannot run global.sct` | Install the `sct` CLI, add it to `PATH`, or set `SCT_CLI` to the full `sct.exe` path |
| No secrets appear | Unlock the vault, register the folder as a project, and approve the request in the app |
| The request stays pending | Open the global.sct window and check the Agent Access request |
| The terminal opens without secrets | Check the workspace folder, the vault lock, and the approval state |
| More than one workspace folder exists | Run the command again and select the correct folder |
| Windows cannot start `sct.cmd` | Use `sct.exe` or set `SCT_CLI` to its full path |

## Related docs

- [Agent Access](agent-access.md)
- [Runtime injection](runtime-injection.md)
- [Windows and Linux](windows-linux.md)
