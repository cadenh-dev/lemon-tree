import type { Project } from '../../shared/projects'
import type { SecretMetadata } from '../../shared/secrets'

export type Loaded<T> = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ready'; value: T }

export type Run = (working: string, operation: () => Promise<string>) => Promise<boolean>

export type UpdateProjects = (change: (current: Project[]) => Project[]) => void

export type UpdateSecrets = (change: (current: SecretMetadata[]) => SecretMetadata[]) => void

export type SharingTab = 'devices' | 'secrets' | 'receive' | 'relay' | 'link' | 'direct' | 'webrtc' | 'send'
