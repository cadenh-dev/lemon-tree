import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'
import { readReceipt, readTransfer } from './envelope'
import { encodeFrame, FrameReader, readTransferBody, transferBody } from './direct-frame'
import { decodeReceiptLink, encodeReceiptLink } from './transport-link'
import { WebRtcWindow } from './webrtc-window'
import type { WebRtcConfig } from './webrtc-config'
import type { DirectImportResult, DirectIncomingItem, DirectSentItem } from '../shared/direct'
import type { WebRtcState } from '../shared/webrtc'
import type { WebRtcLinkPreview } from '../shared/connect'
import type { TransferReceipt } from '../shared/transport'
import type { Sharing } from './sharing'

const receiptLimit = 16_384
const receiptTimeout = 10 * 60 * 1000
const connectionTimeout = 30 * 1000

interface IncomingRecord extends DirectIncomingItem {
  payload: Buffer
  wrappedKey: Buffer
}

interface PendingReceiptRecord {
  receipt: Buffer
  senderName: string
  projectName: string
  receivedAt: number
}

const pendingReceiptSchema = z.union([
  z.string(),
  z.object({
    receipt: z.string(), senderName: z.string().min(1).max(100),
    projectName: z.string().min(1).max(100), receivedAt: z.number().int().nonnegative()
  })
])

const sentSchema = z.array(z.object({
  transferId: z.uuidv4(), recipientId: z.string().regex(/^[0-9a-f]{64}$/), projectName: z.string().min(1).max(100),
  secretNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/)).min(1).max(1000),
  createdAt: z.number().int().nonnegative(), deliverBy: z.number().int().nonnegative(),
  state: z.enum(['pending', 'received', 'manual', 'expired', 'failed']),
  receivedAt: z.number().int().nonnegative().nullable(), error: z.string().nullable()
}))
const incomingSchema = z.array(z.object({
  transferId: z.uuidv4(), senderId: z.string().regex(/^[0-9a-f]{64}$/), senderName: z.string().min(1).max(100),
  projectName: z.string().min(1).max(100), secretNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/)).min(1).max(1000),
  deliverBy: z.number().int().nonnegative(), accessExpiresAt: z.number().int().nonnegative().nullable(),
  injectionOnly: z.boolean(), error: z.string().nullable(), payload: z.string(), wrappedKey: z.string()
}))

export class WebRtcTransport {
  private window: WebRtcWindow | undefined
  private reader = new FrameReader()
  private peerId: string | null = null
  private sessionId: string | null = null
  private offerDigest: string | null = null
  private offerLink: string | null = null
  private answerLink: string | null = null
  private route: 'direct' | 'turn' | null = null
  private connectTimer: NodeJS.Timeout | undefined
  private chain: Promise<void> = Promise.resolve()
  private sending = false
  private ready = false
  private started = false
  private error: string | null = null
  private pendingOffer: ((sdp: string) => void) | null = null
  private pendingAnswer: ((sdp: string) => void) | null = null
  private readonly sent = new Map<string, DirectSentItem>()
  private readonly incoming = new Map<string, IncomingRecord>()
  private readonly pendingReceipts = new Map<string, PendingReceiptRecord>()
  private readonly receiptTimers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly sharing: Sharing, private readonly config: WebRtcConfig, private readonly root: string,
    private readonly changed: () => void) {}

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.load()
    this.changed()
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.closeWindow()
    this.changed()
  }

  close(): void {
    this.closeWindow()
    this.error = null
    this.changed()
  }

  state(): Promise<WebRtcState> {
    return this.sharing.directPeers().then((peers) => ({
      connection: this.error ? 'error' : !this.window ? 'off' : this.ready ? 'ready' : 'connecting',
      peers: peers.map((peer) => ({ ...peer, available: this.ready && this.peerId === peer.id })),
      peerId: this.peerId, offerLink: this.offerLink, answerLink: this.answerLink, route: this.route,
      incoming: [...this.incoming.values()].map((record) => ({
        transferId: record.transferId, senderId: record.senderId, senderName: record.senderName,
        projectName: record.projectName, secretNames: record.secretNames, deliverBy: record.deliverBy,
        accessExpiresAt: record.accessExpiresAt, injectionOnly: record.injectionOnly, error: record.error
      })),
      sent: [...this.sent.values()].sort((left, right) => right.createdAt - left.createdAt),
      receipts: [...this.pendingReceipts].map(([transferId, value]) => ({
        transferId, senderName: value.senderName, projectName: value.projectName, receiptLink: encodeReceiptLink(value.receipt)
      })),
      error: this.error
    }))
  }

  async previewLink(link: unknown): Promise<WebRtcLinkPreview> {
    const opened = await this.sharing.connectOpen(link)
    const peer = await this.sharing.directPeer(opened.senderId)
    return { kind: opened.contents.kind, sender: peer?.name ?? 'Verified device', expiresAt: opened.expiresAt }
  }

  async createOffer(peerId: unknown): Promise<string> {
    if (typeof peerId !== 'string' || !/^[0-9a-f]{64}$/.test(peerId)) throw new Error('Select a verified WebRTC peer.')
    if (this.window) throw new Error('Close the current WebRTC connection first.')
    const peer = await this.sharing.directPeer(peerId)
    if (!peer) throw new Error('The WebRTC peer is not verified.')
    this.peerId = peerId
    this.window = new WebRtcWindow((event) => this.event(event))
    this.reader = new FrameReader()
    this.error = null
    try {
      const config = await this.config.session()
      const sdp = requireSdp(await this.request('offer', () => this.window?.command({ type: 'offer', config })))
      const sealed = await this.sharing.connectSeal(peerId, { kind: 'offer', sdp })
      this.sessionId = sealed.sessionId
      this.offerDigest = sealed.digest
      this.offerLink = sealed.link
      this.changed()
      return sealed.link
    } catch (error) {
      this.failWindow(error)
      throw error
    }
  }

  async acceptOffer(link: unknown): Promise<string> {
    if (this.window) throw new Error('Close the current WebRTC connection first.')
    const opened = await this.sharing.connectOpen(link)
    if (opened.contents.kind !== 'offer') throw new Error('This link is not a WebRTC offer.')
    this.peerId = opened.senderId
    this.sessionId = opened.sessionId
    this.offerDigest = opened.digest
    this.window = new WebRtcWindow((event) => this.event(event))
    this.reader = new FrameReader()
    this.error = null
    try {
      const config = await this.config.session()
      const sdp = requireSdp(await this.request('answer', () => this.window?.command({
        type: 'accept-offer', sdp: requireSdp(opened.contents.sdp), config
      })))
      const sealed = await this.sharing.connectSeal(opened.senderId, { kind: 'answer', sdp, offerDigest: opened.digest },
        { sessionId: opened.sessionId, createdAt: opened.createdAt, expiresAt: opened.expiresAt })
      this.answerLink = sealed.link
      this.startConnectionTimer()
      this.changed()
      return sealed.link
    } catch (error) {
      this.failWindow(error)
      throw error
    }
  }

  async acceptAnswer(link: unknown): Promise<void> {
    if (!this.window || !this.sessionId || !this.offerDigest) throw new Error('Create a WebRTC offer first.')
    const opened = await this.sharing.connectOpen(link)
    if (opened.contents.kind !== 'answer' || opened.sessionId !== this.sessionId ||
      opened.contents.offerDigest !== this.offerDigest) {
      throw new Error('The WebRTC answer does not match this offer.')
    }
    await this.window.command({ type: 'accept-answer', sdp: requireSdp(opened.contents.sdp) })
    this.startConnectionTimer()
    this.changed()
  }

  async send(input: unknown): Promise<void> {
    const request = requireSend(input)
    if (!this.ready || !this.window || this.peerId !== request.recipientId) {
      throw new Error('The WebRTC connection is not ready.')
    }
    if (this.sending) throw new Error('A WebRTC transfer is already active. Wait for it to finish.')
    this.sending = true
    try {
      const sealed = await this.sharing.prepareEnvelope({ ...request, deliverBy: Date.now() + 24 * 60 * 60 * 1000 })
      const wrapped = sealed.wrappedKeys[0]
      if (!wrapped || sealed.wrappedKeys.length !== 1) throw new Error('Select one verified recipient.')
      await this.window.command({ type: 'send', data: encodeFrame(3, transferBody(sealed.payload, wrapped.wrappedKey)).toString('base64') })
      const transfer = readTransfer(sealed.payload)
      const record: DirectSentItem = {
        transferId: sealed.id, recipientId: request.recipientId, projectName: sealed.projectName, secretNames: sealed.secretNames,
        createdAt: transfer.createdAt, deliverBy: transfer.deliverBy, state: 'pending', receivedAt: null, error: null
      }
      this.sent.set(record.transferId, record)
      this.receiptTimers.set(record.transferId, setTimeout(() => {
        const saved = this.sent.get(record.transferId)
        if (saved?.state === 'pending') {
          saved.state = 'manual'
          void this.persistSent()
          this.changed()
        }
      }, receiptTimeout))
      await this.persistSent()
      this.changed()
    } finally {
      this.sending = false
    }
  }

  async import(input: unknown): Promise<DirectImportResult> {
    const request = requireImport(input)
    const record = this.incoming.get(request.transferId)
    if (!record) throw new Error('The received WebRTC transfer is unavailable.')
    const accepted = await this.sharing.acceptEnvelope(record.payload, record.wrappedKey, request.projectId, async () => undefined)
    const receiptLink = encodeReceiptLink(accepted.receipt)
    const receiptSent = this.ready && this.window !== undefined
    if (receiptSent) await this.window?.command({ type: 'send', data: encodeFrame(4, accepted.receipt).toString('base64') })
    else {
      this.pendingReceipts.set(record.transferId, {
        receipt: accepted.receipt, senderName: record.senderName,
        projectName: record.projectName, receivedAt: accepted.receivedAt
      })
      await this.persistReceipts()
    }
    this.incoming.delete(record.transferId)
    await this.persistIncoming()
    this.changed()
    return { secrets: accepted.secrets, receiptLink, receiptSent }
  }

  async verifyReceipt(input: unknown): Promise<TransferReceipt> {
    const request = requireReceipt(input)
    const sent = this.sent.get(request.transferId)
    if (!sent) throw new Error('The sent WebRTC transfer is unavailable.')
    const receipt = decodeReceiptLink(request.link)
    const verified = await this.sharing.verifyEnvelopeReceipt(sent.recipientId, request.transferId, receipt, 'direct')
    sent.state = 'received'
    sent.receivedAt = verified.receivedAt
    sent.error = null
    const timer = this.receiptTimers.get(request.transferId)
    if (timer) clearTimeout(timer)
    this.receiptTimers.delete(request.transferId)
    await this.persistSent()
    this.changed()
    return verified
  }

  private event(event: { type: string; sdp?: string; data?: string; error?: string; route?: 'direct' | 'turn' }): void {
    if (event.type === 'offer' && this.pendingOffer && event.sdp) {
      const resolve = this.pendingOffer
      this.pendingOffer = null
      resolve(event.sdp)
      return
    }
    if (event.type === 'answer' && this.pendingAnswer && event.sdp) {
      const resolve = this.pendingAnswer
      this.pendingAnswer = null
      resolve(event.sdp)
      return
    }
    if (event.type === 'ready') {
      this.ready = true
      this.clearConnectionTimer()
      void this.flushReceipts().catch((error: unknown) => {
        this.error = error instanceof Error ? error.message : 'The WebRTC receipt could not be saved.'
        this.changed()
      })
      return
    }
    if (event.type === 'message' && event.data) {
      const data = event.data
      this.chain = this.chain.then(async () => {
        let frames = Promise.resolve()
        for (const frame of this.reader.push(Buffer.from(data, 'base64'))) {
          frames = frames.then(() => this.frame(frame.kind, frame.body))
        }
        await frames
      }).catch((error: unknown) => {
        this.error = error instanceof Error ? error.message : 'The WebRTC message failed.'
        this.changed()
      })
      return
    }
    if (event.type === 'connected') {
      this.clearConnectionTimer()
      return
    }
    if (event.type === 'route' && event.route) {
      this.route = event.route
      this.changed()
      return
    }
    if (event.type === 'error') {
      this.error = event.error ?? 'The WebRTC connection failed.'
      this.clearConnectionTimer()
      this.route = null
      this.changed()
      return
    }
    if (event.type === 'close') {
      this.ready = false
      this.route = null
      this.clearConnectionTimer()
      this.changed()
    }
  }

  private async frame(kind: number, body: Buffer): Promise<void> {
    if (kind === 3) {
      if (!this.peerId) throw new Error('The WebRTC peer is unknown.')
      const parsed = readTransferBody(body)
      const preview = await this.sharing.previewEnvelope(parsed.payload, parsed.wrappedKey)
      const sender = await this.sharing.directPeer(this.peerId)
      this.incoming.set(preview.messageId, {
        transferId: preview.messageId, senderId: this.peerId, senderName: sender?.name ?? 'Verified device',
        projectName: preview.projectName, secretNames: preview.secretNames, deliverBy: preview.deliverBy,
        accessExpiresAt: preview.accessExpiresAt, injectionOnly: preview.injectionOnly, error: null,
        payload: parsed.payload, wrappedKey: parsed.wrappedKey
      })
      await this.persistIncoming()
      this.changed()
      return
    }
    if (kind === 4) {
      if (!this.peerId) throw new Error('The WebRTC peer is unknown.')
      if (body.length > receiptLimit) throw new Error('The WebRTC receipt is too large.')
      const route = readReceipt(body)
      const sent = this.sent.get(route.correlationId)
      if (!sent || sent.recipientId !== this.peerId) throw new Error('The WebRTC receipt belongs to another transfer.')
      const verified = await this.sharing.verifyEnvelopeReceipt(this.peerId, route.correlationId, body, 'direct')
      sent.state = 'received'
      sent.receivedAt = verified.receivedAt
      sent.error = null
      const timer = this.receiptTimers.get(route.correlationId)
      if (timer) clearTimeout(timer)
      this.receiptTimers.delete(route.correlationId)
      await this.persistSent()
      this.changed()
    }
  }

  private async request(type: 'offer' | 'answer', command: () => Promise<void> | undefined): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOffer = null
        this.pendingAnswer = null
        reject(new Error(`The WebRTC ${type} timed out.`))
      }, 15_000)
      const done = (sdp: string) => { clearTimeout(timer); resolve(sdp) }
      if (type === 'offer') this.pendingOffer = done
      else this.pendingAnswer = done
      void command()?.catch((error: unknown) => {
        clearTimeout(timer)
        this.pendingOffer = null
        this.pendingAnswer = null
        reject(error)
      })
    })
  }

  private async flushReceipts(): Promise<void> {
    const results = await Promise.allSettled([...this.pendingReceipts].map(async ([transferId, pending]) => {
      if (!this.window) throw new Error('The WebRTC window is unavailable.')
      await this.window.command({ type: 'send', data: encodeFrame(4, pending.receipt).toString('base64') })
      return transferId
    }))
    for (const result of results) {
      if (result.status === 'fulfilled') this.pendingReceipts.delete(result.value)
    }
    await this.persistReceipts()
    this.changed()
  }

  private failWindow(error: unknown): void {
    this.closeWindow()
    this.error = error instanceof Error ? error.message : 'The WebRTC connection could not start.'
    this.changed()
  }

  private startConnectionTimer(): void {
    this.clearConnectionTimer()
    this.connectTimer = setTimeout(() => {
      this.error = 'The WebRTC connection timed out.'
      this.closeWindow()
      this.changed()
    }, connectionTimeout)
  }

  private clearConnectionTimer(): void {
    clearTimeout(this.connectTimer)
    this.connectTimer = undefined
  }

  private closeWindow(): void {
    this.clearConnectionTimer()
    this.window?.close()
    this.window = undefined
    this.ready = false
    this.route = null
    this.peerId = null
    this.sessionId = null
    this.offerDigest = null
    this.offerLink = null
    this.answerLink = null
  }

  private async load(): Promise<void> {
    const [sent, incoming, receipts] = await Promise.all([
      readJson(this.sentPath(), sentSchema),
      readJson(this.incomingPath(), incomingSchema),
      readJson(this.receiptsPath(), z.record(z.uuidv4(), pendingReceiptSchema))
    ])
    if (sent) for (const item of sent) {
      if (item.state === 'pending' && item.createdAt + receiptTimeout <= Date.now()) item.state = 'manual'
      this.sent.set(item.transferId, item)
    }
    if (incoming) for (const item of incoming) {
      this.incoming.set(item.transferId, { ...item, payload: Buffer.from(item.payload, 'base64'), wrappedKey: Buffer.from(item.wrappedKey, 'base64') })
    }
    if (receipts) for (const [id, value] of Object.entries(receipts)) {
      this.pendingReceipts.set(id, typeof value === 'string'
        ? { receipt: Buffer.from(value, 'base64'), senderName: 'Verified device', projectName: 'Received transfer', receivedAt: Date.now() }
        : { ...value, receipt: Buffer.from(value.receipt, 'base64') })
    }
  }

  private async persistSent(): Promise<void> {
    await writeJson(this.sentPath(), [...this.sent.values()])
  }

  private async persistIncoming(): Promise<void> {
    await writeJson(this.incomingPath(), [...this.incoming.values()].map((item) => ({
      ...item, payload: item.payload.toString('base64'), wrappedKey: item.wrappedKey.toString('base64')
    })))
  }

  private async persistReceipts(): Promise<void> {
    await writeJson(this.receiptsPath(), Object.fromEntries([...this.pendingReceipts].map(([id, value]) =>
      [id, { ...value, receipt: value.receipt.toString('base64') }])))
  }

  private sentPath(): string { return join(this.root, 'webrtc-sent.json') }
  private incomingPath(): string { return join(this.root, 'webrtc-inbox.json') }
  private receiptsPath(): string { return join(this.root, 'webrtc-receipts.json') }
}

function requireSdp(value: string): string {
  if (!value || Buffer.byteLength(value, 'utf8') > 8192) throw new Error('The WebRTC session description is invalid.')
  const lines = value.split(/\r?\n/).filter(Boolean)
  const media = lines.filter((line) => line.startsWith('m='))
  if (media.length !== 1 || !/^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel$/.test(media[0] ?? '')) {
    throw new Error('The WebRTC session must use one data channel.')
  }
  if (!lines.some((line) => /^a=sctp-port:\d+$/.test(line))) throw new Error('The WebRTC session has no SCTP port.')
  const fingerprints = lines.filter((line) => line.startsWith('a=fingerprint:'))
  if (fingerprints.length !== 1 || !/^a=fingerprint:sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprints[0] ?? '')) {
    throw new Error('The WebRTC session must contain one SHA-256 fingerprint.')
  }
  return value
}

function requireSend(input: unknown): { projectId: string; secretIds: string[]; recipientId: string; accessExpiresAt: number | null; injectionOnly: boolean } {
  const parsed = z.strictObject({
    projectId: z.string().min(1), secretIds: z.array(z.string().min(1)).min(1).max(1000),
    recipientId: z.string().regex(/^[0-9a-f]{64}$/), accessExpiresAt: z.number().int().nonnegative().nullable(), injectionOnly: z.boolean()
  }).safeParse(input)
  if (!parsed.success) throw new Error('Select a project, secrets, and a WebRTC recipient.')
  return parsed.data
}

function requireImport(input: unknown): { transferId: string; projectId: string } {
  const parsed = z.strictObject({ transferId: z.uuidv4(), projectId: z.string().min(1) }).safeParse(input)
  if (!parsed.success) throw new Error('Select a received WebRTC transfer and a destination project.')
  return parsed.data
}

function requireReceipt(input: unknown): { transferId: string; link: string } {
  const parsed = z.strictObject({ transferId: z.uuidv4(), link: z.string() }).safeParse(input)
  if (!parsed.success) throw new Error('Select a sent WebRTC transfer and paste its receipt link.')
  return parsed.data
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    const parsed = schema.safeParse(value)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 })
  await rename(`${path}.tmp`, path)
}
