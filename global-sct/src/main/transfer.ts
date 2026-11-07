import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, sign, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import type { SharingDevice } from '../shared/sharing'
import { pairingLinkLimit } from '../shared/sharing'

export const transferLimit = 8 * 1024 * 1024
export const transferLifetime = 24 * 60 * 60 * 1000

export interface DeviceCard {
  format: 'sct-device'
  version: 1
  name: string
  encryptionKey: string
  signingKey: string
}

export interface DeviceIdentity {
  card: DeviceCard
  encryptionKey: KeyObject
  signingKey: KeyObject
}

export interface TransferSecret {
  name: string
  value: string
}

export interface TransferPayload {
  projectName: string
  secrets: TransferSecret[]
}

export interface TransferEnvelope {
  format: 'sct-transfer'
  version: 1
  id: string
  sender: string
  recipient: string
  createdAt: number
  expiresAt: number
  ephemeralKey: string
  iv: string
  tag: string
  ciphertext: string
  signature: string
}

export function createIdentity(name: string): DeviceIdentity {
  const encryption = generateKeyPairSync('x25519')
  const signing = generateKeyPairSync('ed25519')
  return {
    card: { format: 'sct-device', version: 1, name,
      encryptionKey: exportPublic(encryption.publicKey), signingKey: exportPublic(signing.publicKey) },
    encryptionKey: encryption.privateKey,
    signingKey: signing.privateKey
  }
}

export function encodeIdentity(identity: DeviceIdentity): Buffer {
  return Buffer.from(JSON.stringify({ name: identity.card.name,
    encryptionKey: identity.encryptionKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    signingKey: identity.signingKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') }))
}

export function decodeIdentity(contents: Buffer): DeviceIdentity {
  const data = readObject(contents)
  const encryptionKey = createPrivateKey({ key: decodeBase64(data.encryptionKey, 48), type: 'pkcs8', format: 'der' })
  const signingKey = createPrivateKey({ key: decodeBase64(data.signingKey, 48), type: 'pkcs8', format: 'der' })
  if (encryptionKey.asymmetricKeyType !== 'x25519' || signingKey.asymmetricKeyType !== 'ed25519') throw invalid()
  return { card: requireCard({ format: 'sct-device', version: 1, name: data.name,
    encryptionKey: exportPublic(createPublicKey(encryptionKey)), signingKey: exportPublic(createPublicKey(signingKey)) }),
  encryptionKey, signingKey }
}

export function readDeviceCard(contents: Buffer): DeviceCard {
  if (contents.length > 4096) throw invalid()
  return requireCard(readObject(contents))
}

export function encodePairingLink(card: DeviceCard): string {
  const contents = Buffer.from(JSON.stringify(card))
  readDeviceCard(contents)
  return `global-sct://pair/v1/${contents.toString('base64url')}`
}

export function readPairingLink(input: unknown): DeviceCard {
  const encoded = requirePairingLink(input)
  const contents = Buffer.from(encoded, 'base64url')
  if (contents.toString('base64url') !== encoded) throw invalidPairingLink()
  return readDeviceCard(contents)
}

function requirePairingLink(input: unknown): string {
  // Check the link and encoded card limits before allocating the decoded bytes.
  if (typeof input !== 'string' || input.length > pairingLinkLimit) {
    throw invalidPairingLink()
  }
  // Old links remain usable by paste. The fork does not register the upstream scheme.
  const prefix = ['global-sct://pair/v1/', 'sct://pair/v1/'].find((value) => input.startsWith(value))
  if (!prefix) throw invalidPairingLink()
  const encoded = input.slice(prefix.length)
  if (!encoded || encoded.length > Math.ceil(4096 * 4 / 3) || encoded.length % 4 === 1 || /[^A-Za-z0-9_-]/.test(encoded)) {
    throw invalidPairingLink()
  }
  return encoded
}

function invalidPairingLink(): Error {
  return new Error('The pairing link is invalid. Paste a global-sct://pair/v1/ link from the other device.')
}

export function describeDevice(card: DeviceCard): SharingDevice {
  const id = createHash('sha256').update(JSON.stringify([card.encryptionKey, card.signingKey])).digest('hex')
  return { id, name: card.name, fingerprint: id.toUpperCase().replace(/(.{4})(?=.)/g, '$1 ') }
}

export function pairingCode(local: DeviceCard, peer: DeviceCard): string {
  return formatCode(['sct-pair-v1', ...[describeDevice(local).id, describeDevice(peer).id].sort()])
}

// The relay code also binds both relay identities, so it differs from the AirDrop code of the same two devices.
export function relayPairingCode(local: DeviceCard, localIdentity: string, peer: DeviceCard, peerIdentity: string): string {
  return formatCode(['sct-relay-pair-v1', ...[`${localIdentity}/${describeDevice(local).id}`, `${peerIdentity}/${describeDevice(peer).id}`].sort()])
}

function formatCode(parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24).toUpperCase().replace(/(.{4})(?=.)/g, '$1 ')
}

export function encryptTransfer(identity: DeviceIdentity, recipient: DeviceCard, projectName: string,
  secrets: readonly { name: string; value: Buffer }[], now = Date.now()): Buffer {
  const ephemeral = generateKeyPairSync('x25519')
  const header = { format: 'sct-transfer' as const, version: 1 as const, id: randomUUID(),
    sender: describeDevice(identity.card).id, recipient: describeDevice(recipient).id,
    createdAt: now, expiresAt: now + transferLifetime, ephemeralKey: exportPublic(ephemeral.publicKey),
    iv: randomBytes(12).toString('base64') }
  const key = deriveKey(ephemeral.privateKey, publicKey(recipient.encryptionKey, 'x25519'), header)
  const plaintext = Buffer.from(JSON.stringify({ projectName, secrets: secrets.map(({ name, value }) => ({ name, value: value.toString('utf8') })) }))
  try {
    const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64')).setAAD(authenticatedHeader(header))
    const body = { ...header, tag: '', ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64') }
    body.tag = cipher.getAuthTag().toString('base64')
    const contents = Buffer.from(JSON.stringify({ ...body, signature: sign(null, signedBody(body), identity.signingKey).toString('base64') }))
    if (contents.length > transferLimit) throw new Error('Select fewer secrets. A transfer cannot exceed 8 MiB.')
    return contents
  } finally {
    key.fill(0)
    plaintext.fill(0)
  }
}

export function readEnvelope(contents: Buffer): TransferEnvelope {
  const data = readObject(contents)
  if (data.format !== 'sct-transfer' || data.version !== 1 || typeof data.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(data.id) ||
    typeof data.sender !== 'string' || !/^[0-9a-f]{64}$/.test(data.sender) ||
    typeof data.recipient !== 'string' || !/^[0-9a-f]{64}$/.test(data.recipient) ||
    typeof data.createdAt !== 'number' || !Number.isSafeInteger(data.createdAt) ||
    typeof data.expiresAt !== 'number' || !Number.isSafeInteger(data.expiresAt) ||
    data.expiresAt <= data.createdAt || data.expiresAt - data.createdAt > transferLifetime) throw invalid()
  publicKey(data.ephemeralKey, 'x25519')
  decodeBase64(data.iv, 12)
  decodeBase64(data.tag, 16)
  decodeBase64(data.signature, 64)
  decodeBase64(data.ciphertext)
  return { format: data.format, version: data.version, id: data.id, sender: data.sender, recipient: data.recipient,
    createdAt: data.createdAt, expiresAt: data.expiresAt, ephemeralKey: data.ephemeralKey as string,
    iv: data.iv as string, tag: data.tag as string, ciphertext: data.ciphertext as string, signature: data.signature as string }
}

export function decryptTransfer(identity: DeviceIdentity, sender: DeviceCard, envelope: TransferEnvelope, now = Date.now()): TransferPayload {
  if (envelope.recipient !== describeDevice(identity.card).id) throw new Error('This transfer belongs to a different device.')
  if (envelope.sender !== describeDevice(sender).id ||
    !verify(null, signedBody(envelope), publicKey(sender.signingKey, 'ed25519'), Buffer.from(envelope.signature, 'base64'))) {
    throw new Error('The transfer signature is invalid. No secrets were imported.')
  }
  if (envelope.expiresAt <= now || envelope.createdAt > now + 60_000) throw new Error('This transfer expired or its creation time is invalid.')
  const key = deriveKey(identity.encryptionKey, publicKey(envelope.ephemeralKey, 'x25519'), envelope)
  let plaintext: Buffer | undefined
  let complete: Buffer | undefined
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
      .setAAD(authenticatedHeader(envelope)).setAuthTag(Buffer.from(envelope.tag, 'base64'))
    plaintext = decipher.update(Buffer.from(envelope.ciphertext, 'base64'))
    complete = Buffer.concat([plaintext, decipher.final()])
    return requirePayload(readObject(complete))
  } catch {
    throw new Error('Cannot decrypt this transfer. No secrets were imported.')
  } finally {
    key.fill(0)
    plaintext?.fill(0)
    complete?.fill(0)
  }
}

function requireCard(data: Record<string, unknown>): DeviceCard {
  if (Object.keys(data).length !== 5 || data.format !== 'sct-device' || data.version !== 1 || typeof data.name !== 'string' ||
    !data.name.trim() || data.name.length > 100 || /\p{Cc}/u.test(data.name)) throw invalid()
  publicKey(data.encryptionKey, 'x25519')
  publicKey(data.signingKey, 'ed25519')
  return { format: data.format, version: data.version, name: data.name,
    encryptionKey: data.encryptionKey as string, signingKey: data.signingKey as string }
}

export function publicKey(value: unknown, type: 'x25519' | 'ed25519'): KeyObject {
  const key = createPublicKey({ key: decodeBase64(value, 44), type: 'spki', format: 'der' })
  if (key.asymmetricKeyType !== type) throw invalid()
  return key
}

export function exportPublic(key: KeyObject): string {
  return key.export({ type: 'spki', format: 'der' }).toString('base64')
}

function deriveKey(privateKey: KeyObject, remote: KeyObject, header: Pick<TransferEnvelope, 'id' | 'sender' | 'recipient'>): Buffer {
  const shared = diffieHellman({ privateKey, publicKey: remote })
  try {
    return Buffer.from(hkdfSync('sha256', shared, Buffer.from(header.id), Buffer.from(`sct-transfer-v1/${header.sender}/${header.recipient}`), 32))
  } finally {
    shared.fill(0)
  }
}

function authenticatedHeader(header: Omit<TransferEnvelope, 'tag' | 'ciphertext' | 'signature'>): Buffer {
  return Buffer.from(JSON.stringify([header.format, header.version, header.id, header.sender, header.recipient,
    header.createdAt, header.expiresAt, header.ephemeralKey, header.iv]))
}

function signedBody(body: Omit<TransferEnvelope, 'signature'>): Buffer {
  return Buffer.concat([authenticatedHeader(body), Buffer.from(body.tag, 'base64'), Buffer.from(body.ciphertext, 'base64')])
}

export function requirePayload(data: Record<string, unknown>): TransferPayload {
  if (typeof data.projectName !== 'string' || !data.projectName || data.projectName.length > 100 ||
    !Array.isArray(data.secrets) || data.secrets.length === 0 || data.secrets.length > 1000) throw invalid()
  const names = new Set<string>()
  const secrets: TransferSecret[] = []
  for (const value of data.secrets) {
    if (typeof value !== 'object' || value === null || !('name' in value) || !('value' in value) ||
      typeof value.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(value.name) ||
      typeof value.value !== 'string' || value.value.length > 65536 || value.value.includes('\0') || names.has(value.name)) throw invalid()
    names.add(value.name)
    secrets.push({ name: value.name, value: value.value })
  }
  return { projectName: data.projectName, secrets }
}

export function readObject(contents: Buffer): Record<string, unknown> {
  if (contents.length > transferLimit) throw invalid()
  let data: unknown
  try { data = JSON.parse(contents.toString('utf8')) } catch { throw invalid() }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw invalid()
  return data as Record<string, unknown>
}

export function decodeBase64(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || (length !== undefined && value.length > length * 2)) throw invalid()
  const result = Buffer.from(value, 'base64')
  if (result.toString('base64') !== value || (length !== undefined && result.length !== length)) throw invalid()
  return result
}

function invalid(): Error {
  return new Error('The global.sct package is invalid or uses an unsupported format.')
}
