import * as vscode from 'vscode'
import { readSecretMetadata } from './sct'
import type { SctSecret } from './sct'
import { selectWorkspaceFolder } from './workspace'

export class SecretTree implements vscode.TreeDataProvider<SctSecret>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.changed.event
  private secrets: SctSecret[] = []
  private refreshing = false

  getTreeItem(secret: SctSecret): vscode.TreeItem {
    const item = new vscode.TreeItem(secret.name, vscode.TreeItemCollapsibleState.None)
    item.id = secret.id
    item.description = secret.id
    item.tooltip = `${secret.name}\nID: ${secret.id}`
    return item
  }

  getChildren(): SctSecret[] {
    return this.secrets
  }

  async refresh(view: vscode.TreeView<SctSecret>): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    try {
      const folder = await selectWorkspaceFolder()
      if (!folder) return
      this.secrets = []
      this.changed.fire()
      view.description = folder.name
      view.message = 'Waiting for a decision in the global.sct app.'
      this.secrets = await readSecretMetadata(folder.uri.fsPath)
      view.message = this.secrets.length ? undefined : 'This project has no saved secrets.'
      this.changed.fire()
    } catch (error) {
      view.message = 'Cannot read the global.sct secret metadata.'
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : view.message)
    } finally {
      this.refreshing = false
    }
  }

  dispose(): void {
    this.changed.dispose()
  }
}
