import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server'
import { ScheduleAt, Timestamp, type Identity } from 'spacetimedb'

// All tables are private. Clients read rows only through the views below.
// The relay never reads payload or wrappedKey. Issue #16 defines their contents.

const PairStatus = t.enum('PairStatus', { Pending: t.unit(), Verified: t.unit() })
const DeliveryStatus = t.enum('DeliveryStatus', { Pending: t.unit(), Received: t.unit() })
const deliveryLimitMicros = 7n * 24n * 60n * 60n * 1_000_000n
const retentionMicros = 30n * 24n * 60n * 60n * 1_000_000n
const maintenanceMicros = 60n * 1_000_000n
const noticeLimit = 65_536

const device = table(
  { name: 'device' },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    encryptionPublicKey: t.byteArray(),
    signingPublicKey: t.byteArray(),
    registeredAt: t.timestamp()
  }
)

const pair = table(
  {
    name: 'pair',
    indexes: [
      { accessor: 'byInitiatorPeer', algorithm: 'btree', columns: ['initiator', 'peer'] },
      { accessor: 'byPeerInitiator', algorithm: 'btree', columns: ['peer', 'initiator'] }
    ]
  },
  {
    id: t.u64().primaryKey().autoInc(),
    initiator: t.identity(),
    peer: t.identity(),
    status: PairStatus
  }
)

const message = table(
  { name: 'message' },
  {
    id: t.string().primaryKey(),
    sender: t.identity().index('btree'),
    payload: t.byteArray(),
    createdAt: t.timestamp(),
    deliverBy: t.timestamp()
  }
)

const delivery = table(
  {
    name: 'delivery',
    indexes: [
      { accessor: 'byMessageRecipient', algorithm: 'btree', columns: ['messageId', 'recipient'] },
      { accessor: 'byRecipientMessage', algorithm: 'btree', columns: ['recipient', 'messageId'] }
    ]
  },
  {
    id: t.u64().primaryKey().autoInc(),
    messageId: t.string(),
    recipient: t.identity(),
    wrappedKey: t.byteArray(),
    status: DeliveryStatus,
    receivedAt: t.option(t.timestamp())
  }
)

// The signed receipt of one delivery, encrypted for the sender. A separate table keeps the live delivery table unchanged.
const receipt = table(
  { name: 'receipt' },
  {
    deliveryId: t.u64().primaryKey(),
    receipt: t.byteArray()
  }
)

// A recipient encrypts and signs this notice for the original sender after local grant cleanup.
const expiryNotice = table(
  { name: 'expiry_notice' },
  {
    id: t.string().primaryKey(),
    correlationId: t.string().index('btree'),
    sender: t.identity().index('btree'),
    recipient: t.identity().index('btree'),
    notice: t.byteArray(),
    createdAt: t.timestamp(),
    retainUntil: t.timestamp()
  }
)

const maintenance = table(
  { name: 'maintenance' },
  {
    id: t.u64().primaryKey(),
    scheduledAt: t.scheduleAt()
  }
)

const spacetimedb = schema({ device, pair, message, delivery, receipt, expiryNotice, maintenance })
export default spacetimedb

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>

const RecipientKey = t.object('RecipientKey', { recipient: t.identity(), wrappedKey: t.byteArray() })

export const registerDevice = spacetimedb.reducer(
  { name: t.string(), encryptionPublicKey: t.byteArray(), signingPublicKey: t.byteArray() },
  (ctx, { name, encryptionPublicKey, signingPublicKey }) => {
    ensureMaintenance(ctx)
    if (!name.trim()) throw new SenderError('The device name is empty.')
    if (!encryptionPublicKey.length || !signingPublicKey.length) throw new SenderError('A device public key is empty.')
    const existing = ctx.db.device.identity.find(ctx.sender)
    if (!existing) {
      ctx.db.device.insert({ identity: ctx.sender, name, encryptionPublicKey, signingPublicKey, registeredAt: ctx.timestamp })
      return
    }
    // Paired devices trust the registered keys. A key change needs a new identity and a new pairing.
    if (!sameBytes(existing.encryptionPublicKey, encryptionPublicKey) || !sameBytes(existing.signingPublicKey, signingPublicKey)) {
      throw new SenderError('The device keys cannot change.')
    }
    ctx.db.device.identity.update({ ...existing, name })
  }
)

export const requestPair = spacetimedb.reducer({ peer: t.identity() }, (ctx, { peer }) => {
  requireDevice(ctx, ctx.sender)
  if (peer.equals(ctx.sender)) throw new SenderError('A device cannot pair with itself.')
  requireDevice(ctx, peer)
  if (findPair(ctx, ctx.sender, peer)) throw new SenderError('These devices already have a pair.')
  ctx.db.pair.insert({ id: 0n, initiator: ctx.sender, peer, status: { tag: 'Pending' } })
})

// Both users compare the pairing code in the app before the peer confirms.
export const confirmPair = spacetimedb.reducer({ pairId: t.u64() }, (ctx, { pairId }) => {
  const row = ctx.db.pair.id.find(pairId)
  if (!row || !row.peer.equals(ctx.sender)) throw new SenderError('No pair request exists for this device.')
  if (row.status.tag === 'Verified') return
  ctx.db.pair.id.update({ ...row, status: { tag: 'Verified' } })
})

// Either device can remove its pair, for example after the pairing codes differ. The devices can then pair again.
export const removePair = spacetimedb.reducer({ pairId: t.u64() }, (ctx, { pairId }) => {
  const row = ctx.db.pair.id.find(pairId)
  if (!row || (!row.initiator.equals(ctx.sender) && !row.peer.equals(ctx.sender))) throw new SenderError('No pair exists for this device.')
  ctx.db.pair.id.delete(pairId)
})

export const publishSecret = spacetimedb.reducer(
  { id: t.string(), payload: t.byteArray(), deliverBy: t.timestamp(), recipients: t.array(RecipientKey) },
  (ctx, { id, payload, deliverBy, recipients }) => {
    ensureMaintenance(ctx)
    requireDevice(ctx, ctx.sender)
    if (!id) throw new SenderError('The message ID is empty.')
    if (!payload.length) throw new SenderError('The message payload is empty.')
    const existing = ctx.db.message.id.find(id)
    if (existing) {
      requireSamePublication(ctx, existing, payload, deliverBy, recipients)
      return
    }
    const deliveryTime = deliverBy.microsSinceUnixEpoch - ctx.timestamp.microsSinceUnixEpoch
    if (deliveryTime <= 0n || deliveryTime > deliveryLimitMicros) {
      throw new SenderError('Set a delivery deadline within the next 7 days.')
    }
    requireRecipients(ctx, recipients)
    ctx.db.message.insert({ id, sender: ctx.sender, payload, createdAt: ctx.timestamp, deliverBy })
    for (const { recipient, wrappedKey } of recipients) {
      ctx.db.delivery.insert({ id: 0n, messageId: id, recipient, wrappedKey, status: { tag: 'Pending' }, receivedAt: undefined })
    }
  }
)

// The recipient app protects the secret locally before it calls this reducer.
// The relay stores the receipt without reading it. The sender checks its signature. A second call keeps the first receipt.
export const acknowledge = spacetimedb.reducer({ messageId: t.string(), receipt: t.byteArray() }, (ctx, { messageId, receipt }) => {
  const [row] = ctx.db.delivery.byMessageRecipient.filter([messageId, ctx.sender])
  if (!row) throw new SenderError('No delivery exists for this device.')
  if (!receipt.length) throw new SenderError('The receipt is empty.')
  if (row.status.tag === 'Received') return
  const sent = ctx.db.message.id.find(messageId)
  if (!sent || sent.deliverBy.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) {
    throw new SenderError('The delivery deadline passed.')
  }
  ctx.db.delivery.id.update({ ...row, status: { tag: 'Received' }, receivedAt: ctx.timestamp })
  ctx.db.receipt.insert({ deliveryId: row.id, receipt })
})

export const publishExpiryNotice = spacetimedb.reducer(
  { id: t.string(), correlationId: t.string(), recipient: t.identity(), notice: t.byteArray() },
  (ctx, { id, correlationId, recipient, notice }) => {
    ensureMaintenance(ctx)
    requireDevice(ctx, ctx.sender)
    requireDevice(ctx, recipient)
    if (!id) throw new SenderError('The expiry notice ID is empty.')
    if (!correlationId) throw new SenderError('The expiry notice correlation ID is empty.')
    if (!notice.length || notice.length > noticeLimit) throw new SenderError('The expiry notice has an invalid size.')
    if (findPair(ctx, ctx.sender, recipient)?.status.tag !== 'Verified') {
      throw new SenderError('The expiry notice recipient has no verified pair with this device.')
    }
    const existing = ctx.db.expiryNotice.id.find(id)
    if (existing) {
      if (existing.correlationId !== correlationId || !existing.sender.equals(ctx.sender) ||
        !existing.recipient.equals(recipient) || !sameBytes(existing.notice, notice)) {
        throw new SenderError('The expiry notice ID is already used by a different notice.')
      }
      return
    }
    ctx.db.expiryNotice.insert({ id, correlationId, sender: ctx.sender, recipient, notice, createdAt: ctx.timestamp,
      retainUntil: new Timestamp(ctx.timestamp.microsSinceUnixEpoch + retentionMicros) })
  }
)

export const maintainRelay = spacetimedb.reducer(
  { onSchedule: maintenance },
  { schedule: maintenance.rowType },
  (ctx) => {
    if (!ctx.sender.equals(ctx.databaseIdentity) || ctx.connectionId !== null) {
      throw new SenderError('Only the relay scheduler can run maintenance.')
    }
    for (const row of ctx.db.delivery.iter()) {
      const sent = ctx.db.message.id.find(row.messageId)
      if (row.status.tag === 'Pending' && (!sent || sent.deliverBy.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch)) {
        ctx.db.delivery.id.delete(row.id)
      }
    }
    for (const sent of ctx.db.message.iter()) {
      if (sent.deliverBy.microsSinceUnixEpoch + retentionMicros > ctx.timestamp.microsSinceUnixEpoch) continue
      for (const row of ctx.db.delivery.byMessageRecipient.filter(sent.id)) {
        ctx.db.receipt.deliveryId.delete(row.id)
        ctx.db.delivery.id.delete(row.id)
      }
      ctx.db.message.id.delete(sent.id)
    }
    for (const notice of ctx.db.expiryNotice.iter()) {
      if (notice.retainUntil.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) ctx.db.expiryNotice.id.delete(notice.id)
    }
  }
)

export const myInbox = spacetimedb.view(
  { name: 'my_inbox', public: true },
  t.array(t.object('InboxItem', {
    messageId: t.string(),
    sender: t.identity(),
    payload: t.byteArray(),
    wrappedKey: t.byteArray(),
    createdAt: t.timestamp(),
    deliverBy: t.timestamp()
  })),
  (ctx) => [...ctx.db.delivery.byRecipientMessage.filter(ctx.sender)]
    .filter((row) => row.status.tag === 'Pending')
    .flatMap((row) => {
      const sent = ctx.db.message.id.find(row.messageId)
      return sent
        ? [{ messageId: sent.id, sender: sent.sender, payload: sent.payload, wrappedKey: row.wrappedKey,
            createdAt: sent.createdAt, deliverBy: sent.deliverBy }]
        : []
    })
)

export const mySent = spacetimedb.view(
  { name: 'my_sent', public: true },
  t.array(t.object('SentItem', {
    messageId: t.string(),
    recipient: t.identity(),
    status: DeliveryStatus,
    deliverBy: t.timestamp(),
    receivedAt: t.option(t.timestamp()),
    receipt: t.option(t.byteArray())
  })),
  (ctx) => [...ctx.db.message.sender.filter(ctx.sender)].flatMap((sent) =>
    [...ctx.db.delivery.byMessageRecipient.filter(sent.id)].map((row) => ({
      messageId: sent.id,
      recipient: row.recipient,
      status: row.status,
      deliverBy: sent.deliverBy,
      receivedAt: row.receivedAt,
      receipt: ctx.db.receipt.deliveryId.find(row.id)?.receipt
    }))
  )
)

export const myExpiryNotices = spacetimedb.view(
  { name: 'my_expiry_notices', public: true },
  t.array(t.object('ExpiryNoticeItem', {
    id: t.string(),
    correlationId: t.string(),
    sender: t.identity(),
    notice: t.byteArray(),
    createdAt: t.timestamp(),
    retainUntil: t.timestamp()
  })),
  (ctx) => [...ctx.db.expiryNotice.recipient.filter(ctx.sender)].map((row) => ({
    id: row.id, correlationId: row.correlationId, sender: row.sender, notice: row.notice,
    createdAt: row.createdAt, retainUntil: row.retainUntil
  }))
)

export const myPeers = spacetimedb.view(
  { name: 'my_peers', public: true },
  t.array(t.object('PeerItem', {
    pairId: t.u64(),
    status: PairStatus,
    initiator: t.identity(),
    identity: t.identity(),
    name: t.string(),
    encryptionPublicKey: t.byteArray(),
    signingPublicKey: t.byteArray()
  })),
  (ctx) => [
    ...[...ctx.db.pair.byInitiatorPeer.filter(ctx.sender)].map((row) => ({ row, other: row.peer })),
    ...[...ctx.db.pair.byPeerInitiator.filter(ctx.sender)].map((row) => ({ row, other: row.initiator }))
  ].flatMap(({ row, other }) => {
    const peer = ctx.db.device.identity.find(other)
    return peer
      ? [{
          pairId: row.id,
          status: row.status,
          initiator: row.initiator,
          identity: peer.identity,
          name: peer.name,
          encryptionPublicKey: peer.encryptionPublicKey,
          signingPublicKey: peer.signingPublicKey
        }]
      : []
  })
)

function requireDevice(ctx: Ctx, identity: Identity) {
  if (!ctx.db.device.identity.find(identity)) throw new SenderError('The device is not registered.')
}

function findPair(ctx: Ctx, first: Identity, second: Identity) {
  const [row] = [...ctx.db.pair.byInitiatorPeer.filter([first, second]), ...ctx.db.pair.byInitiatorPeer.filter([second, first])]
  return row
}

function requireRecipients(ctx: Ctx, recipients: { recipient: Identity; wrappedKey: Uint8Array }[]) {
  if (!recipients.length) throw new SenderError('The message has no recipients.')
  const seen = new Set<string>()
  for (const { recipient, wrappedKey } of recipients) {
    const key = recipient.toHexString()
    if (seen.has(key)) throw new SenderError('A recipient occurs more than one time.')
    seen.add(key)
    if (!wrappedKey.length) throw new SenderError('A wrapped key is empty.')
    if (findPair(ctx, ctx.sender, recipient)?.status.tag !== 'Verified') {
      throw new SenderError('A recipient has no verified pair with this device.')
    }
  }
}

function requireSamePublication(ctx: Ctx, existing: { id: string; sender: Identity; payload: Uint8Array; deliverBy: Timestamp },
  payload: Uint8Array, deliverBy: Timestamp,
  recipients: { recipient: Identity; wrappedKey: Uint8Array }[]) {
  const saved = [...ctx.db.delivery.byMessageRecipient.filter(existing.id)]
  const sameRecipients = saved.length === recipients.length && recipients.every((recipient) => saved.some((delivery) =>
    delivery.recipient.equals(recipient.recipient) && sameBytes(delivery.wrappedKey, recipient.wrappedKey)))
  if (!existing.sender.equals(ctx.sender) || !sameBytes(existing.payload, payload) ||
    existing.deliverBy.microsSinceUnixEpoch !== deliverBy.microsSinceUnixEpoch || !sameRecipients) {
    throw new SenderError('The message ID is already used by a different publication.')
  }
}

function ensureMaintenance(ctx: Ctx) {
  if (ctx.db.maintenance.id.find(1n)) return
  ctx.db.maintenance.insert({ id: 1n, scheduledAt: ScheduleAt.interval(maintenanceMicros) })
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}
