import * as vscode from 'vscode'
import { sctExecutable } from '../../env/src/executable'
import { readSctStatus } from './sct'
import { SecretTree } from './secrets'
import { selectWorkspaceFolder } from './workspace'

export function activate(context: vscode.ExtensionContext): void {
  const secrets = new SecretTree()
  const view = vscode.window.createTreeView('sct.secrets', { treeDataProvider: secrets })
  view.message = 'Use Refresh global.sct secrets to request metadata.'
  context.subscriptions.push(
    secrets,
    view,
    vscode.commands.registerCommand('sct.showStatus', showStatus),
    vscode.commands.registerCommand('sct.refreshSecrets', () => secrets.refresh(view)),
    vscode.commands.registerCommand('sct.openTerminal', openTerminal)
  )
}

async function openTerminal(): Promise<void> {
  const folder = await selectWorkspaceFolder()
  if (!folder) return
  try {
    vscode.window.createTerminal({
      name: `global.sct: ${folder.name}`,
      shellPath: sctExecutable(),
      shellArgs: ['run', '--interactive', '--', vscode.env.shell],
      cwd: folder.uri.fsPath
    }).show()
  } catch (error) {
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Cannot open the global.sct terminal.')
  }
}

async function showStatus(): Promise<void> {
  try {
    const status = await readSctStatus()
    await vscode.window.showInformationMessage(`global.sct ${status.version} at ${status.executable}`)
  } catch {
    await vscode.window.showErrorMessage('Cannot run global.sct. Install the sct CLI and make it available on PATH, or set SCT_CLI.')
  }
}
