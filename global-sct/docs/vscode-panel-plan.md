# VS Code view panel plan

Status: proposal. No implementation is approved yet.

## Goal

Add a dedicated global.sct panel in VS Code.
The desktop app stays the main GUI.
The extension stays a local thin client.

The panel must work without the relay.
It must use only the local app and the installed `sct` CLI.

## Recommended shape

Use an Activity Bar view container named **global.sct**.
Use a native VS Code `TreeView` first.
Do not add a webview in the first phase.

The panel has these parts:

- **Status**: app version, workspace folder, and the selected project.
- **Secrets**: secret names and IDs only.
- **Actions**: Refresh secrets, Open terminal, Start global.sct, and Show status.
- **Welcome**: shown when no folder is open or no project matches the folder.

Add a status bar item named **global.sct**.
A click on the status bar item opens the panel.

Move the existing `sct.secrets` view from the Explorer to the new container.
Do not show the same view in two places.

## Why native first

A native tree view:

- Uses the VS Code theme, keyboard navigation, and screen reader support.
- Needs no webview message bridge.
- Needs no content security policy or nonce handling.
- Keeps the extension host small.
- Cannot show or store secret values.

A webview is a later option if the native panel is not enough.

## User flow

1. The user opens a workspace folder in VS Code.
2. The extension reads the workspace folder.
3. The user selects **Refresh global.sct secrets**.
4. The extension runs `sct agent list_secrets --stdin` in the folder.
5. The global.sct app shows the local approval window.
6. The app returns secret names and IDs only.
7. The panel shows the names and IDs.
8. The user selects **Open terminal with global.sct secrets**.
9. The extension opens a terminal that runs `sct run --interactive -- <shell>`.
10. The terminal has the secret values in its environment.

The panel never receives a secret value.
The extension host never receives a secret value.

## Standalone rules

- No relay.
- No network connection.
- No socket, pipe, or background service.
- No new server.
- No secret value in the panel, workspace state, or logs.
- No secret value in the extension host.
- The app remains the source of truth for the vault, projects, pairing, and sharing.
- The CLI remains the only bridge between the extension and the app.
- Remove `ELECTRON_RUN_AS_NODE` from every CLI child process.
- A locked vault shows the app approval or unlock step. The panel does not store the passphrase.
- The panel does not refresh automatically. The user selects Refresh.

## Files

### `packages/vscode/package.json`

Add:

- `viewsContainers.activitybar` with `id: "sct"`, title `global.sct`, and an icon.
- `views.sct` with the `sct.secrets` tree.
- `viewsWelcome` for no folder and no project.
- `menus.view/title` for Refresh, Open terminal, Start app, and Show status.
- `menus.view/item/context` for metadata actions.
- `configuration` for an optional `sct.cliPath` setting.
- The new commands:
  - `sct.focusView`
  - `sct.startApp`
  - `sct.openTerminal`
  - `sct.refreshSecrets`
  - `sct.showStatus`

### `packages/vscode/src/extension.ts`

- Create the tree view in the new container.
- Register the new commands.
- Add the status bar item.
- Set the view description to the workspace folder.
- Keep the existing command behavior.

### `packages/vscode/src/secrets.ts`

- Add a context value to each secret item.
- Add a clear empty state.
- Keep names and IDs only.

### `packages/vscode/src/sct.ts`

- Add a `startApp` function.
- Keep the existing metadata and status functions.
- Keep the CLI environment cleanup.

### `packages/vscode/src/workspace.ts`

No change. Reuse the folder selection.

### Docs

Update `docs/vscode.md` with the panel, actions, and limits.

## Phases

### Phase 1: Native panel

- Add the view container and move the tree.
- Add the welcome content.
- Add the title and context actions.
- Add the status bar item.
- Add **Start global.sct**.
- Add the optional `sct.cliPath` setting.
- Update the docs.

### Phase 2: Optional webview

Only if the native panel is not enough.

- Add a `WebviewView` for status and actions.
- Keep the secret list in the native tree.
- Send metadata only to the webview.
- Use a strict content security policy and a nonce.
- Use VS Code theme variables, not app colors.
- Add no network access and no secret values.

### Phase 3: Verification

- VS Code 1.145 or later.
- Locked vault.
- No workspace folder.
- No matching project.
- More than one workspace folder.
- Terminal isolation.
- Unverified caller on Windows and Linux.
- Keyboard-only use.
- Cream and Terminal app themes are separate from the VS Code theme.

## Decisions to confirm

| Decision | Options | Recommendation |
|---|---|---|
| Panel type | Native tree or webview | Native tree first |
| Placement | Activity Bar or bottom panel | Activity Bar |
| Explorer view | Keep or move | Move to the new container |
| Start app action | Add or omit | Add |
| CLI path setting | Add or use only `SCT_CLI` | Add `sct.cliPath` |

## Out of scope

- Secret values or a reveal action.
- Relay or network use from the extension.
- A second vault, passphrase store, or approval dialog.
- Automatic refresh.
- A full copy of the desktop app UI.
- WebAuthn.

## Verification boundary

The panel is a convenience surface.
The desktop app remains the only full GUI.
A panel failure must not block the app, the CLI, or a terminal.
