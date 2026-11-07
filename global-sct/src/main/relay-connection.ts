import { AsyncEntry } from '@napi-rs/keyring'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Identity, Timestamp } from 'spacetimedb'
import { DbConnection } from './relay'
import { decodeFile, encodeFile, open, seal } from './seal'
import { clockSkew, deliveryLimit, readTransfer } from './envelope'
import type { RelayPeerKeys, SealedTransfer } from './envelope'
import type { RelayTransferPreview, Sharing } from './sharing'
import { readDeviceCard, relayPairingCode } from './transfer'
import type { DeviceCard } from './transfer'
import type { SecretMetadata } from '../shared/secrets'
import type { GrantCleanupOutcome, Vault } from './vault'
import type { RelayMessageKind, RelayTaskOutcome } from '../shared/envelope'
import { relayInboxFinished, relaySentFinished, relayTaskFinished } from '../shared/relay'
import type { RelayAcceptInput, RelayActivityKey, RelayConnection, RelayDeliveryState, RelayInboxItem, RelayPeer, RelayQueueInput,
  RelaySentItem, RelayState, RelayTaskDecision, RelayTaskItem } from '../shared/relay'
import type { TransferReceipt } from '../shared/transport'
import type { ShareSummary } from '../shared/share'
import { relayReceiptState } from './transport'

export interface RelayServer {
  uri: string
  database: string
}

// The main process methods that use the device private keys. The relay connection never receives those keys.
export type RelayCrypto = Pick<Sharing, 'deviceCard' | 'prepareRelayTransfer' | 'previewRelayTransfer' | 'acceptRelayTransfer' |
  'verifyRelayReceipt' | 'prepareRelayExpiryNotice' | 'verifyRelayExpiryNotice' | 'prepareRelayMessage' | 'openRelayMessage' |
  'sealRelayMessageReceipt'>

// Only the desktop app writes relay files and runs remote tasks.
// An agent session gets no writer: it reads the files and the live relay rows, and writes only new task requests.
export interface RelayWriter {
  runTask: (projectId: string, grantId: string) => Promise<{ exitCode: number; secretPresent: boolean }>
  cleanupGrants: () => Promise<GrantCleanupOutcome[]>
}

interface CachedPeer {
  pairId: string
  identity: string
  initiator: string
  name: string
  status: RelayPeer['status']
  encryptionPublicKey: string
  signingPublicKey: string
}

interface CachedSentItem {
  messageId: string
  recipient: string
  status: 'Pending' | 'Received'
  deliverBy: string
  receivedAt: string | null
  receipt: string | null
}

type VerifiedReceipt = { receipt: TransferReceipt; error: null } | { receipt: null; error: string }

interface CachedInboxItem {
  messageId: string
  sender: string
  createdAt: string
  deliverBy: string
  payload: string
  wrappedKey: string
}

interface CachedExpiryNotice {
  id: string
  correlationId: string
  sender: string
  notice: string
  createdAt: string
  retainUntil: string
}

// The cache keeps the relay rows of the last connection. Inbox payloads and wrapped keys stay ciphertext.
interface Cache {
  identity: string | null
  updatedAt: string | null
  peers: CachedPeer[]
  inbox: CachedInboxItem[]
  sent: CachedSentItem[]
  expiryNotices: CachedExpiryNotice[]
}

// Transfers, tasks, and results use the same outbox, retries, and deadlines.
interface OutboundTransfer {
  messageId: string
  kind: RelayMessageKind
  // Tasks only: the transfer whose grant the task uses, and the approval deadline.
  grantId: string | null
  approveBy: number | null
  // Results only: the task that the result answers.
  taskId: string | null
  recipient: string
  createdAt: number
  deliverBy: number
  payload: string
  wrappedKey: string
  accessExpiresAt: number | null
  error: string | null
}

interface OutboundExpiryNotice {
  id: string
  correlationId: string
  recipient: string
  createdAt: number
  publishBy: number
  notice: string
  published: boolean
  error: string | null
}

interface ReceivedTransfer {
  messageId: string
  digest: string
  sender: string
  createdAt: string
  deliverBy: number
  projectName: string
  secretNames: string[]
  accessExpiresAt: number | null
  injectionOnly: boolean
  destinationProjectId: string
  receivedAt: number | null
  secrets: SecretMetadata[]
  receipt: string | null
  complete: boolean
  acknowledged: boolean
  error: string | null
}

// claimed: the approved run started. A claim without an outcome after a restart becomes uncertain.
type ReceivedTaskState = 'awaiting-approval' | 'claimed' | RelayTaskOutcome

interface ReceivedTask {
  messageId: string
  digest: string
  sender: string
  createdAt: string
  deliverBy: number
  grantId: string
  approveBy: number
  state: ReceivedTaskState
  exitCode: number | null
  secretPresent: boolean | null
  finishedAt: number | null
  // Why the task did not complete. The result does not contain this text.
  reason: string | null
  // The user reviewed an uncertain outcome, so its result can go to the sender.
  reviewed: boolean
  receipt: string
  acknowledged: boolean
  // A problem with the delivery receipt or the result. A later pending run tries again.
  error: string | null
}

interface ReceivedResult {
  messageId: string
  digest: string
  sender: string
  deliverBy: number
  taskId: string
  status: RelayTaskOutcome
  exitCode: number | null
  secretPresent: boolean | null
  finishedAt: number
  receipt: string
  acknowledged: boolean
  error: string | null
}

// A task request from an agent session. The desktop app seals it into the outbox and then deletes the file.
interface TaskRequest {
  id: string
  grantId: string
  createdAt: number
  approveBy: number
}

interface PendingResult {
  changed: boolean
  failed: boolean
}

// The keys of a peer at the time both users compared the pairing code.
interface Pin {
  identity: string
  encryptionKey: string
  signingKey: string
}

const liveServer: RelayServer = { uri: 'https://maincloud.spacetimedb.com', database: 'sct-relay' }
const magic = Buffer.from('SCR1')
const emptyCache: Cache = { identity: null, updatedAt: null, peers: [], inbox: [], sent: [], expiryNotices: [] }
const retentionPeriod = 30 * 24 * 60 * 60 * 1000
const pendingUnchanged: PendingResult = { changed: false, failed: false }
const pendingChanged: PendingResult = { changed: true, failed: false }
const pendingFailed: PendingResult = { changed: true, failed: true }
// A remote task waits up to this long for local approval.
const taskApprovalPeriod = 24 * 60 * 60 * 1000
type SealedName = 'cache' | 'peers' | 'outbox' | 'received' | 'notices' | 'tasks' | 'results' | 'hidden'

// SCT_RELAY=off turns the relay off. SCT_RELAY=<server URL>/<database> selects another relay, such as a local test server.
export function relayServer(setting = process.env.SCT_RELAY): RelayServer | undefined {
  if (setting === 'off') return undefined
  if (!setting) return liveServer
  const url = new URL(setting)
  const database = url.pathname.slice(1)
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(database)) throw new Error('Set SCT_RELAY to off, or to a server URL followed by a database name.')
  return { uri: url.origin, database }
}

export class Relay {
  private connection: DbConnection | undefined
  private cache: Cache = emptyCache
  private outbox: OutboundTransfer[] = []
  private received: ReceivedTransfer[] = []
  private notices: OutboundExpiryNotice[] = []
  private tasks: ReceivedTask[] = []
  private results: ReceivedResult[] = []
  private requests: { request: TaskRequest; error: string | null }[] = []
  // Inbox messages that fail to open stay unacknowledged. The window shows the reason.
  private messageErrors = new Map<string, string>()
  private pins: Pin[] = []
  // Keys of finished activity rows that the user deleted from the list. The records stay.
  private hidden: string[] = []
  private status: RelayConnection
  private registered = false
  private error: string | null = null
  private attempt = 0
  private retry: NodeJS.Timeout | undefined
  private deliveryRetry: NodeJS.Timeout | undefined
  private deliveryAttempt = 0
  private stopped = false
  private watcher: FSWatcher | undefined
  private saving: Promise<void> = Promise.resolve()
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly server: RelayServer | undefined, private readonly directory: string,
    private readonly crypto: () => Promise<RelayCrypto>,
    private readonly changed: () => void,
    private readonly vault: Vault,
    private readonly writer?: RelayWriter,
    private readonly service = '.sct-relay') {
    this.status = server ? 'connecting' : 'off'
  }

  async start(): Promise<void> {
    if (!this.server) return
    this.cache = normalizeCache(await this.readSealed('cache', emptyCache))
    await this.load()
    if (this.writer) {
      // The app stopped during these runs, so global.sct cannot know whether the process finished. The user must review them.
      if (this.tasks.some((task) => task.state === 'claimed')) {
        await this.saveTasks(this.tasks.map((task) => task.state === 'claimed'
          ? { ...task, state: 'uncertain', error: 'The app stopped during this run. Review it before global.sct sends the result.' } : task))
      }
      await this.pruneRetained()
      // Agent sessions add request files while the app runs.
      await mkdir(this.requestDirectory(), { recursive: true, mode: 0o700 })
      this.watcher = watch(this.requestDirectory(), () => { void this.importRequests() })
      await this.importRequests()
    }
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.watcher?.close()
    clearTimeout(this.retry)
    clearTimeout(this.deliveryRetry)
    this.connection?.disconnect()
  }

  async state(): Promise<RelayState> {
    // The desktop app can change the files at any time, so an agent session reads them again.
    if (!this.writer && this.server) await this.load()
    const [local, { inbox, sent, tasks }] = await Promise.all([this.deviceCard().catch(() => undefined), this.activity()])
    const hidden = new Set(this.hidden)
    return {
      connection: this.status,
      identity: this.cache.identity,
      registered: this.registered,
      error: this.error,
      updatedAt: this.cache.updatedAt,
      peers: this.cache.peers.map((peer) => describePeer(peer, local, this.cache.identity, this.pins)),
      inbox: inbox.filter((item) => !hidden.has(inboxRow(item).hiddenKey)),
      sent: sent.filter((item) => !hidden.has(sentRow(item).hiddenKey)),
      tasks: tasks.filter((item) => !hidden.has(taskRow(item).hiddenKey))
    }
  }

  // Deletes one finished row from the activity list. The records stay, so duplicate checks, grants, and cleanup notices still work.
  hideActivity(input: unknown): Promise<void> {
    return this.serialize(async () => {
      this.requireWriter()
      const key = activityKey(requireActivityKey(input))
      const rows = activityRows(await this.activity())
      const row = rows.find((row) => row.key === key && row.finished)
      if (!row) throw new Error('Only finished delivery activity can be deleted. Refresh the list and try again.')
      // Keys of rows that no longer exist or changed state go away, so the list does not grow.
      const current = new Set(rows.map((row) => row.hiddenKey))
      await this.writeHidden([...this.hidden.filter((saved) => saved !== row.hiddenKey && current.has(saved)), row.hiddenKey])
    })
  }

  // Deletes all rows from the activity list, also active rows. An active row shows again when its state changes.
  hideAllActivity(): Promise<void> {
    return this.serialize(async () => {
      this.requireWriter()
      await this.writeHidden(activityRows(await this.activity()).map((row) => row.hiddenKey))
    })
  }

  private async writeHidden(keys: string[]): Promise<void> {
    await this.writeSealed('hidden', { keys })
    this.hidden = keys
    this.changed()
  }

  queueGrantExpiryNotifications(outcomes: GrantCleanupOutcome[]): Promise<void> {
    return this.serialize(() => this.queueExpiryNotices(outcomes))
  }

  // Returns the message ID. The recipient must approve the task in its own window before the fixed demo starts.
  queueTask(grantId: unknown): Promise<string> {
    const now = Date.now()
    return this.serialize(() => this.queueTaskRequest({ id: randomUUID(), grantId: requireMessageId(grantId), createdAt: now,
      approveBy: now + taskApprovalPeriod }))
  }

  // An agent session writes one new file for each task. The desktop app is the only process that writes the outbox.
  async requestTask(grantId: unknown): Promise<string> {
    const now = Date.now()
    const request = { id: randomUUID(), grantId: requireMessageId(grantId), createdAt: now, approveBy: now + taskApprovalPeriod }
    await this.load()
    await this.grantRecipient(request.grantId)
    const file = join(this.requestDirectory(), `${request.id}.sct`)
    await mkdir(this.requestDirectory(), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(temporary, encodeFile(magic, seal(await this.sealedKey('requests'), Buffer.from(JSON.stringify(request)),
      this.requestData(request.id))), { mode: 0o600 })
    await rename(temporary, file)
    return request.id
  }

  // The desktop app moves agent task requests into its outbox. A request that fails stays in its file and shows its error.
  importRequests(): Promise<void> {
    return this.serialize(async () => {
      if (!this.writer || !this.server) return
      const remaining: Relay['requests'] = []
      let requests: TaskRequest[]
      try {
        requests = await this.readRequests()
      } catch (error) {
        this.error = `Cannot read the agent task requests. ${message(error)}`
        this.changed()
        return
      }
      for (const request of requests) {
        try {
          if (request.approveBy <= Date.now()) throw new Error('The approval deadline passed before the app could send this task.')
          await this.queueTaskRequest(request)
          await rm(join(this.requestDirectory(), `${request.id}.sct`), { force: true })
        } catch (error) {
          remaining.push({ request, error: message(error) })
        }
      }
      this.requests = remaining
      this.changed()
    })
  }

  // Only a decision from this device's window reaches this method. The digest ties the decision to one exact task.
  async respondTask(value: unknown): Promise<void> {
    const writer = this.requireWriter()
    const input = requireTaskDecision(value)
    const claim = await this.serialize(() => this.decideTask(writer, input))
    if (!claim) return
    let outcome: Pick<ReceivedTask, 'state' | 'exitCode' | 'secretPresent' | 'reason'>
    try {
      outcome = { state: 'completed', ...await writer.runTask(claim.projectId, claim.task.grantId), reason: null }
    } catch {
      outcome = { state: 'failed', exitCode: null, secretPresent: null,
        reason: 'The fixed demo could not run. Check the project, vault, and storage.' }
    }
    await this.serialize(() => this.updateTask(claim.task.messageId, { ...outcome, finishedAt: Date.now() }))
  }

  private async decideTask(writer: RelayWriter, input: RelayTaskDecision): Promise<{ task: ReceivedTask; projectId: string } | null> {
    const task = this.tasks.find((item) => item.messageId === input.messageId)
    if (!task || task.digest !== input.digest) throw new Error('This task changed or no longer exists. Review it again.')
    if (input.decision === 'report') {
      if (task.state !== 'uncertain' || task.reviewed) throw new Error('This task has no uncertain outcome to report.')
      await this.updateTask(task.messageId, { reviewed: true })
      return null
    }
    if (task.state !== 'awaiting-approval') throw new Error('This task is no longer awaiting approval.')
    if (input.decision === 'refuse') {
      await this.updateTask(task.messageId, { state: 'refused', finishedAt: Date.now(), reason: 'The user refused this task on this device.' })
      return null
    }
    if (this.tasks.some((item) => item.state === 'uncertain' && !item.reviewed)) {
      throw new Error('Review the uncertain run first. global.sct starts no new run before that review.')
    }
    // Grant cleanup must finish before new access.
    await this.queueExpiryNotices(await writer.cleanupGrants())
    const grant = this.received.find((item) => item.messageId === task.grantId)
    const refusal = taskRefusal(grant, task.sender, task.approveBy, Date.now())
    if (refusal || !grant) {
      const reason = refusal ?? { state: 'refused' as const, reason: 'This task names no grant from its sender.' }
      await this.updateTask(task.messageId, { ...reason, finishedAt: Date.now() })
      throw new Error(reason.reason)
    }
    // The claim is durable before the start, so a restart cannot start the same task again.
    await this.saveTasks(this.tasks.map((item) => item.messageId === task.messageId ? { ...item, state: 'claimed' } : item))
    this.changed()
    return { task, projectId: grant.destinationProjectId }
  }

  private async updateTask(messageId: string, change: Partial<ReceivedTask>): Promise<void> {
    await this.saveTasks(this.tasks.map((item) => item.messageId === messageId ? { ...item, ...change } : item))
    if (this.connection && this.status === 'connected') await this.processPending(this.connection)
    this.changed()
  }

  private async queueTaskRequest(request: TaskRequest): Promise<string> {
    this.requireWriter()
    if (this.outbox.some((item) => item.messageId === request.id)) return request.id
    const identity = this.cache.identity
    if (!identity) throw new Error('Connect this device to the relay before you queue a task.')
    const recipient = await this.grantRecipient(request.grantId)
    const sealed = await (await this.crypto()).prepareRelayMessage(identity, recipient, 'task',
      { operation: 'run_demo', grantId: request.grantId, approveBy: request.approveBy }, request.approveBy, request.id)
    await this.saveOutbox([...this.outbox, outbound(sealed, recipient.identity,
      { kind: 'task', grantId: request.grantId, approveBy: request.approveBy, taskId: null, accessExpiresAt: null })])
    this.changed()
    if (this.connection && this.status === 'connected') await this.processPending(this.connection)
    return request.id
  }

  // A task can use only a grant that this device sent to that recipient and that the recipient imported.
  private async grantRecipient(grantId: string): Promise<RelayPeerKeys> {
    const grant = this.outbox.find((item) => item.kind === 'transfer' && item.messageId === grantId)
    if (!grant) throw new Error('Select a relay transfer that this device sent.')
    if (!this.cache.sent.some((item) => item.messageId === grantId && item.recipient === grant.recipient && item.status === 'Received')) {
      throw new Error('The recipient has not imported this transfer yet.')
    }
    if (grant.accessExpiresAt !== null && grant.accessExpiresAt <= Date.now()) throw new Error('Access to this transfer expired.')
    return this.verifiedPeer(grant.recipient)
  }

  private async queueExpiryNotices(outcomes: GrantCleanupOutcome[]): Promise<void> {
    this.requireWriter()
    const identity = this.cache.identity
    if (!identity) return
    const additions = (await Promise.all(this.received.map(async (transfer): Promise<OutboundExpiryNotice | null> => {
      if (!transfer.complete || transfer.accessExpiresAt === null || transfer.accessExpiresAt > Date.now() ||
        this.notices.some((notice) => notice.correlationId === transfer.messageId)) return null
      const removed = outcomes.filter((outcome) => outcome.status === 'removed' &&
        outcome.transferId.startsWith(`relay:${transfer.messageId}:`))
      if (!transfer.secrets.every((secret) => removed.some((outcome) => outcome.secretId === secret.id))) return null
      try {
        return {
          id: randomUUID(),
          correlationId: transfer.messageId,
          recipient: transfer.sender,
          createdAt: Date.now(),
          publishBy: Date.now() + deliveryLimit - clockSkew,
          notice: (await (await this.crypto()).prepareRelayExpiryNotice(identity, await this.verifiedPeer(transfer.sender),
            transfer.messageId, transfer.accessExpiresAt, transfer.secrets.length)).toString('base64'),
          published: false,
          error: null
        }
      } catch {
        // Keep the cleanup outcome. A later connection or repaired pairing can queue the notice.
        return null
      }
    }))).filter((notice): notice is OutboundExpiryNotice => notice !== null)
    if (additions.length) {
      this.notices.push(...additions)
      await this.writeSealed('notices', { notices: this.notices })
    }
    if (this.connection && this.status === 'connected') await this.processPending(this.connection)
    this.changed()
  }

  // The share confirmation reads the recipient and secret names without preparing the envelope.
  describeTransfer(value: unknown): Promise<ShareSummary> {
    return this.serialize(async () => {
      this.requireWriter()
      const input = requireQueueInput(value)
      const identity = this.cache.identity
      if (!identity) throw new Error('Connect this device to the relay before you queue a transfer.')
      const peer = this.cache.peers.find((saved) => saved.identity === input.recipient)
      if (!peer || peer.status !== 'Verified' || describePeer(peer, await this.deviceCard(), identity, this.pins).trust !== 'verified') {
        throw new Error('Select a verified relay recipient.')
      }
      const project = await this.vault.project(input.projectId)
      const ids = new Set(input.secretIds)
      const secretNames = (await this.vault.listProjectSecrets(input.projectId))
        .filter((secret) => ids.has(secret.id)).map((secret) => secret.name)
      if (secretNames.length !== ids.size || input.secretIds.length !== ids.size) {
        throw new Error('The selected secrets are unavailable. Refresh the project and try again.')
      }
      return { mode: 'mailbox', recipient: peer.name, project: project.name, secretNames }
    })
  }

  // Returns the message ID, so the window can follow the delivery state of this transfer.
  queueTransfer(value: unknown): Promise<string> {
    return this.serialize(async () => {
      this.requireWriter()
      // The relay checks the deadline against its own clock, so the margin allows a sender clock that is slightly ahead.
      const input = { ...requireQueueInput(value), deliverBy: Date.now() + deliveryLimit - clockSkew }
      const identity = this.cache.identity
      if (!identity) throw new Error('Connect this device to the relay before you queue a transfer.')
      const peer = this.cache.peers.find((saved) => saved.identity === input.recipient)
      if (!peer || peer.status !== 'Verified' || describePeer(peer, await this.deviceCard(), identity, this.pins).trust !== 'verified') {
        throw new Error('Select a verified relay recipient.')
      }
      const card = peerCard(peer)
      if (!card) throw new Error('The recipient keys are invalid. Remove this pair and pair the devices again.')
      const sealed = await (await this.crypto()).prepareRelayTransfer(identity, { identity: peer.identity, card }, input)
      const transfer = outbound(sealed, peer.identity,
        { kind: 'transfer', grantId: null, approveBy: null, taskId: null, accessExpiresAt: input.accessExpiresAt })
      await this.saveOutbox([...this.outbox, transfer])
      this.changed()
      if (this.connection && this.status === 'connected') await this.processPending(this.connection)
      return transfer.messageId
    })
  }

  acceptRelayTransfer(value: unknown): Promise<SecretMetadata[]> {
    return this.serialize(async () => {
      this.requireWriter()
      const input = requireAcceptInput(value)
      const identity = this.cache.identity
      if (!identity) throw new Error('Connect this device to the relay before you import a transfer.')
      const incoming = this.cache.inbox.find((item) => item.messageId === input.messageId)
      const saved = this.received.find((item) => item.messageId === input.messageId)
      if (!incoming && saved?.complete) {
        if (this.connection && this.status === 'connected') await this.processPending(this.connection)
        return saved.secrets
      }
      if (!incoming) throw new Error('This relay transfer is not available. Refresh the list and try again.')
      const sender = await this.verifiedPeer(incoming.sender)
      const payload = Buffer.from(incoming.payload, 'base64')
      const wrappedKey = Buffer.from(incoming.wrappedKey, 'base64')
      const crypto = await this.crypto()
      const preview = await crypto.previewRelayTransfer(identity, sender, payload, wrappedKey)
      requireSavedTransfer(saved, preview, input.projectId)
      if (saved?.complete) {
        if (this.connection && this.status === 'connected') await this.processPending(this.connection)
        return saved.secrets
      }
      const acceptance = await crypto.acceptRelayTransfer(identity, sender, payload, wrappedKey, input.projectId, async (opened) => {
        if (saved) return
        await this.saveReceived([...this.received, receivedTransfer(incoming, opened, input.projectId)])
      })
      const current = this.received.find((item) => item.messageId === input.messageId)
      if (!current) throw new Error('Cannot find the saved relay receipt. Retry the same transfer and destination.')
      await this.saveReceived(this.received.map((item) => item.messageId === input.messageId ? {
        ...item,
        receivedAt: acceptance.receivedAt,
        secrets: acceptance.secrets,
        receipt: acceptance.receipt.toString('base64'),
        complete: true,
        error: null
      } : item))
      if (this.connection && this.status === 'connected') await this.processPending(this.connection)
      this.changed()
      return acceptance.secrets
    })
  }

  requestPair(identity: unknown): Promise<void> {
    if (typeof identity !== 'string' || !/^[0-9a-f]{64}$/.test(identity)) {
      throw new Error('Enter the relay ID of the other device: 64 characters from 0 to 9 and a to f.')
    }
    return this.requireConnection().reducers.requestPair({ peer: Identity.fromString(identity) })
  }

  // The user confirms the code on the screen. A different current code means that the keys changed after display.
  confirmPair(input: unknown): Promise<void> {
    return this.serialize(async () => {
      this.requireWriter()
      const { pairId, code } = requireConfirmation(input)
      const peer = this.requirePeer(pairId)
      const current = describePeer(peer, await this.deviceCard(), this.cache.identity, this.pins)
      if (!current.code || current.code !== code) throw new Error('The pairing code changed. Compare the new code on both devices.')
      if (!current.requestedByMe && peer.status === 'Pending') {
        await this.requireConnection().reducers.confirmPair({ pairId: BigInt(pairId) })
      }
      await this.savePins([...this.pins.filter((pin) => pin.identity !== peer.identity),
        { identity: peer.identity, encryptionKey: peer.encryptionPublicKey, signingKey: peer.signingPublicKey }])
    })
  }

  removePair(pairId: unknown): Promise<void> {
    return this.serialize(async () => {
      this.requireWriter()
      const peer = this.requirePeer(requirePairId(pairId))
      await this.requireConnection().reducers.removePair({ pairId: BigInt(peer.pairId) })
      await this.savePins(this.pins.filter((pin) => pin.identity !== peer.identity))
    })
  }

  private async connect(): Promise<void> {
    const server = requireServer(this.server)
    this.update('connecting')
    let token: string | undefined
    try {
      token = await this.readToken()
    } catch (error) {
      return this.lost(error, undefined)
    }
    // Automatic reconnects replay the subscription. A new connection starts after the library stops retrying.
    this.connection = DbConnection.builder()
      .withUri(server.uri)
      .withDatabaseName(server.database)
      .withToken(token)
      .withAutomaticReconnect()
      .onConnect((connection, identity, newToken) => {
        this.watch(connection)
        void this.connected(connection, identity, newToken, token)
      })
      .onAutomaticReconnect(() => {
        this.attempt = 0
        this.error = null
        this.update('connected')
        // A relay data reset deletes the device row, so each reconnect registers this device again.
        if (this.connection) void this.register(this.connection)
      })
      .onConnectError((_context, error, nextAttempt) => this.lost(error, nextAttempt))
      .onDisconnect((_context, error, nextAttempt) => this.lost(error, nextAttempt))
      .build()
  }

  private async connected(connection: DbConnection, identity: Identity, token: string, savedToken: string | undefined): Promise<void> {
    this.attempt = 0
    this.error = null
    this.cache = { ...this.cache, identity: identity.toHexString() }
    this.update('connected')
    if (this.writer && token !== savedToken) {
      const bytes = Buffer.from(token)
      try {
        await this.vault.writeInternal(this.tokenName(), bytes)
      } catch (error) {
        this.error = `Cannot save the relay token. This device gets a new relay identity at the next start. ${message(error)}`
        this.changed()
      } finally {
        bytes.fill(0)
      }
    }
    await this.register(connection)
  }

  private async register(connection: DbConnection): Promise<void> {
    try {
      const card = await this.deviceCard()
      await connection.reducers.registerDevice({
        name: card.name,
        encryptionPublicKey: Buffer.from(card.encryptionKey, 'base64'),
        signingPublicKey: Buffer.from(card.signingKey, 'base64')
      })
      this.registered = true
      void this.serialize(() => this.processPending(connection))
      void this.importRequests()
    } catch (error) {
      this.registered = false
      this.error = `Cannot register this device on the relay. ${message(error)}`
    }
    this.changed()
  }

  private watch(connection: DbConnection): void {
    const refresh = () => this.refresh(connection)
    for (const view of [connection.db.myInbox, connection.db.mySent, connection.db.myPeers, connection.db.myExpiryNotices]) {
      view.onInsert(refresh)
      view.onDelete(refresh)
    }
    connection.subscriptionBuilder()
      .onApplied(refresh)
      .onError((context) => {
        this.error = `Cannot read the relay. ${message(context.event)}`
        this.changed()
      })
      .subscribe(['SELECT * FROM my_inbox', 'SELECT * FROM my_sent', 'SELECT * FROM my_peers', 'SELECT * FROM my_expiry_notices'])
  }

  private refresh(connection: DbConnection): void {
    this.cache = {
      identity: this.cache.identity,
      updatedAt: new Date().toISOString(),
      peers: [...connection.db.myPeers.iter()].map((row) => ({
        pairId: row.pairId.toString(),
        identity: row.identity.toHexString(),
        initiator: row.initiator.toHexString(),
        name: row.name,
        status: row.status.tag,
        encryptionPublicKey: Buffer.from(row.encryptionPublicKey).toString('base64'),
        signingPublicKey: Buffer.from(row.signingPublicKey).toString('base64')
      })),
      inbox: [...connection.db.myInbox.iter()].map((row) => ({
        messageId: row.messageId,
        sender: row.sender.toHexString(),
        createdAt: row.createdAt.toISOString(),
        deliverBy: row.deliverBy.toISOString(),
        payload: Buffer.from(row.payload).toString('base64'),
        wrappedKey: Buffer.from(row.wrappedKey).toString('base64')
      })),
      sent: [...connection.db.mySent.iter()].map((row) => ({
        messageId: row.messageId,
        recipient: row.recipient.toHexString(),
        status: row.status.tag,
        deliverBy: row.deliverBy.toISOString(),
        receivedAt: row.receivedAt?.toISOString() ?? null,
        receipt: row.receipt ? Buffer.from(row.receipt).toString('base64') : null
      })),
      expiryNotices: [...connection.db.myExpiryNotices.iter()].map((row) => ({
        id: row.id,
        correlationId: row.correlationId,
        sender: row.sender.toHexString(),
        notice: Buffer.from(row.notice).toString('base64'),
        createdAt: row.createdAt.toISOString(),
        retainUntil: row.retainUntil.toISOString()
      }))
    }
    if (this.writer) {
      this.saving = this.saving.then(() => this.writeSealed('cache', this.cache)).catch((error: unknown) => {
        this.error = `Cannot save the relay cache. ${message(error)}`
      })
    }
    this.changed()
    void this.serialize(() => this.processPending(connection))
  }

  private lost(error: unknown, nextAttempt: number | undefined): void {
    this.error = `The relay is unavailable. ${message(error)}`
    this.update('offline')
    if (nextAttempt !== undefined || this.stopped) return
    this.connection = undefined
    this.attempt += 1
    this.retry = setTimeout(() => void this.connect(), Math.min(1000 * 2 ** (this.attempt - 1), 30_000))
  }

  private update(connection: RelayConnection): void {
    this.status = connection
    this.changed()
  }

  private requireWriter(): RelayWriter {
    if (!this.writer) throw new Error('Open the global.sct app to change relay data. An agent session can only read it.')
    return this.writer
  }

  private async deviceCard(): Promise<DeviceCard> {
    return (await this.crypto()).deviceCard()
  }

  private requireConnection(): DbConnection {
    if (this.status !== 'connected' || !this.connection) throw new Error('Connect to the relay first. Check your network connection and try again.')
    return this.connection
  }

  private requirePeer(pairId: string): CachedPeer {
    const peer = this.cache.peers.find((saved) => saved.pairId === pairId)
    if (!peer) throw new Error('This pair does not exist. Refresh the list and try again.')
    return peer
  }

  private async savePins(pins: Pin[]): Promise<void> {
    await this.writeSealed('peers', { pins })
    this.pins = pins
    this.changed()
  }

  private async activity(): Promise<{ inbox: RelayInboxItem[]; sent: RelaySentItem[]; tasks: RelayTaskItem[] }> {
    const [inbox, sent, tasks] = await Promise.all([this.inboxItems(), this.sentItems(), this.taskItems()])
    return { inbox, sent, tasks }
  }

  private async sentItems(now = Date.now()): Promise<RelaySentItem[]> {
    const remote = new Map(this.cache.sent.map((item) => [`${item.messageId}/${item.recipient}`, item]))
    const notices = new Map(this.cache.expiryNotices.map((item) => [`${item.correlationId}/${item.sender}`, item]))
    // Tasks and results use the same relay rows. The task list shows them.
    for (const item of this.outbox.filter((saved) => saved.kind !== 'transfer')) remote.delete(`${item.messageId}/${item.recipient}`)
    const items = await Promise.all(this.outbox.filter((item) => item.kind === 'transfer').map(async (item): Promise<RelaySentItem> => {
      const sent = remote.get(`${item.messageId}/${item.recipient}`)
      remote.delete(`${item.messageId}/${item.recipient}`)
      const notice = notices.get(`${item.messageId}/${item.recipient}`)
      notices.delete(`${item.messageId}/${item.recipient}`)
      const verified = sent?.status === 'Received' ? await this.verifyReceipt(item, sent) : undefined
      const expiry = notice ? await this.expiryResult(item.messageId, item.recipient, notice) : undefined
      const state = deliveryState(item, sent, verified?.error ?? null, now)
      return {
        messageId: item.messageId,
        recipient: item.recipient,
        state,
        createdAt: new Date(item.createdAt).toISOString(),
        deliverBy: new Date(item.deliverBy).toISOString(),
        receivedAt: sent?.receivedAt ?? null,
        accessExpiresAt: item.accessExpiresAt === null ? null : new Date(item.accessExpiresAt).toISOString(),
        accessExpiredAt: expiry?.expiredAt ?? null,
        error: verified?.error ?? expiry?.error ?? item.error,
        receiptState: relayReceiptState(state, verified?.error ?? expiry?.error ?? item.error, verified?.receipt ?? null)
      }
    }))
    for (const sent of remote.values()) {
      const state: RelayDeliveryState = sent.status === 'Received' ? 'failed' : 'sent'
      const error = sent.status === 'Received' ? 'The local transfer is unavailable, so global.sct cannot verify its receipt.' : null
      items.push({
        messageId: sent.messageId,
        recipient: sent.recipient,
        state,
        createdAt: null,
        deliverBy: sent.deliverBy,
        receivedAt: sent.receivedAt,
        accessExpiresAt: null,
        accessExpiredAt: null,
        error,
        receiptState: relayReceiptState(state, error, null)
      })
    }
    items.push(...await Promise.all([...notices.values()].map(async (notice): Promise<RelaySentItem> => {
      const expiry = await this.expiryResult(notice.correlationId, notice.sender, notice)
      const state: RelayDeliveryState = expiry.error ? 'failed' : 'received'
      return {
        messageId: notice.correlationId,
        recipient: notice.sender,
        state,
        createdAt: null,
        deliverBy: null,
        receivedAt: null,
        accessExpiresAt: null,
        accessExpiredAt: expiry.expiredAt,
        error: expiry.error,
        receiptState: relayReceiptState(state, expiry.error ?? 'The local transfer is unavailable, so global.sct cannot verify its receipt.', null)
      }
    })))
    return items.sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''))
  }

  private async inboxItems(): Promise<RelayInboxItem[]> {
    const transfers = this.cache.inbox.filter((incoming) => !['task', 'result'].includes(messageKind(incoming.payload) ?? 'transfer'))
    const items = await Promise.all(transfers.map(async (incoming): Promise<RelayInboxItem> => {
      const saved = this.received.find((item) => item.messageId === incoming.messageId)
      if (saved) return describeReceived(saved)
      try {
        const identity = this.cache.identity
        if (!identity) throw new Error('The relay identity is unavailable.')
        const preview = await (await this.crypto()).previewRelayTransfer(identity, await this.verifiedPeer(incoming.sender),
          Buffer.from(incoming.payload, 'base64'), Buffer.from(incoming.wrappedKey, 'base64'))
        return describePreview(incoming, preview)
      } catch (error) {
        return {
          messageId: incoming.messageId,
          sender: incoming.sender,
          createdAt: incoming.createdAt,
          deliverBy: incoming.deliverBy,
          state: 'failed',
          projectName: null,
          secretNames: [],
          accessExpiresAt: null,
          injectionOnly: null,
          destinationProjectId: null,
          receivedAt: null,
          error: message(error)
        }
      }
    }))
    for (const saved of this.received) {
      if (!items.some((item) => item.messageId === saved.messageId)) items.push(describeReceived(saved))
    }
    return items.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  private async verifyReceipt(item: OutboundTransfer, sent: CachedSentItem): Promise<VerifiedReceipt> {
    try {
      if (!sent.receipt) throw new Error('The relay did not return an encrypted receipt.')
      const identity = this.cache.identity
      if (!identity) throw new Error('The relay identity is unavailable.')
      const receipt = await (await this.crypto()).verifyRelayReceipt(identity, await this.verifiedPeer(item.recipient),
        item.messageId, Buffer.from(sent.receipt, 'base64'))
      return { receipt, error: null }
    } catch (error) {
      return { receipt: null, error: message(error) }
    }
  }

  private async expiryResult(transferId: string, recipient: string,
    notice: CachedExpiryNotice): Promise<{ expiredAt: string | null; error: string | null }> {
    try {
      const identity = this.cache.identity
      if (!identity) throw new Error('The relay identity is unavailable.')
      return {
        expiredAt: new Date(await (await this.crypto()).verifyRelayExpiryNotice(identity, await this.verifiedPeer(recipient), transferId,
          Buffer.from(notice.notice, 'base64'))).toISOString(),
        error: null
      }
    } catch (error) {
      return { expiredAt: null, error: message(error) }
    }
  }

  private async processPending(connection: DbConnection): Promise<void> {
    if (!this.writer || connection !== this.connection || this.status !== 'connected') return
    await this.receiveMessages()
    await this.queueResults()
    const publications = await Promise.all(this.outbox.map((transfer) => this.publishPending(connection, transfer)))
    if (publications.some((result) => result.changed)) await this.writeSealed('outbox', { transfers: this.outbox })
    const acknowledgments = await Promise.all(this.received
      .filter((item) => item.complete && !item.acknowledged)
      .map((transfer) => this.sendPendingReceipt(connection, transfer)))
    if (acknowledgments.some((result) => result.changed)) await this.saveReceived(this.received)
    const taskReceipts = await Promise.all(this.tasks.filter((task) => !task.acknowledged)
      .map((task) => this.sendPendingReceipt(connection, task)))
    if (taskReceipts.some((result) => result.changed)) await this.saveTasks(this.tasks)
    const resultReceipts = await Promise.all(this.results.filter((result) => !result.acknowledged)
      .map((result) => this.sendPendingReceipt(connection, result)))
    if (resultReceipts.some((result) => result.changed)) await this.saveResults(this.results)
    const notices = await Promise.all(this.notices.filter((notice) => !notice.published)
      .map((notice) => this.publishExpiryNotice(connection, notice)))
    if (notices.some((result) => result.changed)) await this.writeSealed('notices', { notices: this.notices })
    if ([...publications, ...acknowledgments, ...taskReceipts, ...resultReceipts, ...notices].some((result) => result.failed)) {
      this.scheduleDelivery(connection)
    } else this.deliveryAttempt = 0
    this.changed()
  }

  // Tasks and results open without user action, because they contain no secret value. A task only waits for local approval.
  // The record is durable before the delivery receipt, so a duplicate delivery finds it and starts nothing.
  private async receiveMessages(): Promise<void> {
    const identity = this.cache.identity
    if (!identity) return
    const known = new Set([...this.tasks, ...this.results].map((item) => item.messageId))
    const opened = await Promise.all(this.cache.inbox.map(async (incoming): Promise<{ task: ReceivedTask } | { result: ReceivedResult } | null> => {
      const kind = messageKind(incoming.payload)
      if ((kind !== 'task' && kind !== 'result') || known.has(incoming.messageId)) return null
      try {
        const record = kind === 'task' ? { task: await this.openTask(identity, incoming) } : { result: await this.openResult(identity, incoming) }
        this.messageErrors.delete(incoming.messageId)
        return record
      } catch (error) {
        this.messageErrors.set(incoming.messageId, message(error))
        return null
      }
    }))
    const tasks = opened.flatMap((item): ReceivedTask[] => item && 'task' in item ? [item.task] : [])
    const arrived = opened.flatMap((item): ReceivedResult[] => item && 'result' in item ? [item.result] : [])
    // The first result of a task counts. A later result stays visible with an error.
    const results = arrived.map((result, index) => [...this.results, ...arrived.slice(0, index)].some((saved) => saved.taskId === result.taskId)
      ? { ...result, error: 'Another result for this task arrived first. global.sct shows the first result.' } : result)
    if (tasks.length) await this.saveTasks([...this.tasks, ...tasks])
    if (results.length) await this.saveResults([...this.results, ...results])
  }

  // A task without an imported grant from its sender, or after a deadline, gets its final state at arrival.
  private async openTask(identity: string, incoming: CachedInboxItem): Promise<ReceivedTask> {
    const [crypto, sender] = await Promise.all([this.crypto(), this.verifiedPeer(incoming.sender)])
    const receivedAt = Date.now()
    const opened = await crypto.openRelayMessage(identity, sender, 'task', Buffer.from(incoming.payload, 'base64'),
      Buffer.from(incoming.wrappedKey, 'base64'))
    const refusal = taskRefusal(this.received.find((item) => item.messageId === opened.contents.grantId),
      sender.identity, opened.contents.approveBy, receivedAt)
    return {
      messageId: incoming.messageId, digest: opened.digest, sender: sender.identity, createdAt: incoming.createdAt,
      deliverBy: opened.transfer.deliverBy, grantId: opened.contents.grantId, approveBy: opened.contents.approveBy,
      state: refusal?.state ?? 'awaiting-approval', exitCode: null, secretPresent: null,
      finishedAt: refusal ? receivedAt : null, reason: refusal?.reason ?? null, reviewed: false,
      receipt: (await crypto.sealRelayMessageReceipt(identity, sender, opened.transfer, receivedAt)).toString('base64'),
      acknowledged: false, error: null
    }
  }

  private async openResult(identity: string, incoming: CachedInboxItem): Promise<ReceivedResult> {
    const [crypto, sender] = await Promise.all([this.crypto(), this.verifiedPeer(incoming.sender)])
    const opened = await crypto.openRelayMessage(identity, sender, 'result', Buffer.from(incoming.payload, 'base64'),
      Buffer.from(incoming.wrappedKey, 'base64'))
    if (!this.outbox.some((item) => item.kind === 'task' && item.messageId === opened.contents.taskId && item.recipient === sender.identity)) {
      throw new Error('This result answers no task that this device sent to that device.')
    }
    return {
      messageId: incoming.messageId, digest: opened.digest, sender: sender.identity, deliverBy: opened.transfer.deliverBy,
      ...opened.contents,
      receipt: (await crypto.sealRelayMessageReceipt(identity, sender, opened.transfer, Date.now())).toString('base64'),
      acknowledged: false, error: null
    }
  }

  // Each outcome gets one result with one ID. Retries publish that same result.
  private async queueResults(now = Date.now()): Promise<void> {
    const identity = this.cache.identity
    if (!identity) return
    if (this.tasks.some((task) => task.state === 'awaiting-approval' && task.approveBy <= now)) {
      await this.saveTasks(this.tasks.map((task) => task.state === 'awaiting-approval' && task.approveBy <= now
        ? { ...task, state: 'expired', finishedAt: now, reason: 'The approval deadline passed.' } : task))
    }
    const crypto = await this.crypto()
    const queued = await Promise.all(this.tasks.filter((task): task is ReceivedTask & { state: RelayTaskOutcome } =>
      task.state !== 'awaiting-approval' && task.state !== 'claimed' &&
      (task.state !== 'uncertain' || task.reviewed) &&
      !this.outbox.some((item) => item.kind === 'result' && item.taskId === task.messageId)).map(async (task) => {
      try {
        const sender = await this.verifiedPeer(task.sender)
        const sealed = await crypto.prepareRelayMessage(identity, sender, 'result', {
          taskId: task.messageId, status: task.state, exitCode: task.exitCode, secretPresent: task.secretPresent, finishedAt: task.finishedAt ?? now
        }, Date.now() + deliveryLimit - clockSkew)
        return { task, entry: outbound(sealed, sender.identity,
          { kind: 'result', grantId: null, approveBy: null, taskId: task.messageId, accessExpiresAt: null }), error: null }
      } catch (error) {
        // The outcome stays saved. The next pending run queues the result again, for example after a repaired pairing.
        return { task, entry: null, error: `Cannot queue the result. ${message(error)}` }
      }
    }))
    const entries = queued.flatMap(({ entry }) => entry ? [entry] : [])
    if (entries.length) await this.saveOutbox([...this.outbox, ...entries])
    const errors = new Map(queued.map(({ task, error }) => [task.messageId, error]))
    if (this.tasks.some((task) => errors.has(task.messageId) && errors.get(task.messageId) !== task.error)) {
      await this.saveTasks(this.tasks.map((task) => errors.has(task.messageId) ? { ...task, error: errors.get(task.messageId) ?? null } : task))
    }
  }

  private async publishPending(connection: DbConnection, transfer: OutboundTransfer): Promise<PendingResult> {
    if (transfer.deliverBy <= Date.now() || this.cache.sent.some((item) =>
      item.messageId === transfer.messageId && item.recipient === transfer.recipient)) return pendingUnchanged
    try {
      await connection.reducers.publishSecret({
        id: transfer.messageId,
        payload: Buffer.from(transfer.payload, 'base64'),
        deliverBy: Timestamp.fromDate(new Date(transfer.deliverBy)),
        recipients: [{ recipient: Identity.fromString(transfer.recipient), wrappedKey: Buffer.from(transfer.wrappedKey, 'base64') }]
      })
      if (!transfer.error) return pendingUnchanged
      transfer.error = null
      return pendingChanged
    } catch (error) {
      transfer.error = `Cannot publish this transfer. ${message(error)}`
      return pendingFailed
    }
  }

  private async sendPendingReceipt(connection: DbConnection,
    transfer: Pick<ReceivedTransfer, 'messageId' | 'deliverBy' | 'receipt' | 'acknowledged' | 'error'>): Promise<PendingResult> {
    if (transfer.deliverBy <= Date.now()) {
      if (transfer.error === 'The delivery deadline passed before the receipt reached the relay.') return pendingUnchanged
      transfer.error = 'The delivery deadline passed before the receipt reached the relay.'
      return pendingChanged
    }
    try {
      if (!transfer.receipt) throw new Error('The saved receipt is missing.')
      await connection.reducers.acknowledge({ messageId: transfer.messageId, receipt: Buffer.from(transfer.receipt, 'base64') })
      transfer.acknowledged = true
      transfer.error = null
      return pendingChanged
    } catch (error) {
      transfer.error = `Cannot send this receipt. ${message(error)}`
      return pendingFailed
    }
  }

  private async publishExpiryNotice(connection: DbConnection, notice: OutboundExpiryNotice): Promise<PendingResult> {
    if (notice.publishBy <= Date.now()) {
      if (notice.error === 'The expiry notice deadline passed.') return pendingUnchanged
      notice.error = 'The expiry notice deadline passed.'
      return pendingChanged
    }
    try {
      await connection.reducers.publishExpiryNotice({
        id: notice.id,
        correlationId: notice.correlationId,
        recipient: Identity.fromString(notice.recipient),
        notice: Buffer.from(notice.notice, 'base64')
      })
      notice.published = true
      notice.error = null
      return pendingChanged
    } catch (error) {
      notice.error = `Cannot publish this expiry notice. ${message(error)}`
      return pendingFailed
    }
  }

  private scheduleDelivery(connection: DbConnection): void {
    clearTimeout(this.deliveryRetry)
    this.deliveryAttempt += 1
    this.deliveryRetry = setTimeout(() => {
      void this.serialize(() => this.processPending(connection))
    }, Math.min(1000 * 2 ** (this.deliveryAttempt - 1), 30_000))
  }

  private async verifiedPeer(identity: string): Promise<RelayPeerKeys> {
    const peer = this.cache.peers.find((saved) => saved.identity === identity)
    if (!peer || peer.status !== 'Verified' || describePeer(peer, await this.deviceCard(), this.cache.identity, this.pins).trust !== 'verified') {
      throw new Error('The other device is not a verified relay peer.')
    }
    const card = peerCard(peer)
    if (!card) throw new Error('The other device has invalid public keys.')
    return { identity, card }
  }

  private async saveReceived(transfers: ReceivedTransfer[]): Promise<void> {
    await this.writeSealed('received', { transfers })
    this.received = transfers
  }

  private async saveOutbox(transfers: OutboundTransfer[]): Promise<void> {
    await this.writeSealed('outbox', { transfers })
    this.outbox = transfers
  }

  private async saveTasks(tasks: ReceivedTask[]): Promise<void> {
    await this.writeSealed('tasks', { tasks })
    this.tasks = tasks
  }

  private async saveResults(results: ReceivedResult[]): Promise<void> {
    await this.writeSealed('results', { results })
    this.results = results
  }

  private async load(): Promise<void> {
    const [outbox, received, notices, tasks, results, pins, hidden, requests] = await Promise.all([
      this.readSealed<{ transfers: OutboundTransfer[] }>('outbox', { transfers: [] }),
      this.readSealed<{ transfers: ReceivedTransfer[] }>('received', { transfers: [] }),
      this.readSealed<{ notices: OutboundExpiryNotice[] }>('notices', { notices: [] }),
      this.readSealed<{ tasks: ReceivedTask[] }>('tasks', { tasks: [] }),
      this.readSealed<{ results: ReceivedResult[] }>('results', { results: [] }),
      // An unreadable list fails closed: every peer needs a new code comparison.
      this.readSealed<{ pins: Pin[] }>('peers', { pins: [] }),
      // An unreadable list shows every row again.
      this.readSealed<{ keys: string[] }>('hidden', { keys: [] }),
      this.readRequests()
    ])
    // Files from earlier versions contain transfers only.
    this.outbox = outbox.transfers.map((transfer) => ({ ...transfer, kind: transfer.kind ?? 'transfer', grantId: transfer.grantId ?? null,
      approveBy: transfer.approveBy ?? null, taskId: transfer.taskId ?? null,
      accessExpiresAt: transfer.accessExpiresAt ?? null, error: transfer.error ?? null }))
    this.received = received.transfers.map((transfer) => ({ ...transfer,
      acknowledged: transfer.acknowledged ?? false, error: transfer.error ?? null }))
    this.notices = notices.notices.map((notice) => ({ ...notice, published: notice.published ?? false, error: notice.error ?? null }))
    this.tasks = tasks.tasks
    this.results = results.results
    this.pins = pins.pins
    this.hidden = hidden.keys
    // The desktop app keeps the import error of each request. An agent session shows the request as queued.
    this.requests = requests.map((request) => ({ request, error: this.requests.find((item) => item.request.id === request.id)?.error ?? null }))
  }

  private async taskItems(now = Date.now()): Promise<RelayTaskItem[]> {
    const items = await Promise.all(this.outbox.filter((item) => item.kind === 'task').map(async (task): Promise<RelayTaskItem> => {
      const result = this.results.find((item) => item.taskId === task.messageId && item.sender === task.recipient)
      const sent = this.cache.sent.find((item) => item.messageId === task.messageId && item.recipient === task.recipient)
      const receiptError = sent?.status === 'Received' ? (await this.verifyReceipt(task, sent)).error : null
      const delivery = deliveryState(task, sent, receiptError, now)
      return {
        messageId: task.messageId, direction: 'sent', peer: task.recipient, grantId: task.grantId ?? '', digest: null,
        projectName: null, secretNames: [], createdAt: new Date(task.createdAt).toISOString(),
        approveBy: new Date(task.approveBy ?? task.deliverBy).toISOString(),
        state: result?.status ?? (delivery === 'received' ? 'delivered' : delivery),
        exitCode: result?.exitCode ?? null, secretPresent: result?.secretPresent ?? null,
        finishedAt: result ? new Date(result.finishedAt).toISOString() : null, reply: 'none', reviewRequired: false,
        error: result ? result.error : receiptError ?? task.error
      }
    }))
    for (const { request, error } of this.requests.filter(({ request }) => !this.outbox.some((item) => item.messageId === request.id))) {
      items.push({
        messageId: request.id, direction: 'sent', peer: this.outbox.find((item) => item.messageId === request.grantId)?.recipient ?? '',
        grantId: request.grantId, digest: null, projectName: null, secretNames: [], createdAt: new Date(request.createdAt).toISOString(),
        approveBy: new Date(request.approveBy).toISOString(), state: request.approveBy <= now ? 'expired' : error ? 'failed' : 'queued',
        exitCode: null, secretPresent: null, finishedAt: null, reply: 'none', reviewRequired: false, error
      })
    }
    items.push(...await Promise.all(this.tasks.map(async (task): Promise<RelayTaskItem> => {
      const grant = this.received.find((item) => item.messageId === task.grantId && item.sender === task.sender)
      const result = this.outbox.find((item) => item.kind === 'result' && item.taskId === task.messageId)
      const sent = result && this.cache.sent.find((item) => item.messageId === result.messageId && item.recipient === result.recipient)
      const receiptError = result && sent?.status === 'Received' ? (await this.verifyReceipt(result, sent)).error : null
      const expired = task.state === 'awaiting-approval' && task.approveBy <= now
      return {
        messageId: task.messageId, direction: 'received', peer: task.sender, grantId: task.grantId, digest: task.digest,
        projectName: grant?.projectName ?? null, secretNames: grant?.secretNames ?? [], createdAt: task.createdAt,
        approveBy: new Date(task.approveBy).toISOString(),
        state: task.state === 'claimed' ? 'running' : expired ? 'expired' : task.state,
        exitCode: task.exitCode, secretPresent: task.secretPresent,
        finishedAt: task.finishedAt === null ? null : new Date(task.finishedAt).toISOString(),
        reply: result ? deliveryState(result, sent, receiptError, now) : 'none',
        reviewRequired: task.state === 'uncertain' && !task.reviewed,
        error: receiptError ?? task.error ?? (expired ? 'The approval deadline passed.' : task.reason)
      }
    })))
    for (const incoming of this.cache.inbox) {
      const error = this.messageErrors.get(incoming.messageId)
      if (!error || messageKind(incoming.payload) !== 'task') continue
      items.push({
        messageId: incoming.messageId, direction: 'received', peer: incoming.sender, grantId: '', digest: null, projectName: null,
        secretNames: [], createdAt: incoming.createdAt, approveBy: incoming.deliverBy, state: 'failed', exitCode: null, secretPresent: null,
        finishedAt: null, reply: 'none', reviewRequired: false, error
      })
    }
    return items.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  private async readRequests(): Promise<TaskRequest[]> {
    let names: string[]
    try {
      names = await readdir(this.requestDirectory())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const key = await this.entry(`requests/${this.serverName()}`).getSecret()
    if (!key) return []
    const requests = await Promise.all(names.map(async (name): Promise<TaskRequest | null> => {
      const id = /^([0-9a-f-]{36})\.sct$/.exec(name)?.[1]
      if (!id) return null
      try {
        const sealed = decodeFile(magic, await readFile(join(this.requestDirectory(), name)))
        // The authenticated data contains the ID, so a renamed file does not open.
        const request: unknown = sealed && JSON.parse(open(Buffer.from(key), sealed, this.requestData(id)).toString('utf8'))
        return isTaskRequest(request) && request.id === id ? request : null
      } catch {
        // A file that does not open did not come from this app. It cannot start a task.
        return null
      }
    }))
    return requests.filter((request): request is TaskRequest => request !== null)
  }

  private requestDirectory(): string {
    return join(this.directory, `requests-${createHash('sha256').update(this.serverName()).digest('hex').slice(0, 16)}`)
  }

  private requestData(id: string): Buffer {
    return Buffer.from(`relay-request/${this.serverName()}/${id}`)
  }

  private async pruneRetained(now = Date.now()): Promise<void> {
    const outbox = this.outbox.filter((transfer) =>
      Math.max(transfer.deliverBy, transfer.accessExpiresAt ?? 0) + retentionPeriod > now)
    const notices = this.notices.filter((notice) => notice.createdAt + retentionPeriod > now)
    const received = this.received.filter((transfer) => transfer.deliverBy + retentionPeriod > now ||
      (transfer.accessExpiresAt !== null && (transfer.accessExpiresAt > now ||
        !notices.some((notice) => notice.correlationId === transfer.messageId && notice.published))))
    if (outbox.length !== this.outbox.length) {
      this.outbox = outbox
      await this.writeSealed('outbox', { transfers: outbox })
    }
    if (notices.length !== this.notices.length) {
      this.notices = notices
      await this.writeSealed('notices', { notices })
    }
    if (received.length !== this.received.length) await this.saveReceived(received)
    // An unreviewed uncertain run stays until the user reviews it.
    const tasks = this.tasks.filter((task) => task.deliverBy + retentionPeriod > now || (task.state === 'uncertain' && !task.reviewed))
    if (tasks.length !== this.tasks.length) await this.saveTasks(tasks)
    const results = this.results.filter((result) => result.deliverBy + retentionPeriod > now)
    if (results.length !== this.results.length) await this.saveResults(results)
    for (const { request } of this.requests.filter(({ request }) => request.createdAt + retentionPeriod <= now)) {
      await rm(join(this.requestDirectory(), `${request.id}.sct`), { force: true })
    }
    this.requests = this.requests.filter(({ request }) => request.createdAt + retentionPeriod > now)
  }

  private async readToken(): Promise<string | undefined> {
    const saved = await this.vault.readInternal(this.tokenName())
    if (saved === null) return undefined
    try { return saved.toString('utf8') } finally { saved.fill(0) }
  }

  // An unreadable file returns the empty value. The cache refills from the next subscription.
  private async readSealed<T>(name: SealedName, empty: T): Promise<T> {
    try {
      const sealed = decodeFile(magic, await readFile(this.sealedFile(name)))
      const key = await this.entry(`${name}/${this.serverName()}`).getSecret()
      if (!sealed || !key) return empty
      // GCM authenticates the contents, so only this app can produce them.
      return JSON.parse(open(Buffer.from(key), sealed, this.sealedData(name)).toString('utf8')) as T
    } catch {
      return empty
    }
  }

  private async writeSealed(name: SealedName, value: unknown): Promise<void> {
    const key = await this.sealedKey(name)
    const file = this.sealedFile(name)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    // The app and agent sessions share this folder, so each write uses its own temporary file.
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(temporary, encodeFile(magic, seal(key, Buffer.from(JSON.stringify(value)), this.sealedData(name))), { mode: 0o600 })
    await rename(temporary, file)
  }

  private async sealedKey(name: SealedName | 'requests'): Promise<Buffer> {
    const saved = await this.entry(`${name}/${this.serverName()}`).getSecret()
    if (saved) return Buffer.from(saved)
    const key = randomBytes(32)
    await this.entry(`${name}/${this.serverName()}`).setSecret(key)
    return key
  }

  // Each relay server has its own identity, so each server has its own files. A test server cannot replace the files of the live relay.
  private sealedFile(name: SealedName): string {
    return join(this.directory, `${name}-${createHash('sha256').update(this.serverName()).digest('hex').slice(0, 16)}.sct`)
  }

  private sealedData(name: SealedName): Buffer {
    return Buffer.from(`relay-${name}/${this.serverName()}`)
  }

  private serverName(): string {
    const server = requireServer(this.server)
    return `${server.uri}/${server.database}`
  }

  // The token name stays inside the internal-name grammar. The hash selects one token for each relay server.
  private tokenName(): string {
    return `relay/token/${createHash('sha256').update(this.serverName()).digest('hex')}`
  }

  private entry(account: string): AsyncEntry {
    return new AsyncEntry(this.service, account)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }
}

function outbound(sealed: SealedTransfer, recipient: string,
  fields: Pick<OutboundTransfer, 'kind' | 'grantId' | 'approveBy' | 'taskId' | 'accessExpiresAt'>): OutboundTransfer {
  const transfer = readTransfer(sealed.payload)
  const wrappedKey = sealed.wrappedKeys.find((entry) => entry.recipient === recipient)
  if (!wrappedKey) throw new Error('Cannot find the encrypted key for this recipient.')
  return {
    messageId: transfer.id,
    recipient,
    createdAt: transfer.createdAt,
    deliverBy: transfer.deliverBy,
    payload: sealed.payload.toString('base64'),
    wrappedKey: wrappedKey.wrappedKey.toString('base64'),
    error: null,
    ...fields
  }
}

// Reads the kind from the routing fields without decryption. An invalid payload returns null.
function messageKind(payload: string): RelayMessageKind | null {
  try {
    return readTransfer(Buffer.from(payload, 'base64')).kind
  } catch {
    return null
  }
}

function deliveryState(item: OutboundTransfer, sent: CachedSentItem | undefined, receiptError: string | null, now: number): RelayDeliveryState {
  return receiptError ? 'failed' : sent?.status === 'Received' ? 'received' : item.deliverBy <= now ? 'expired'
    : sent ? 'sent' : item.error ? 'failed' : 'queued'
}

// A task can use only an imported grant from its own sender, before the grant and approval deadlines.
function taskRefusal(grant: ReceivedTransfer | undefined, sender: string, approveBy: number,
  now: number): { state: 'refused' | 'expired'; reason: string } | null {
  if (!grant || !grant.complete || grant.sender !== sender) {
    return { state: 'refused', reason: 'This task names no imported grant from its sender.' }
  }
  if (grant.accessExpiresAt !== null && grant.accessExpiresAt <= now) return { state: 'expired', reason: 'The grant of this task expired.' }
  if (approveBy <= now) return { state: 'expired', reason: 'The approval deadline passed.' }
  return null
}

function requireTaskDecision(value: unknown): RelayTaskDecision {
  if (typeof value !== 'object' || value === null || !('messageId' in value) || !('digest' in value) || !('decision' in value) ||
    typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest) ||
    (value.decision !== 'approve' && value.decision !== 'refuse' && value.decision !== 'report')) {
    throw new Error('Select a task and a local decision.')
  }
  return { messageId: requireMessageId(value.messageId), digest: value.digest, decision: value.decision }
}

function requireMessageId(value: unknown): string {
  if (typeof value !== 'string' || !isMessageId(value)) throw new Error('The message ID is invalid.')
  return value
}

function isTaskRequest(value: unknown): value is TaskRequest {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' && isMessageId(value.id) &&
    'grantId' in value && typeof value.grantId === 'string' && isMessageId(value.grantId) &&
    'createdAt' in value && Number.isSafeInteger(value.createdAt) && 'approveBy' in value && Number.isSafeInteger(value.approveBy)
}

function normalizeCache(cache: Cache): Cache {
  return {
    ...cache,
    inbox: cache.inbox.map((item) => ({ ...item, deliverBy: item.deliverBy || transferDeadline(item.payload) })),
    sent: cache.sent.map((item) => ({ ...item, deliverBy: item.deliverBy || '', receipt: item.receipt ?? null })),
    expiryNotices: cache.expiryNotices ?? []
  }
}

function transferDeadline(payload: string): string {
  try {
    return new Date(readTransfer(Buffer.from(payload, 'base64')).deliverBy).toISOString()
  } catch {
    return new Date(0).toISOString()
  }
}

function describePeer(peer: CachedPeer, local: DeviceCard | undefined, localIdentity: string | null, pins: Pin[]): RelayPeer {
  const card = peerCard(peer)
  const pin = pins.find((saved) => saved.identity === peer.identity)
  return {
    pairId: peer.pairId,
    identity: peer.identity,
    name: peer.name,
    status: peer.status,
    requestedByMe: peer.initiator === localIdentity,
    code: card && local && localIdentity ? relayPairingCode(local, localIdentity, card, peer.identity) : null,
    trust: !card ? 'invalid' : !pin ? 'unverified'
      : pin.encryptionKey === card.encryptionKey && pin.signingKey === card.signingKey ? 'verified' : 'changed'
  }
}

// The relay accepts any key bytes. The device card rules accept only X25519 and Ed25519 public keys.
function peerCard(peer: CachedPeer): DeviceCard | undefined {
  try {
    return readDeviceCard(Buffer.from(JSON.stringify({ format: 'sct-device', version: 1, name: peer.name,
      encryptionKey: peer.encryptionPublicKey, signingKey: peer.signingPublicKey })))
  } catch {
    return undefined
  }
}

function activityRows({ inbox, sent, tasks }: { inbox: RelayInboxItem[]; sent: RelaySentItem[]; tasks: RelayTaskItem[] }) {
  return [...inbox.map(inboxRow), ...sent.map(sentRow), ...tasks.map(taskRow)]
}

function inboxRow(item: RelayInboxItem) {
  return activityRow({ kind: 'inbox', messageId: item.messageId, peer: item.sender }, item.state, relayInboxFinished(item))
}

function sentRow(item: RelaySentItem) {
  return activityRow({ kind: 'sent', messageId: item.messageId, peer: item.recipient }, item.state, relaySentFinished(item))
}

function taskRow(item: RelayTaskItem) {
  return activityRow({ kind: 'task', messageId: item.messageId, peer: item.peer },
    item.reviewRequired ? `${item.state}/review` : item.state, relayTaskFinished(item))
}

// The hidden key includes the row state, so a hidden row that changes state shows again.
function activityRow(activity: RelayActivityKey, state: string, finished: boolean) {
  const key = activityKey(activity)
  return { key, hiddenKey: `${key}#${state}`, finished }
}

function activityKey({ kind, messageId, peer }: RelayActivityKey): string {
  return `${kind}/${messageId}/${peer}`
}

// The caller checks that the key matches a finished row, so this check needs only the field types.
function requireActivityKey(input: unknown): RelayActivityKey {
  if (typeof input !== 'object' || input === null || !('kind' in input) || !('messageId' in input) || !('peer' in input) ||
    (input.kind !== 'inbox' && input.kind !== 'sent' && input.kind !== 'task') ||
    typeof input.messageId !== 'string' || typeof input.peer !== 'string') {
    throw new Error('Select a delivery activity row.')
  }
  return { kind: input.kind, messageId: input.messageId, peer: input.peer }
}

function requireConfirmation(input: unknown): { pairId: string; code: string } {
  if (typeof input !== 'object' || input === null || !('code' in input) || typeof input.code !== 'string' || !('pairId' in input)) {
    throw new Error('Select a pair and its pairing code.')
  }
  return { pairId: requirePairId(input.pairId), code: input.code }
}

function requirePairId(pairId: unknown): string {
  if (typeof pairId !== 'string' || !/^[0-9]{1,20}$/.test(pairId)) throw new Error('The pair ID is invalid.')
  return pairId
}

function requireQueueInput(value: unknown): RelayQueueInput {
  if (typeof value !== 'object' || value === null || !('projectId' in value) || typeof value.projectId !== 'string' ||
    !('secretIds' in value) || !Array.isArray(value.secretIds) || !value.secretIds.every((id) => typeof id === 'string') ||
    !('recipient' in value) || typeof value.recipient !== 'string' || !/^[0-9a-f]{64}$/.test(value.recipient) ||
    !('accessExpiresAt' in value) || (value.accessExpiresAt !== null && !Number.isSafeInteger(value.accessExpiresAt)) ||
    !('injectionOnly' in value) || typeof value.injectionOnly !== 'boolean') {
    throw new Error('Select a project, secrets, verified recipient, and a valid access deadline.')
  }
  return {
    projectId: value.projectId,
    secretIds: value.secretIds,
    recipient: value.recipient,
    accessExpiresAt: value.accessExpiresAt as number | null,
    injectionOnly: value.injectionOnly
  }
}

function requireAcceptInput(value: unknown): RelayAcceptInput {
  if (typeof value !== 'object' || value === null || !('messageId' in value) ||
    typeof value.messageId !== 'string' || !isMessageId(value.messageId) ||
    !('projectId' in value) || typeof value.projectId !== 'string' || !value.projectId) {
    throw new Error('Select a relay transfer and a destination project.')
  }
  return { messageId: value.messageId, projectId: value.projectId }
}

function receivedTransfer(incoming: CachedInboxItem, preview: RelayTransferPreview, projectId: string): ReceivedTransfer {
  return {
    messageId: preview.messageId,
    digest: preview.digest,
    sender: incoming.sender,
    createdAt: incoming.createdAt,
    deliverBy: preview.deliverBy,
    projectName: preview.projectName,
    secretNames: preview.secretNames,
    accessExpiresAt: preview.accessExpiresAt,
    injectionOnly: preview.injectionOnly,
    destinationProjectId: projectId,
    receivedAt: null,
    secrets: [],
    receipt: null,
    complete: false,
    acknowledged: false,
    error: null
  }
}

function requireSavedTransfer(saved: ReceivedTransfer | undefined, preview: RelayTransferPreview, projectId: string): void {
  if (saved && saved.digest !== preview.digest) throw new Error('A different transfer already uses this message ID. No secrets were imported.')
  if (saved && saved.destinationProjectId !== projectId) {
    throw new Error('This import already started in another project. Select its original destination.')
  }
}

function describePreview(incoming: CachedInboxItem, preview: RelayTransferPreview): RelayInboxItem {
  return {
    messageId: incoming.messageId,
    sender: incoming.sender,
    createdAt: incoming.createdAt,
    deliverBy: new Date(preview.deliverBy).toISOString(),
    state: 'pending',
    projectName: preview.projectName,
    secretNames: preview.secretNames,
    accessExpiresAt: preview.accessExpiresAt === null ? null : new Date(preview.accessExpiresAt).toISOString(),
    injectionOnly: preview.injectionOnly,
    destinationProjectId: null,
    receivedAt: null,
    error: null
  }
}

function describeReceived(saved: ReceivedTransfer): RelayInboxItem {
  return {
    messageId: saved.messageId,
    sender: saved.sender,
    createdAt: saved.createdAt,
    deliverBy: new Date(saved.deliverBy).toISOString(),
    state: saved.complete ? 'received' : saved.error ? 'failed' : 'pending',
    projectName: saved.projectName,
    secretNames: saved.secretNames,
    accessExpiresAt: saved.accessExpiresAt === null ? null : new Date(saved.accessExpiresAt).toISOString(),
    injectionOnly: saved.injectionOnly,
    destinationProjectId: saved.destinationProjectId,
    receivedAt: saved.receivedAt === null ? null : new Date(saved.receivedAt).toISOString(),
    error: saved.error
  }
}

function isMessageId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

function requireServer(server: RelayServer | undefined): RelayServer {
  if (!server) throw new Error('The relay is turned off.')
  return server
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error.'
}
