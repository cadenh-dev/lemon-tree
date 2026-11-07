// Secret values travel only from the renderer to the main process. Responses carry metadata only.
export interface SecretMetadata {
  id: string
  projectId: string
  name: string
}

export interface SecretInput {
  projectId: string
  name: string
  value: string
}

export interface SecretUpdate {
  projectId: string
  id: string
  value: string
}

export interface SecretReference {
  projectId: string
  id: string
}
