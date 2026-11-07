import * as vscode from 'vscode'

export async function selectWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders
  if (!folders?.length) {
    await vscode.window.showErrorMessage('Open a workspace folder to use .sct.')
    return undefined
  }
  if (folders.length === 1) return folders[0]
  return (await vscode.window.showQuickPick(folders.map((folder) => ({
    label: folder.name,
    description: folder.uri.fsPath,
    folder
  })), { placeHolder: 'Select a workspace folder for .sct' }))?.folder
}
