import { createCipheriv, createDecipheriv, createHash, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, sign, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { decodeBase64, describeDevice, exportPublic, publicKey, readObject, requirePayload, transferLimit } from './transfer'
import type { DeviceCard, DeviceIdentity } from './transfer'
import type { RelayExpiryContents, RelayExpiryNotice, RelayGrant, RelayMessageContents, RelayMessageKind, RelayReceipt,
  RelayReceiptContents, RelayResultContents, RelayTaskContents, RelayTransfer, RelayTransferContents, RelayWrappedKey } from '../shared/envelope'
import type { DeliveryMode, TransferReceipt } from '../shared/transport'

// The relay rejects a delivery deadline that is later than this limit.
export const deliveryLimit = 7 * 24 * 60 * 60 * 1000
const recipientLimit = 100
// A sender clock can be slightly ahead of the recipient clock.
export const clockSkew = 60_000

// This device: its relay identity and its device keys.
export interface RelaySelf {
  identity: string
  keys: DeviceIdentity
}

// A paired device: its relay identity and the public keys that both users verified with the pairing code.
export interface RelayPeerKeys {
  identity: string
  card: DeviceCard
}

export interface SealedTransfer {
  id: string
  payload: Buffer
  wrappedKeys: { recipient: string; wrappedKey: Buffer }[]
}

export interface OpenedMessage<K extends RelayMessageKind> {
  transfer: RelayTransfer
  digest: string
  contents: RelayMessageContents[K]
}

export type OpenedTransfer = OpenedMessage<'transfer'>

const contentReaders: { [K in RelayMessageKind]: (data: Record<string, unknown>, createdAt: number) => RelayMessageContents[K] } = {
  transfer: requireContents,
  task: requireTaskContents,
  result: requireResultContents
}

export function sealTransfer(self: RelaySelf, recipients: RelayPeerKeys[], contents: RelayTransferContents,
  deliverBy: number, now = Date.now()): SealedTransfer {
  return sealMessage(self, recipients, 'transfer', contents, deliverBy, now)
}

// The payload is encrypted one time. Each recipient gets the message key, encrypted with a key that only that recipient can derive.
// Retries of a queued request reuse its ID, so the caller can supply the ID.
export function sealMessage<K extends RelayMessageKind>(self: RelaySelf, recipients: RelayPeerKeys[], kind: K,
  contents: RelayMessageContents[K], deliverBy: number, now = Date.now(), id: string = randomUUID()): SealedTransfer {
  requireRecipients(self, recipients)
  contentReaders[kind]({ ...contents }, now)
  if (!isMessageId(id)) throw invalid()
  if (!Number.isSafeInteger(deliverBy) || deliverBy <= now || deliverBy - now > deliveryLimit) {
    throw new Error('Set a delivery deadline within the next 7 days.')
  }
  const ephemeral = generateKeyPairSync('x25519')
  const header = {
    format: 'sct-relay' as const, version: 1 as const, kind, id,
    sender: self.identity, senderDevice: describeDevice(self.keys.card).id,
    recipients: recipients.map((recipient) => recipient.identity).sort(), createdAt: now, deliverBy,
    ephemeralKey: exportPublic(ephemeral.publicKey), iv: randomBytes(12).toString('base64')
  }
  const messageKey = randomBytes(32)
  const plaintext = Buffer.from(JSON.stringify(contents))
  try {
    const unsigned = { ...header, ...encrypt(messageKey, Buffer.from(header.iv, 'base64'), plaintext, transferHeader(header)) }
    const payload = Buffer.from(JSON.stringify({ ...unsigned, signature: sign(null, transferBody(unsigned), self.keys.signingKey).toString('base64') }))
    if (payload.length > transferLimit) throw new Error('Select fewer secrets. A transfer cannot exceed 8 MiB.')
    return {
      id: header.id,
      payload,
      wrappedKeys: recipients.map((recipient) => ({ recipient: recipient.identity, wrappedKey: wrapKey(ephemeral.privateKey, recipient, header, messageKey) }))
    }
  } finally {
    messageKey.fill(0)
    plaintext.fill(0)
  }
}

// Reads the routing fields without decryption, so that the caller can find the verified sender and check for a duplicate ID.
export function readTransfer(payload: Buffer): RelayTransfer {
  const data = readObject(payload)
  if (data.format !== 'sct-relay' || data.version !== 1 || !isMessageKind(data.kind) || !isMessageId(data.id) ||
    !isHex(data.sender) || !isHex(data.senderDevice) || !Array.isArray(data.recipients) ||
    data.recipients.length === 0 || data.recipients.length > recipientLimit || !data.recipients.every(isHex) ||
    new Set(data.recipients).size !== data.recipients.length ||
    !Number.isSafeInteger(data.createdAt) || !Number.isSafeInteger(data.deliverBy) ||
    (data.deliverBy as number) <= (data.createdAt as number) || (data.deliverBy as number) - (data.createdAt as number) > deliveryLimit) {
    throw invalid()
  }
  publicKey(data.ephemeralKey, 'x25519')
  decodeBase64(data.iv, 12)
  decodeBase64(data.tag, 16)
  decodeBase64(data.signature, 64)
  decodeBase64(data.ciphertext)
  return {
    format: data.format, version: data.version, kind: data.kind, id: data.id, sender: data.sender, senderDevice: data.senderDevice,
    recipients: data.recipients as string[], createdAt: data.createdAt as number, deliverBy: data.deliverBy as number,
    ephemeralKey: data.ephemeralKey as string, iv: data.iv as string, tag: data.tag as string,
    ciphertext: data.ciphertext as string, signature: data.signature as string
  }
}

// The same ID with the same contents returns the saved receipt, so the secrets are not imported again.
// The same ID with other contents fails.
export function findReceipt<T extends { id: string; digest: string }>(receipts: T[], transfer: RelayTransfer): T | undefined {
  const saved = receipts.find((receipt) => receipt.id === transfer.id)
  if (saved && saved.digest !== transferDigest(transfer)) throw new Error('A different transfer already uses this message ID. No secrets were imported.')
  return saved
}

export function openTransfer(self: RelaySelf, sender: RelayPeerKeys, payload: Buffer, wrappedKey: Buffer, now = Date.now()): OpenedTransfer {
  const opened = openMessage(self, sender, 'transfer', payload, wrappedKey, now)
  if (opened.contents.grant.accessExpiresAt !== null && opened.contents.grant.accessExpiresAt <= now) {
    throw new Error('Access to these secrets expired. No secrets were imported.')
  }
  return opened
}

// A message of another kind fails, so a task cannot open as a transfer and a result cannot open as a task.
export function openMessage<K extends RelayMessageKind>(self: RelaySelf, sender: RelayPeerKeys, kind: K, payload: Buffer,
  wrappedKey: Buffer, now = Date.now()): OpenedMessage<K> {
  const transfer = readTransfer(payload)
  if (transfer.kind !== kind) throw invalid()
  const noun = { transfer: 'transfer', task: 'task', result: 'result' }[kind]
  const outcome = kind === 'transfer' ? ' No secrets were imported.' : ''
  requireTransferRoute(transfer, self, sender, noun, outcome)
  if (!verify(null, transferBody(transfer), publicKey(sender.card.signingKey, 'ed25519'), Buffer.from(transfer.signature, 'base64'))) {
    throw new Error(`The ${noun} signature is invalid.${outcome}`)
  }
  if (transfer.deliverBy <= now || transfer.createdAt > now + clockSkew) throw new Error(`This ${noun} expired or its creation time is invalid.${outcome}`)
  let contents: RelayMessageContents[K]
  const messageKey = unwrapKey(self, transfer, wrappedKey)
  try {
    const plaintext = decrypt(messageKey, transfer, transferHeader(transfer))
    try {
      contents = contentReaders[kind](readObject(plaintext), transfer.createdAt)
    } finally {
      plaintext.fill(0)
    }
  } catch {
    throw new Error(`Cannot decrypt this ${noun}.${outcome}`)
  } finally {
    messageKey.fill(0)
  }
  return { transfer, digest: transferDigest(transfer), contents }
}

// The recipient confirms receipt to the original sender. Only that sender can read the receipt.
export function sealReceipt(self: RelaySelf, sender: RelayPeerKeys, transfer: RelayTransfer, contents: RelayReceiptContents, now = Date.now()): Buffer {
  requireReceiptContents({ ...contents })
  const ephemeral = generateKeyPairSync('x25519')
  const header = {
    format: 'sct-relay' as const, version: 1 as const, kind: 'receipt' as const, correlationId: transfer.id,
    sender: self.identity, senderDevice: describeDevice(self.keys.card).id, recipient: sender.identity, createdAt: now,
    ephemeralKey: exportPublic(ephemeral.publicKey), iv: randomBytes(12).toString('base64')
  }
  const key = deriveKey(ephemeral.privateKey, publicKey(sender.card.encryptionKey, 'x25519'), header.correlationId,
    `sct-relay-receipt-v1/${header.sender}/${header.recipient}`)
  try {
    const unsigned = { ...header, ...encrypt(key, Buffer.from(header.iv, 'base64'), Buffer.from(JSON.stringify(contents)), receiptHeader(header)) }
    return Buffer.from(JSON.stringify({ ...unsigned, signature: sign(null, receiptBody(unsigned), self.keys.signingKey).toString('base64') }))
  } finally {
    key.fill(0)
  }
}

export function openReceipt(self: RelaySelf, recipient: RelayPeerKeys, transferId: string, bytes: Buffer, now = Date.now()): RelayReceiptContents {
  const receipt = readReceipt(bytes)
  if (receipt.correlationId !== transferId || receipt.sender !== recipient.identity || receipt.recipient !== self.identity ||
    receipt.senderDevice !== describeDevice(recipient.card).id) {
    throw new Error('This receipt belongs to a different transfer or device.')
  }
  if (!verify(null, receiptBody(receipt), publicKey(recipient.card.signingKey, 'ed25519'), Buffer.from(receipt.signature, 'base64'))) {
    throw new Error('The receipt signature is invalid.')
  }
  if (receipt.createdAt > now + clockSkew) throw new Error('The receipt creation time is invalid.')
  const key = deriveKey(self.keys.encryptionKey, publicKey(receipt.ephemeralKey, 'x25519'), receipt.correlationId,
    `sct-relay-receipt-v1/${receipt.sender}/${receipt.recipient}`)
  try {
    return requireReceiptContents(readObject(decrypt(key, receipt, receiptHeader(receipt))))
  } catch {
    throw new Error('Cannot decrypt this receipt.')
  } finally {
    key.fill(0)
  }
}

// The wire receipt has no mode field. The caller supplies the mode of the transport that returned the receipt.
export function verifyTransferReceipt(self: RelaySelf, recipient: RelayPeerKeys, transferId: string, bytes: Buffer,
  mode: DeliveryMode, now = Date.now()): TransferReceipt {
  const contents = openReceipt(self, recipient, transferId, bytes, now)
  const receipt = readReceipt(bytes)
  return { transferId: receipt.correlationId, recipientDeviceId: receipt.senderDevice, mode, receivedAt: contents.receivedAt,
    signature: receipt.signature }
}

// The recipient reports local grant cleanup to the original sender. Only that sender can read the notice.
export function sealExpiryNotice(self: RelaySelf, sender: RelayPeerKeys, transferId: string,
  contents: RelayExpiryContents, now = Date.now()): Buffer {
  requireExpiryContents({ ...contents })
  if (!isMessageId(transferId)) throw invalid()
  const ephemeral = generateKeyPairSync('x25519')
  const header = {
    format: 'sct-relay' as const, version: 1 as const, kind: 'expiry' as const, correlationId: transferId,
    sender: self.identity, senderDevice: describeDevice(self.keys.card).id, recipient: sender.identity, createdAt: now,
    ephemeralKey: exportPublic(ephemeral.publicKey), iv: randomBytes(12).toString('base64')
  }
  const key = deriveKey(ephemeral.privateKey, publicKey(sender.card.encryptionKey, 'x25519'), header.correlationId,
    `sct-relay-expiry-v1/${header.sender}/${header.recipient}`)
  try {
    const unsigned = { ...header, ...encrypt(key, Buffer.from(header.iv, 'base64'), Buffer.from(JSON.stringify(contents)), expiryHeader(header)) }
    return Buffer.from(JSON.stringify({ ...unsigned, signature: sign(null, expiryBody(unsigned), self.keys.signingKey).toString('base64') }))
  } finally {
    key.fill(0)
  }
}

export function openExpiryNotice(self: RelaySelf, recipient: RelayPeerKeys, transferId: string,
  bytes: Buffer, now = Date.now()): RelayExpiryContents {
  const notice = readExpiryNotice(bytes)
  if (notice.correlationId !== transferId || notice.sender !== recipient.identity || notice.recipient !== self.identity ||
    notice.senderDevice !== describeDevice(recipient.card).id) {
    throw new Error('This expiry notice belongs to a different transfer or device.')
  }
  if (!verify(null, expiryBody(notice), publicKey(recipient.card.signingKey, 'ed25519'), Buffer.from(notice.signature, 'base64'))) {
    throw new Error('The expiry notice signature is invalid.')
  }
  if (notice.createdAt > now + clockSkew) throw new Error('The expiry notice creation time is invalid.')
  const key = deriveKey(self.keys.encryptionKey, publicKey(notice.ephemeralKey, 'x25519'), notice.correlationId,
    `sct-relay-expiry-v1/${notice.sender}/${notice.recipient}`)
  try {
    return requireExpiryContents(readObject(decrypt(key, notice, expiryHeader(notice))))
  } catch {
    throw new Error('Cannot decrypt this expiry notice.')
  } finally {
    key.fill(0)
  }
}

function requireRecipients(self: RelaySelf, recipients: RelayPeerKeys[]): void {
  if (recipients.length === 0 || recipients.length > recipientLimit) throw new Error(`Select 1 to ${recipientLimit} verified recipients.`)
  const identities = new Set(recipients.map((recipient) => recipient.identity))
  if (identities.size !== recipients.length || identities.has(self.identity) || ![...identities].every(isHex)) {
    throw new Error('Select each verified recipient one time. This device cannot be a recipient.')
  }
}

function requireTransferRoute(transfer: RelayTransfer, self: RelaySelf, sender: RelayPeerKeys, noun: string, outcome: string): void {
  if (!transfer.recipients.includes(self.identity)) throw new Error(`This ${noun} belongs to a different device.${outcome}`)
  if (transfer.sender !== sender.identity || transfer.senderDevice !== describeDevice(sender.card).id) {
    throw new Error(`The sender of this ${noun} is not a verified device.${outcome}`)
  }
}

// Secret names and values follow the AirDrop rules. The grant adds the access deadline and the sharing restriction.
function requireContents(data: Record<string, unknown>, createdAt: number): RelayTransferContents {
  const { projectName, secrets } = requirePayload(data)
  return { projectName, secrets, grant: requireGrant(data.grant, createdAt) }
}

function requireGrant(value: unknown, createdAt: number): RelayGrant {
  if (typeof value !== 'object' || value === null || !('accessExpiresAt' in value) || !('injectionOnly' in value) ||
    typeof value.injectionOnly !== 'boolean' ||
    (value.accessExpiresAt !== null && (!Number.isSafeInteger(value.accessExpiresAt) || (value.accessExpiresAt as number) <= createdAt))) {
    throw new Error('Set an access deadline after the transfer time, or no access deadline.')
  }
  return { accessExpiresAt: value.accessExpiresAt as number | null, injectionOnly: value.injectionOnly }
}

// Unknown fields fail, so a task cannot carry a command, an approval, or another operation.
function requireTaskContents(data: Record<string, unknown>, createdAt: number): RelayTaskContents {
  if (!hasExactKeys(data, ['operation', 'grantId', 'approveBy']) || data.operation !== 'run_demo' || !isMessageId(data.grantId) ||
    !Number.isSafeInteger(data.approveBy) || (data.approveBy as number) <= createdAt || (data.approveBy as number) - createdAt > deliveryLimit) {
    throw invalid()
  }
  return { operation: data.operation, grantId: data.grantId, approveBy: data.approveBy as number }
}

// Only a completed run has an exit code and a presence flag. Other outcomes started no process, or cannot report one.
function requireResultContents(data: Record<string, unknown>): RelayResultContents {
  if (!hasExactKeys(data, ['taskId', 'status', 'exitCode', 'secretPresent', 'finishedAt']) || !isMessageId(data.taskId) ||
    !Number.isSafeInteger(data.finishedAt) || !['completed', 'refused', 'expired', 'failed', 'uncertain'].includes(data.status as string)) {
    throw invalid()
  }
  const completed = data.status === 'completed'
  if (completed ? !Number.isSafeInteger(data.exitCode) || (data.exitCode as number) < 0 || (data.exitCode as number) > 255 ||
    typeof data.secretPresent !== 'boolean' : data.exitCode !== null || data.secretPresent !== null) throw invalid()
  return { taskId: data.taskId, status: data.status as RelayResultContents['status'], exitCode: data.exitCode as number | null,
    secretPresent: data.secretPresent as boolean | null, finishedAt: data.finishedAt as number }
}

function hasExactKeys(data: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(data).length === keys.length && keys.every((key) => Object.hasOwn(data, key))
}

export function readReceipt(bytes: Buffer): RelayReceipt {
  const data = readObject(bytes)
  if (data.format !== 'sct-relay' || data.version !== 1 || data.kind !== 'receipt' || !isMessageId(data.correlationId) ||
    !isHex(data.sender) || !isHex(data.senderDevice) || !isHex(data.recipient) || !Number.isSafeInteger(data.createdAt)) {
    throw invalid()
  }
  publicKey(data.ephemeralKey, 'x25519')
  decodeBase64(data.iv, 12)
  decodeBase64(data.tag, 16)
  decodeBase64(data.signature, 64)
  decodeBase64(data.ciphertext)
  return {
    format: data.format, version: data.version, kind: data.kind, correlationId: data.correlationId, sender: data.sender,
    senderDevice: data.senderDevice, recipient: data.recipient, createdAt: data.createdAt as number,
    ephemeralKey: data.ephemeralKey as string, iv: data.iv as string, tag: data.tag as string,
    ciphertext: data.ciphertext as string, signature: data.signature as string
  }
}

function readExpiryNotice(bytes: Buffer): RelayExpiryNotice {
  const data = readObject(bytes)
  if (data.format !== 'sct-relay' || data.version !== 1 || data.kind !== 'expiry' || !isMessageId(data.correlationId) ||
    !isHex(data.sender) || !isHex(data.senderDevice) || !isHex(data.recipient) || !Number.isSafeInteger(data.createdAt)) {
    throw invalid()
  }
  publicKey(data.ephemeralKey, 'x25519')
  decodeBase64(data.iv, 12)
  decodeBase64(data.tag, 16)
  decodeBase64(data.signature, 64)
  decodeBase64(data.ciphertext)
  return {
    format: data.format, version: data.version, kind: data.kind, correlationId: data.correlationId, sender: data.sender,
    senderDevice: data.senderDevice, recipient: data.recipient, createdAt: data.createdAt as number,
    ephemeralKey: data.ephemeralKey as string, iv: data.iv as string, tag: data.tag as string,
    ciphertext: data.ciphertext as string, signature: data.signature as string
  }
}

function requireReceiptContents(data: Record<string, unknown>): RelayReceiptContents {
  if (data.status !== 'received' || !Number.isSafeInteger(data.receivedAt) || !Number.isSafeInteger(data.secretCount) ||
    (data.secretCount as number) < 0 || (data.secretCount as number) > 1000) throw invalid()
  return { status: data.status, receivedAt: data.receivedAt as number, secretCount: data.secretCount as number }
}

function requireExpiryContents(data: Record<string, unknown>): RelayExpiryContents {
  if (data.status !== 'expired' || !Number.isSafeInteger(data.expiredAt) || !Number.isSafeInteger(data.secretCount) ||
    (data.secretCount as number) < 1 || (data.secretCount as number) > 1000) throw invalid()
  return { status: data.status, expiredAt: data.expiredAt as number, secretCount: data.secretCount as number }
}

function wrapKey(ephemeral: KeyObject, recipient: RelayPeerKeys, header: TransferHeader, messageKey: Buffer): Buffer {
  const key = deriveKey(ephemeral, publicKey(recipient.card.encryptionKey, 'x25519'), header.id, `sct-relay-wrap-v1/${header.sender}/${recipient.identity}`)
  try {
    const iv = randomBytes(12)
    const { tag, ciphertext } = encrypt(key, iv, messageKey, transferHeader(header))
    return Buffer.from(JSON.stringify({ iv: iv.toString('base64'), tag, key: ciphertext } satisfies RelayWrappedKey))
  } finally {
    key.fill(0)
  }
}

function unwrapKey(self: RelaySelf, transfer: RelayTransfer, bytes: Buffer): Buffer {
  const data = readObject(bytes)
  decodeBase64(data.iv, 12)
  decodeBase64(data.tag, 16)
  decodeBase64(data.key, 32)
  const key = deriveKey(self.keys.encryptionKey, publicKey(transfer.ephemeralKey, 'x25519'), transfer.id, `sct-relay-wrap-v1/${transfer.sender}/${self.identity}`)
  try {
    return decrypt(key, { iv: data.iv as string, tag: data.tag as string, ciphertext: data.key as string }, transferHeader(transfer))
  } catch {
    throw new Error('Cannot decrypt this transfer. No secrets were imported.')
  } finally {
    key.fill(0)
  }
}

function deriveKey(privateKey: KeyObject, remote: KeyObject, salt: string, info: string): Buffer {
  const shared = diffieHellman({ privateKey, publicKey: remote })
  try {
    return Buffer.from(hkdfSync('sha256', shared, Buffer.from(salt), Buffer.from(info), 32))
  } finally {
    shared.fill(0)
  }
}

function encrypt(key: Buffer, iv: Buffer, plaintext: Buffer, data: Buffer): { tag: string; ciphertext: string } {
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(data)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
}

function decrypt(key: Buffer, { iv, tag, ciphertext }: { iv: string; tag: string; ciphertext: string }, data: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64')).setAAD(data).setAuthTag(Buffer.from(tag, 'base64'))
  const plaintext = decipher.update(Buffer.from(ciphertext, 'base64'))
  try {
    return Buffer.concat([plaintext, decipher.final()])
  } finally {
    // GCM can produce plaintext before final() checks the authentication tag.
    plaintext.fill(0)
  }
}

type TransferHeader = Omit<RelayTransfer, 'tag' | 'ciphertext' | 'signature'>
type ReceiptHeader = Omit<RelayReceipt, 'tag' | 'ciphertext' | 'signature'>
type ExpiryHeader = Omit<RelayExpiryNotice, 'tag' | 'ciphertext' | 'signature'>

// The ciphertext authenticates every routing field, and the signature covers the routing fields and the ciphertext.
function transferHeader(header: TransferHeader): Buffer {
  return Buffer.from(JSON.stringify([header.format, header.version, header.kind, header.id, header.sender, header.senderDevice,
    header.recipients, header.createdAt, header.deliverBy, header.ephemeralKey, header.iv]))
}

function transferBody(transfer: Omit<RelayTransfer, 'signature'>): Buffer {
  return Buffer.concat([transferHeader(transfer), Buffer.from(transfer.tag, 'base64'), Buffer.from(transfer.ciphertext, 'base64')])
}

function transferDigest(transfer: RelayTransfer): string {
  return createHash('sha256').update(transferBody(transfer)).update(Buffer.from(transfer.signature, 'base64')).digest('hex')
}

function receiptHeader(header: ReceiptHeader): Buffer {
  return Buffer.from(JSON.stringify([header.format, header.version, header.kind, header.correlationId, header.sender, header.senderDevice,
    header.recipient, header.createdAt, header.ephemeralKey, header.iv]))
}

function receiptBody(receipt: Omit<RelayReceipt, 'signature'>): Buffer {
  return Buffer.concat([receiptHeader(receipt), Buffer.from(receipt.tag, 'base64'), Buffer.from(receipt.ciphertext, 'base64')])
}

function expiryHeader(header: ExpiryHeader): Buffer {
  return Buffer.from(JSON.stringify([header.format, header.version, header.kind, header.correlationId, header.sender, header.senderDevice,
    header.recipient, header.createdAt, header.ephemeralKey, header.iv]))
}

function expiryBody(notice: Omit<RelayExpiryNotice, 'signature'>): Buffer {
  return Buffer.concat([expiryHeader(notice), Buffer.from(notice.tag, 'base64'), Buffer.from(notice.ciphertext, 'base64')])
}

function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

function isMessageKind(value: unknown): value is RelayMessageKind {
  return value === 'transfer' || value === 'task' || value === 'result'
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function invalid(): Error {
  return new Error('The relay message is invalid or uses an unsupported format.')
}
