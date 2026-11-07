import { AsyncEntry } from '@napi-rs/keyring'

// The optional "remember this device" store. It holds at most one master key.
export interface SecretStore {
  read(): Promise<Buffer | null>
  write(key: Buffer): Promise<void>
  clear(): Promise<void>
  available(): Promise<boolean>
}

const account = 'master-key'

// The optional "remember this device" store. It holds one master key under the global.sct service.
export class KeyringSecretStore implements SecretStore {
  private readonly service: string

  constructor(service: string) {
    this.service = service
  }

  async read(): Promise<Buffer | null> {
    try {
      const key = await this.entry().getSecret()
      return key ? Buffer.from(key) : null
    } catch {
      // A locked or missing secret service behaves like an empty store. The passphrase still works.
      return null
    }
  }

  async write(key: Buffer): Promise<void> {
    await this.entry().setSecret(key)
  }

  async clear(): Promise<void> {
    try {
      await this.entry().deleteCredential()
    } catch {
      // A missing item is not an error.
    }
  }

  async available(): Promise<boolean> {
    try {
      await this.entry().getSecret()
      return true
    } catch {
      return false
    }
  }

  private entry(): AsyncEntry {
    return new AsyncEntry(this.service, account)
  }
}

// A system with no secret service. The passphrase is the only unlock.
export class PassphraseOnlySecretStore implements SecretStore {
  async read(): Promise<Buffer | null> {
    return null
  }

  async write(): Promise<void> {
    // No store exists. The caller checks available() before it asks for this.
  }

  async clear(): Promise<void> {
    // No store exists.
  }

  async available(): Promise<boolean> {
    return false
  }
}

// The test store. It uses no OS access and needs no global state.
export class InMemorySecretStore implements SecretStore {
  private key: Buffer | null = null

  async read(): Promise<Buffer | null> {
    return this.key ? Buffer.from(this.key) : null
  }

  async write(key: Buffer): Promise<void> {
    this.key?.fill(0)
    this.key = Buffer.from(key)
  }

  async clear(): Promise<void> {
    this.key?.fill(0)
    this.key = null
  }

  async available(): Promise<boolean> {
    return true
  }
}

export async function createSecretStore(service: string): Promise<SecretStore> {
  const keyring = new KeyringSecretStore(service)
  return await keyring.available() ? keyring : new PassphraseOnlySecretStore()
}
