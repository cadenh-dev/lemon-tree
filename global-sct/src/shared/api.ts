import type { Project, ProjectInput, ProjectRename } from './projects'
import type { SecretInput, SecretMetadata, SecretReference, SecretUpdate } from './secrets'
import type { SharingAPI } from './sharing'
import type { RelayAPI } from './relay'
import type { AgentAPI } from './agent'
import type { CardsAPI } from './cards'
import type { DirectAPI } from './direct'
import type { WebRtcAPI } from './webrtc'
import type { ShareAPI } from './share'
import type { UnlockInput, VaultStatus } from './vault'
import type { PendingLink } from './transport'

export type SctPlatform =
  | 'aix'
  | 'android'
  | 'cygwin'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'netbsd'
  | 'openbsd'
  | 'sunos'
  | 'win32'

// The user's choice. `system` follows the OS light or dark setting.
export type ThemePreference = 'light' | 'dark' | 'system'

// The variant on screen: Cream for light, Terminal for dark.
export type ThemeVariant = 'cream' | 'terminal'

export interface ProtocolStatus {
  supported: boolean
  registered: boolean
  owner: string | null
  conflict: boolean
  detail: string
}

export interface SctAPI extends SharingAPI, RelayAPI, AgentAPI, CardsAPI, DirectAPI, WebRtcAPI, ShareAPI {
  platform: SctPlatform
  // The variant at window creation. onThemeChanged reports later changes.
  theme: ThemeVariant
  getThemePreference: () => Promise<ThemePreference>
  setThemePreference: (preference: ThemePreference) => Promise<ThemeVariant>
  onThemeChanged: (listener: (variant: ThemeVariant) => void) => () => void
  getProtocolStatus: () => Promise<ProtocolStatus>
  registerProtocol: (replace: boolean) => Promise<ProtocolStatus>
  removeProtocol: () => Promise<ProtocolStatus>
  getPendingLink: () => Promise<PendingLink | null>
  dismissPendingLink: (id: string) => Promise<void>
  onPendingLinkChanged: (listener: () => void) => () => void
  listProjects: () => Promise<Project[]>
  pickDirectory: () => Promise<string | null>
  addProject: (input: ProjectInput) => Promise<Project>
  renameProject: (input: ProjectRename) => Promise<Project>
  deleteProject: (id: string) => Promise<void>
  listSecrets: () => Promise<SecretMetadata[]>
  addSecret: (input: SecretInput) => Promise<SecretMetadata>
  updateSecret: (input: SecretUpdate) => Promise<SecretMetadata>
  deleteSecret: (input: SecretReference) => Promise<void>
  getVaultLocation: () => Promise<string>
  chooseVaultLocation: () => Promise<string | null>
  getVaultStatus: () => Promise<VaultStatus>
  unlockVault: (input: UnlockInput) => Promise<VaultStatus>
  lockVault: () => Promise<VaultStatus>
  forgetDevice: () => Promise<VaultStatus>
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string }
