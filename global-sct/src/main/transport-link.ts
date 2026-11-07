import { z } from 'zod/v4'
import { linkLimit } from '../shared/transport'
import type { LinkState } from '../shared/transport'
import { readObject } from './transfer'
import { readTransfer } from './envelope'

const prefixes = { transfer: 'global-sct://import/', receipt: 'global-sct://receipt/' }
const base64url = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/).refine((value) =>
  Buffer.from(value, 'base64url').toString('base64url') === value)
const transferLink = z.strictObject({
  format: z.literal('sct-link'), version: z.literal(1), kind: z.literal('transfer'),
  payload: base64url, wrappedKey: base64url
})
const receiptLink = z.strictObject({
  format: z.literal('sct-link'), version: z.literal(1), kind: z.literal('receipt'), payload: base64url
})
const transferId = z.uuidv4()
const deviceId = z.string().regex(/^[0-9a-f]{64}$/)
const timestamp = z.number().int().nonnegative()
const receipt = z.strictObject({
  transferId, recipientDeviceId: deviceId, mode: z.literal('link'), receivedAt: timestamp,
  signature: z.string().refine((value) => Buffer.from(value, 'base64').length === 64 &&
    Buffer.from(value, 'base64').toString('base64') === value)
})
const records = z.strictObject({ links: z.array(z.strictObject({
  transferId, recipientId: deviceId, projectName: z.string().min(1).max(100),
  secretNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/)).min(1).max(1000),
  deliverBy: timestamp, createdAt: timestamp, link: z.string().max(linkLimit),
  state: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('manual') }),
    z.strictObject({ state: z.literal('expired') }),
    z.strictObject({ state: z.literal('received'), receipt })
  ])
})) })

export function encodeTransferLink(payload: Buffer, wrappedKey: Buffer): string {
  return encodeLink(transferLink.parse({ format: 'sct-link', version: 1, kind: 'transfer',
    payload: payload.toString('base64url'), wrappedKey: wrappedKey.toString('base64url') }))
}

export function decodeTransferLink(link: unknown): { payload: Buffer; wrappedKey: Buffer } {
  const data = transferLink.safeParse(decodeLink(link, 'transfer'))
  if (!data.success) throw invalidLink()
  return { payload: Buffer.from(data.data.payload, 'base64url'), wrappedKey: Buffer.from(data.data.wrappedKey, 'base64url') }
}

export function encodeReceiptLink(payload: Buffer): string {
  return encodeLink(receiptLink.parse({ format: 'sct-link', version: 1, kind: 'receipt', payload: payload.toString('base64url') }))
}

export function decodeReceiptLink(link: unknown): Buffer {
  const data = receiptLink.safeParse(decodeLink(link, 'receipt'))
  if (!data.success) throw invalidLink()
  return Buffer.from(data.data.payload, 'base64url')
}

export function readLinkRecords(value: unknown): LinkState {
  const parsed = records.safeParse(value)
  if (!parsed.success) throw new Error('The saved Link records are invalid.')
  const ids = new Set<string>()
  for (const record of parsed.data.links) {
    const transfer = readTransfer(decodeTransferLink(record.link).payload)
    if (ids.has(record.transferId) || transfer.kind !== 'transfer' || transfer.id !== record.transferId ||
      transfer.recipients.length !== 1 || transfer.recipients[0] !== record.recipientId ||
      transfer.createdAt !== record.createdAt || transfer.deliverBy !== record.deliverBy ||
      new Set(record.secretNames).size !== record.secretNames.length ||
      (record.state.state === 'received' && (record.state.receipt.transferId !== record.transferId ||
        record.state.receipt.recipientDeviceId !== record.recipientId))) {
      throw new Error('The saved Link records are invalid.')
    }
    ids.add(record.transferId)
  }
  return parsed.data.links
}

function encodeLink(data: z.infer<typeof transferLink> | z.infer<typeof receiptLink>): string {
  const link = prefixes[data.kind] + Buffer.from(JSON.stringify(data)).toString('base64url')
  requireLength(link)
  return link
}

function decodeLink(link: unknown, kind: keyof typeof prefixes): Record<string, unknown> {
  if (typeof link !== 'string') throw invalidLink()
  requireLength(link)
  // Preserve saved upstream links without claiming its OS protocol handler.
  const prefix = [prefixes[kind], prefixes[kind].replace('global-sct:', 'sct:')].find((value) => link.startsWith(value))
  if (!prefix) throw invalidLink()
  const encoded = base64url.safeParse(link.slice(prefix.length))
  if (!encoded.success) throw invalidLink()
  try { return readObject(Buffer.from(encoded.data, 'base64url')) } catch { throw invalidLink() }
}

function requireLength(link: string): void {
  if (link.length > linkLimit) throw new Error('The link exceeds 16,384 characters. Use Relay or select fewer secrets.')
}

function invalidLink(): Error {
  return new Error('The link is invalid. Paste a complete global-sct://import/ or global-sct://receipt/ link of the correct kind.')
}
