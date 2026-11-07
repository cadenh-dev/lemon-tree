import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import type { ScryptOptions } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod/v4'
import { open, seal } from './seal.ts'
import type { ScryptParams, SealedField, VaultHeader } from '../shared/vault.ts'

const scrypt = promisify(scryptCallback) as (password: Buffer, salt: Buffer, keyLength: number,
  options: ScryptOptions) => Promise<Buffer>

const verifierText = Buffer.from('sct-vault-v1')
const verifierData = Buffer.from('vault-verifier')
const headerVersion = 1
const saltLength = 16
const ivLength = 12
const tagLength = 16
const maxMem = 256 * 1024 * 1024

// The defaults target about one second on a current laptop. The header stores them, so a later vault can raise the cost.
export const defaultScrypt: ScryptParams = { name: 'scrypt', n: 131072, r: 8, p: 1, keyLength: 32 }

const sealedSchema = z.object({ iv: z.string(), tag: z.string(), ciphertext: z.string() })
const headerSchema = z.object({
  version: z.literal(headerVersion),
  kdf: z.object({
    name: z.literal('scrypt'),
    n: z.number().int().min(2).max(1_048_576),
    r: z.number().int().min(1).max(32),
    p: z.number().int().min(1).max(16),
    keyLength: z.literal(32)
  }),
  salt: z.string(),
  verifier: sealedSchema
})

export async function readVaultHeader(file: string): Promise<VaultHeader | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('Cannot read the vault header. Check the storage permissions.', { cause: error })
  }
  const header = decodeHeader(text)
  if (!header) throw new Error('The vault header is damaged or has an unsupported version.')
  return header
}

export async function writeVaultHeader(file: string, header: VaultHeader): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(`${file}.tmp`, JSON.stringify(header, null, 2), { mode: 0o600 })
    await rename(`${file}.tmp`, file)
  } catch (error) {
    throw new Error('Cannot save the vault header. Check the storage permissions.', { cause: error })
  }
}

export async function createVaultHeader(passphrase: string): Promise<{ header: VaultHeader; masterKey: Buffer }> {
  const salt = randomBytes(saltLength)
  try {
    const masterKey = await deriveMasterKey(passphrase, defaultScrypt, salt.toString('base64'))
    const header: VaultHeader = {
      version: headerVersion,
      kdf: defaultScrypt,
      salt: salt.toString('base64'),
      verifier: encodeSealed(seal(masterKey, verifierText, verifierData))
    }
    return { header, masterKey }
  } finally {
    salt.fill(0)
  }
}

export async function deriveMasterKey(passphrase: string, kdf: ScryptParams, salt: string): Promise<Buffer> {
  const password = Buffer.from(passphrase, 'utf8')
  try {
    return await scrypt(password, Buffer.from(salt, 'base64'), kdf.keyLength, {
      N: kdf.n, r: kdf.r, p: kdf.p, maxmem: maxMem
    })
  } catch (error) {
    throw new Error('Cannot derive the vault key. The stored key settings are not usable.', { cause: error })
  } finally {
    password.fill(0)
  }
}

export function verifyPassphrase(masterKey: Buffer, header: VaultHeader): boolean {
  let opened: Buffer | undefined
  try {
    opened = open(masterKey, decodeSealed(header.verifier), verifierData)
    return opened.length === verifierText.length && timingSafeEqual(opened, verifierText)
  } catch {
    return false
  } finally {
    opened?.fill(0)
  }
}

function decodeHeader(text: string): VaultHeader | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const parsed = headerSchema.safeParse(value)
  if (!parsed.success) return undefined
  if (!isPowerOfTwo(parsed.data.kdf.n)) return undefined
  if (!isBase64(parsed.data.salt, saltLength)) return undefined
  if (!isBase64(parsed.data.verifier.iv, ivLength) || !isBase64(parsed.data.verifier.tag, tagLength)) return undefined
  if (!isBase64(parsed.data.verifier.ciphertext, verifierText.length)) return undefined
  return parsed.data
}

// A crafted header could ask scrypt for a huge cost. The schema bounds each value; this check bounds the shape.
function isPowerOfTwo(value: number): boolean {
  return value > 1 && Number.isInteger(Math.log2(value))
}

function isBase64(value: string, length: number): boolean {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false
  const decoded = Buffer.from(value, 'base64')
  return decoded.length === length && decoded.toString('base64') === value
}

export function encodeSealed({ iv, tag, ciphertext }: { iv: Buffer; tag: Buffer; ciphertext: Buffer }): SealedField {
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), ciphertext: ciphertext.toString('base64') }
}

export function decodeSealed(field: SealedField): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  return {
    iv: Buffer.from(field.iv, 'base64'),
    tag: Buffer.from(field.tag, 'base64'),
    ciphertext: Buffer.from(field.ciphertext, 'base64')
  }
}
