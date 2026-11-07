// The vault header holds no secret. The passphrase derives the master key from it.
export interface VaultHeader {
  version: 1
  kdf: ScryptParams
  salt: string
  verifier: SealedField
}

export interface ScryptParams {
  name: 'scrypt'
  n: number
  r: number
  p: number
  keyLength: number
}

// A ciphertext with its IV and GCM tag. Every field is base64.
export interface SealedField {
  iv: string
  tag: string
  ciphertext: string
}

export type WrappedKey = SealedField

export interface VaultStatus {
  initialized: boolean
  locked: boolean
  rememberAvailable: boolean
  rememberEnabled: boolean
}

export interface UnlockInput {
  passphrase: string
  remember: boolean
}
