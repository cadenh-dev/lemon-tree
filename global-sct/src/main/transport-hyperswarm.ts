import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'
import { readReceipt, readTransfer } from './envelope'
import { encodeFrame, FrameReader, readTransferBody, transferBody } from './direct-frame'
import { decodeReceiptLink, encodeReceiptLink } from './transport-link'
import type { Sharing } from './sharing'
import type { DirectImportInput, DirectImportResult, DirectIncomingItem, DirectReceiptInput,
  DirectSendInput, DirectSentItem, DirectState } from '../shared/direct'
import type { TransferReceipt } from '../shared/transport'

const authLimit = 4096
const receiptLimit = 16_384
const authTimeout = 30_000
const receiptTimeout = 10 * 60 * 1000
const pingInterval = 15_000
const pongLimit = 30_000
const require = createRequire(__filename)

interface HyperswarmPeerInfo {
  publicKey: Buffer
  topics?: Buffer[]
  client: boolean
}

interface HyperswarmSocket {
  write(data: Buffer): boolean
  end(): void
  destroy(): void
  on(event: 'data', listener: (data: Buffer) => void): this
  on(event: 'close' | 'end', listener: () => void): this
  on(event: 'error', listener: (error: Error) => void): this
}

interface HyperswarmDiscovery {
  flushed(): Promise<void>
  destroy(): Promise<void>
}

interface HyperswarmInstance extends EventEmitter {
  keyPair: { publicKey: Buffer; secretKey: Buffer }
  join(topic: Buffer, options?: { server?: boolean; client?: boolean }): HyperswarmDiscovery
  leave(topic: Buffer): Promise<void>
  destroy(): Promise<void>
  on(event: 'connection', listener: (socket: HyperswarmSocket, info: HyperswarmPeerInfo) => void): this
  on(event: 'update' | 'error', listener: (...args: unknown[]) => void): this
}

interface HyperswarmConstructor {
  new (options?: { maxPeers?: number }): HyperswarmInstance
}

const Hyperswarm = require('hyperswarm') as HyperswarmConstructor

interface Session {
  socket: HyperswarmSocket
  reader: FrameReader
  nonce: string
  remoteNonce: string | null
  remoteNoise: Buffer | null
  peerId: string | null
  message: Buffer | null
  ready: boolean
  lastPong: number
  chain: Promise<void>
  authTimer: NodeJS.Timeout
  pingTimer?: NodeJS.Timeout
}

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
  transferId: z.uuidv4(),
  recipientId: z.string().regex(/^[0-9a-f]{64}$/),
  projectName: z.string().min(1).max(100),
  secretNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/)).min(1).max(1000),
  createdAt: z.number().int().nonnegative(),
  deliverBy: z.number().int().nonnegative(),
  state: z.enum(['pending', 'received', 'manual', 'expired', 'failed']),
  receivedAt: z.number().int().nonnegative().nullable(),
  error: z.string().nullable()
}))

const incomingSchema = z.array(z.object({
  transferId: z.uuidv4(),
  senderId: z.string().regex(/^[0-9a-f]{64}$/),
  senderName: z.string().min(1).max(100),
  projectName: z.string().min(1).max(100),
  secretNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/)).min(1).max(1000),
  deliverBy: z.number().int().nonnegative(),
  accessExpiresAt: z.number().int().nonnegative().nullable(),
  injectionOnly: z.boolean(),
  error: z.string().nullable(),
  payload: z.string(),
  wrappedKey: z.string()
}))

export class HyperswarmTransport {
  private swarm: HyperswarmInstance | undefined
  private readonly topics = new Map<string, { day: string; topic: Buffer; discovery: HyperswarmDiscovery }>()
  private readonly sessions = new Set<Session>()
  private readonly sending = new Set<string>()
  private readonly byPeer = new Map<string, Session>()
  private readonly sent = new Map<string, DirectSentItem>()
  private readonly incoming = new Map<string, IncomingRecord>()
  private readonly pendingReceipts = new Map<string, PendingReceiptRecord>()
  private readonly receiptTimers = new Map<string, NodeJS.Timeout>()
  private started = false
  private error: string | null = null
  private rotation: NodeJS.Timeout | undefined

  constructor(private readonly sharing: Sharing, private readonly root: string, private readonly changed: () => void) {}

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.error = null
    try {
      await this.load()
      this.swarm = new Hyperswarm()
      this.swarm.on('connection', (socket, info) => this.connection(socket, info))
      this.swarm.on('error', (error) => {
        this.error = message(error)
        this.changed()
      })
      await this.joinPeers()
      this.rotation = setInterval(() => { void this.rotate() }, 60_000)
      this.changed()
    } catch (error) {
      this.started = false
      this.error = message(error)
      this.changed()
      throw error
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    clearInterval(this.rotation)
    this.rotation = undefined
    const swarm = this.swarm
    if (swarm) {
      await Promise.all([...this.topics.values()].map(async ({ topic, discovery }) => {
        await swarm.leave(topic).catch(() => undefined)
        await discovery.destroy().catch(() => undefined)
      }))
    }
    this.topics.clear()
    for (const timer of this.receiptTimers.values()) clearTimeout(timer)
    this.receiptTimers.clear()
    for (const session of [...this.sessions]) this.close(session)
    await this.swarm?.destroy().catch(() => undefined)
    this.swarm = undefined
    this.changed()
  }

  async refresh(): Promise<void> {
    await this.joinPeers()
  }

  async state(): Promise<DirectState> {
    const peers = await this.sharing.directPeers()
    const incoming = [...this.incoming.values()].map((record) => ({
      transferId: record.transferId,
      senderId: record.senderId,
      senderName: record.senderName,
      projectName: record.projectName,
      secretNames: record.secretNames,
      deliverBy: record.deliverBy,
      accessExpiresAt: record.accessExpiresAt,
      injectionOnly: record.injectionOnly,
      error: record.error
    }))
    return {
      connection: this.error ? 'error' : !this.started ? 'off' : this.topics.size > 0 ? 'ready' : 'starting',
      peers: peers.map((peer) => ({ ...peer, available: this.byPeer.has(peer.id) })),
      incoming,
      sent: [...this.sent.values()].sort((left, right) => right.createdAt - left.createdAt),
      receipts: [...this.pendingReceipts].map(([transferId, value]) => ({
        transferId, senderName: value.senderName, projectName: value.projectName, receiptLink: encodeReceiptLink(value.receipt)
      })),
      error: this.error
    }
  }

  async send(input: unknown): Promise<void> {
    const request = requireSend(input)
    const session = this.byPeer.get(request.recipientId)
    if (!session?.ready) throw new Error('Peer not reachable. Use Link or Relay.')
    if (this.sending.has(request.recipientId)) throw new Error('A Direct transfer to this peer is already active. Wait for it to finish.')
    if (this.sending.size >= 4) throw new Error('Wait for an active Direct transfer to finish.')
    this.sending.add(request.recipientId)
    try {
      const sealed = await this.sharing.prepareEnvelope({ ...request, deliverBy: Date.now() + 24 * 60 * 60 * 1000 })
      const wrapped = sealed.wrappedKeys[0]
      if (!wrapped || sealed.wrappedKeys.length !== 1) throw new Error('Select one verified recipient.')
      const transfer = readTransfer(sealed.payload)
      this.write(session, 3, transferBody(sealed.payload, wrapped.wrappedKey))
      const record: DirectSentItem = {
        transferId: sealed.id, recipientId: request.recipientId, projectName: sealed.projectName,
        secretNames: sealed.secretNames, createdAt: transfer.createdAt, deliverBy: transfer.deliverBy,
        state: 'pending', receivedAt: null, error: null
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
      this.sending.delete(request.recipientId)
    }
  }

  async import(input: unknown): Promise<DirectImportResult> {
    const request = requireImport(input)
    const record = this.incoming.get(request.transferId)
    if (!record) throw new Error('The received Direct transfer is unavailable.')
    const accepted = await this.sharing.acceptEnvelope(record.payload, record.wrappedKey, request.projectId, async () => undefined)
    const receiptLink = encodeReceiptLink(accepted.receipt)
    const session = this.byPeer.get(record.senderId)
    const receiptSent = session?.ready === true
    if (session?.ready) this.write(session, 4, accepted.receipt)
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
    if (!sent) throw new Error('The sent Direct transfer is unavailable.')
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

  private connection(socket: HyperswarmSocket, info: HyperswarmPeerInfo): void {
    if (!this.started || !this.swarm) {
      socket.destroy()
      return
    }
    const sessions = [...this.sessions]
    if (sessions.filter((session) => session.ready).length >= 32 || sessions.filter((session) => !session.ready).length >= 8) {
      socket.destroy()
      return
    }
    const session: Session = {
      socket, reader: new FrameReader(), nonce: randomBytes(32).toString('base64url'),
      remoteNonce: null, remoteNoise: Buffer.from(info.publicKey), peerId: null, message: null, ready: false,
      lastPong: Date.now(), chain: Promise.resolve(),
      authTimer: setTimeout(() => this.close(session), authTimeout)
    }
    this.sessions.add(session)
    socket.on('data', (data) => {
      session.chain = session.chain.then(async () => {
        let frames = Promise.resolve()
        for (const frame of session.reader.push(Buffer.from(data))) {
          frames = frames.then(() => this.frame(session, frame.kind, frame.body))
        }
        await frames
      }).catch(() => this.close(session))
    })
    socket.on('error', () => this.close(session))
    socket.on('close', () => this.close(session))
    void this.sendHello(session)
  }

  private async sendHello(session: Session): Promise<void> {
    const device = await this.sharing.directDevice()
    this.write(session, 1, Buffer.from(JSON.stringify({ version: 1, deviceId: device.id, nonce: session.nonce })))
  }

  private async frame(session: Session, kind: number, body: Buffer): Promise<void> {
    if (kind === 1) return this.hello(session, body)
    if (kind === 2) return this.authenticate(session, body)
    if (kind === 3) return this.transfer(session, body)
    if (kind === 4) return this.receipt(session, body)
    if (kind === 5) {
      if (body.length !== 8) throw new Error('Invalid Direct ping.')
      this.write(session, 6, body)
      return
    }
    if (kind === 6) {
      if (body.length !== 8) throw new Error('Invalid Direct pong.')
      session.lastPong = Date.now()
      return
    }
    throw new Error('Unknown Direct frame.')
  }

  private async hello(session: Session, body: Buffer): Promise<void> {
    if (body.length > authLimit) throw new Error('The Direct hello is too large.')
    const value: unknown = JSON.parse(body.toString('utf8'))
    if (!isRecord(value) || value.version !== 1 || typeof value.deviceId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.deviceId) || typeof value.nonce !== 'string' ||
      !canonicalBase64url(value.nonce) || Buffer.from(value.nonce, 'base64url').length !== 32) {
      throw new Error('The Direct hello is invalid.')
    }
    const peer = await this.sharing.directPeer(value.deviceId)
    if (!peer) throw new Error('The Direct peer is not verified.')
    session.peerId = value.deviceId
    session.remoteNonce = value.nonce
    await this.sendAuthenticate(session)
  }

  private async sendAuthenticate(session: Session): Promise<void> {
    if (!session.peerId || !session.remoteNonce || !session.remoteNoise || !this.swarm) throw new Error('The Direct hello is incomplete.')
    const self = await this.sharing.directDevice()
    const first = { id: self.id, nonce: session.nonce, noise: Buffer.from(this.swarm.keyPair.publicKey).toString('base64') }
    const second = { id: session.peerId, nonce: session.remoteNonce, noise: Buffer.from(session.remoteNoise).toString('base64') }
    const [low, high] = first.id < second.id ? [first, second] : [second, first]
    session.message = Buffer.from(JSON.stringify(['sct-direct-auth-v1', low.id, high.id, low.nonce, high.nonce, low.noise, high.noise]))
    const signature = await this.sharing.directSign(session.message)
    this.write(session, 2, Buffer.from(JSON.stringify({ version: 1, signature: signature.toString('base64') })))
  }

  private async authenticate(session: Session, body: Buffer): Promise<void> {
    if (!session.peerId || !session.message) throw new Error('The Direct authentication arrived early.')
    if (body.length > authLimit) throw new Error('The Direct authentication is too large.')
    const value: unknown = JSON.parse(body.toString('utf8'))
    if (!isRecord(value) || value.version !== 1 || typeof value.signature !== 'string' ||
      !canonicalBase64(value.signature) || Buffer.from(value.signature, 'base64').length !== 64) {
      throw new Error('The Direct authentication is invalid.')
    }
    if (!(await this.sharing.directVerify(session.peerId, session.message, Buffer.from(value.signature, 'base64')))) {
      throw new Error('The Direct signature is invalid.')
    }
    session.ready = true
    clearTimeout(session.authTimer)
    session.lastPong = Date.now()
    session.pingTimer = setInterval(() => {
      if (Date.now() - session.lastPong > pongLimit) {
        this.close(session)
        return
      }
      try {
        this.write(session, 5, randomBytes(8))
      } catch {
        this.close(session)
      }
    }, pingInterval)
    this.byPeer.set(session.peerId, session)
    for (const [transferId, pending] of this.pendingReceipts) {
      const sent = this.sent.get(transferId)
      if (sent?.recipientId === session.peerId) {
        this.write(session, 4, pending.receipt)
        this.pendingReceipts.delete(transferId)
      }
    }
    await this.persistReceipts()
    this.changed()
  }

  private async transfer(session: Session, body: Buffer): Promise<void> {
    if (!session.ready || !session.peerId) throw new Error('The Direct session is not authenticated.')
    const parsed = readTransferBody(body)
    const preview = await this.sharing.previewEnvelope(parsed.payload, parsed.wrappedKey)
    const record: IncomingRecord = {
      transferId: preview.messageId, senderId: session.peerId, senderName: (await this.sharing.directPeer(session.peerId))?.name ?? 'Verified device',
      projectName: preview.projectName, secretNames: preview.secretNames, deliverBy: preview.deliverBy,
      accessExpiresAt: preview.accessExpiresAt, injectionOnly: preview.injectionOnly, error: null,
      payload: parsed.payload, wrappedKey: parsed.wrappedKey
    }
    this.incoming.set(record.transferId, record)
    await this.persistIncoming()
    this.changed()
  }

  private async receipt(session: Session, body: Buffer): Promise<void> {
    if (!session.ready || !session.peerId) throw new Error('The Direct session is not authenticated.')
    if (body.length > receiptLimit) throw new Error('The Direct receipt is too large.')
    const route = readReceipt(body)
    const sent = this.sent.get(route.correlationId)
    if (!sent || sent.recipientId !== session.peerId) throw new Error('The Direct receipt belongs to another transfer.')
    const verified = await this.sharing.verifyEnvelopeReceipt(session.peerId, route.correlationId, body, 'direct')
    sent.state = 'received'
    sent.receivedAt = verified.receivedAt
    sent.error = null
    const timer = this.receiptTimers.get(route.correlationId)
    if (timer) clearTimeout(timer)
    this.receiptTimers.delete(route.correlationId)
    await this.persistSent()
    this.changed()
  }

  private write(session: Session, kind: number, body: Buffer): void {
    session.socket.write(encodeFrame(kind, body))
  }

  private close(session: Session): void {
    clearTimeout(session.authTimer)
    if (session.pingTimer) clearInterval(session.pingTimer)
    this.sessions.delete(session)
    if (session.peerId && this.byPeer.get(session.peerId) === session) this.byPeer.delete(session.peerId)
    session.socket.destroy()
    this.changed()
  }

  private async joinPeers(): Promise<void> {
    if (!this.swarm) return
    const peers = await this.sharing.directPeers()
    await Promise.all(peers.map((peer) => this.joinPeer(peer.id).catch((error: unknown) => {
      this.error = message(error)
    })))
    this.changed()
  }

  private async joinPeer(peerId: string): Promise<void> {
    const day = utcDay()
    const current = this.topics.get(peerId)
    if (current?.day === day) return
    if (current) {
      await Promise.all([
        this.swarm?.leave(current.topic).catch(() => undefined),
        current.discovery.destroy().catch(() => undefined)
      ])
    }
    const topic = await this.sharing.directTopic(peerId, day)
    const discovery = this.swarm?.join(topic, { server: true, client: true })
    if (!discovery) return
    this.topics.set(peerId, { day, topic, discovery })
    void discovery.flushed().catch((error: unknown) => {
      this.error = message(error)
      this.changed()
    })
  }

  private async rotate(): Promise<void> {
    if (!this.started) return
    await this.joinPeers()
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

  private sentPath(): string { return join(this.root, 'direct-sent.json') }
  private incomingPath(): string { return join(this.root, 'direct-inbox.json') }
  private receiptsPath(): string { return join(this.root, 'direct-receipts.json') }
}

function requireSend(input: unknown): DirectSendInput {
  const parsed = z.strictObject({
    projectId: z.string().min(1), secretIds: z.array(z.string().min(1)).min(1).max(1000),
    recipientId: z.string().regex(/^[0-9a-f]{64}$/), accessExpiresAt: z.number().int().nonnegative().nullable(),
    injectionOnly: z.boolean()
  }).safeParse(input)
  if (!parsed.success) throw new Error('Select a project, secrets, and a verified Direct recipient.')
  return parsed.data
}

function requireImport(input: unknown): DirectImportInput {
  const parsed = z.strictObject({ transferId: z.uuidv4(), projectId: z.string().min(1) }).safeParse(input)
  if (!parsed.success) throw new Error('Select a received Direct transfer and a destination project.')
  return parsed.data
}

function requireReceipt(input: unknown): DirectReceiptInput {
  const parsed = z.strictObject({ transferId: z.uuidv4(), link: z.string() }).safeParse(input)
  if (!parsed.success) throw new Error('Select a sent Direct transfer and paste its receipt link.')
  return parsed.data
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10)
}

function canonicalBase64(value: string): boolean {
  return Buffer.from(value, 'base64').toString('base64') === value
}

function canonicalBase64url(value: string): boolean {
  return Buffer.from(value, 'base64url').toString('base64url') === value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The Direct transport failed.'
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    const parsed = schema.safeParse(value)
    return parsed.success ? parsed.data : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return null
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 })
  await rename(`${path}.tmp`, path)
}
