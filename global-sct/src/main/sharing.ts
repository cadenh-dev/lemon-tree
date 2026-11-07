import { createHash, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, sign, verify } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { createIdentity, decodeIdentity, decryptTransfer, describeDevice, encodeIdentity, encryptTransfer, exportPublic,
  pairingCode, publicKey, readDeviceCard, readEnvelope, readObject, readPairingLink, transferLimit } from './transfer'
import type { DeviceCard, DeviceIdentity, TransferEnvelope } from './transfer'
import { openExpiryNotice, openMessage, openTransfer as openRelayEnvelope, readTransfer, sealExpiryNotice, sealMessage, sealReceipt,
  sealTransfer, verifyTransferReceipt } from './envelope'
import { open as openSealed, seal as sealData } from './seal'
import type { OpenedMessage, RelayPeerKeys, RelaySelf, SealedTransfer } from './envelope'
import type { RelayMessageContents, RelayTransfer } from '../shared/envelope'
import type { Vault } from './vault'
import type { RelayTransferInput } from '../shared/relay'
import { linkLimit } from '../shared/transport'
import type { DeliveryMode, EnvelopeTransferInput, TransferReceipt } from '../shared/transport'
import { connectContents, connectOuter } from '../shared/connect'
import type { ConnectContents } from '../shared/connect'
import type { ShareSummary } from '../shared/share'
import { decodeConnectLink } from './connect-link'
import type { LinkImportResult, LinkPreview, LinkRecord, LinkSendInput, LinkState } from '../shared/transport'
import { decodeReceiptLink, decodeTransferLink, encodeReceiptLink, encodeTransferLink, readLinkRecords } from './transport-link'
import type { PairingPreview, SharingDevice, SharingState, TransferPreview } from '../shared/sharing'
import type { SecretMetadata } from '../shared/secrets'

interface Receipt {
  id: string
  digest: string
  projectId: string
  complete: boolean
  // A completed import keeps its signed receipt, so a duplicate can return the same bytes after a restart.
  receivedAt?: number
  secretCount?: number
  receipt?: string
}

export interface RelayTransferPreview {
  messageId: string
  digest: string
  projectName: string
  secretNames: string[]
  deliverBy: number
  accessExpiresAt: number | null
  injectionOnly: boolean
}

export interface RelayTransferAcceptance extends RelayTransferPreview {
  secrets: SecretMetadata[]
  receivedAt: number
  receipt: Buffer
}

export class Sharing {
  private pending: Promise<void> = Promise.resolve()
  private identity: Promise<DeviceIdentity> | undefined
  private pairing: { token: string; card: DeviceCard } | undefined

  constructor(private readonly root: string, private readonly vault: Vault, private readonly name: string) {}

  state(): Promise<SharingState> {
    return this.serialize(async () => {
      const [identity, peers, receipts] = await Promise.all([this.getIdentity(), this.readPeers(), this.readReceipts()])
      const incoming: TransferPreview[] = []
      for (const name of await this.incomingFiles()) {
        const envelope = readEnvelope(await readLimited(join(this.root, 'inbox', name)))
        if (envelope.expiresAt <= Date.now() || receipts.some((receipt) => receipt.id === envelope.id && receipt.complete)) {
          await rm(join(this.root, 'inbox', name))
        } else {
          incoming.push(this.preview(identity, peers, envelope))
        }
      }
      return { device: describeDevice(identity.card), peers: peers.map(describeDevice), incoming }
    })
  }

  // The relay registers the same public keys as the AirDrop device card.
  async deviceCard(): Promise<DeviceCard> {
    return (await this.getIdentity()).card
  }

  async directDevice(): Promise<{ id: string; card: DeviceCard }> {
    const card = await this.deviceCard()
    return { id: describeDevice(card).id, card }
  }

  async directPeers(): Promise<SharingDevice[]> {
    return (await this.readPeers()).map(describeDevice)
  }

  async directPeer(peerId: unknown): Promise<SharingDevice | null> {
    const peers = await this.readPeers()
    const peer = peers.find((card) => describeDevice(card).id === peerId)
    return peer ? describeDevice(peer) : null
  }

  // Link and Direct use the same verified peer cards. The day rotates the discovery topic at UTC midnight.
  async directTopic(peerId: unknown, day: string): Promise<Buffer> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('The Direct topic day is invalid.')
    const identity = await this.getIdentity()
    const peer = requirePeer(await this.readPeers(), peerId)
    const shared = diffieHellman({ privateKey: identity.encryptionKey, publicKey: publicKey(peer.encryptionKey, 'x25519') })
    try {
      return Buffer.from(hkdfSync('sha256', shared, Buffer.from('sct-direct-topic-v1'), Buffer.from(day, 'utf8'), 32))
    } finally {
      shared.fill(0)
    }
  }

  async directSign(message: Buffer): Promise<Buffer> {
    return sign(null, message, (await this.getIdentity()).signingKey)
  }

  async directVerify(peerId: unknown, message: Buffer, signature: Buffer): Promise<boolean> {
    const peer = (await this.readPeers()).find((card) => describeDevice(card).id === peerId)
    return peer ? verify(null, message, publicKey(peer.signingKey, 'ed25519'), signature) : false
  }

  connectSeal(peerId: unknown, contents: ConnectContents,
    options: { sessionId?: string; now?: number; createdAt?: number; expiresAt?: number } = {}):
    Promise<{ link: string; sessionId: string; createdAt: number; expiresAt: number; digest: string }> {
    return this.serialize(async () => {
      const content = connectContents.parse(contents)
      if (content.kind === 'answer' && !content.offerDigest) throw new Error('The WebRTC answer has no offer digest.')
      if (content.kind === 'answer' && (!options.sessionId || options.createdAt === undefined || options.expiresAt === undefined)) {
        throw new Error('The WebRTC answer has no offer session.')
      }
      if (content.kind === 'offer' && content.offerDigest) throw new Error('The WebRTC offer has an answer digest.')
      const self = await this.getIdentity()
      const senderId = describeDevice(self.card).id
      const peer = requirePeer(await this.readPeers(), peerId, 'Verify the WebRTC peer before you connect.')
      const recipientId = describeDevice(peer).id
      const sessionId = content.kind === 'offer' ? randomUUID() : z.uuidv4().parse(options.sessionId)
      const now = options.now ?? Date.now()
      const createdAt = content.kind === 'offer' ? now : z.number().int().nonnegative().parse(options.createdAt)
      const expiresAt = content.kind === 'offer' ? now + 5 * 60 * 1000 : z.number().int().nonnegative().parse(options.expiresAt)
      if (expiresAt <= now) throw new Error('The WebRTC offer expired before the answer. Create a new offer.')
      const ephemeral = generateKeyPairSync('x25519')
      const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKey(peer.encryptionKey, 'x25519') })
      const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(sessionId), Buffer.from(`sct-connect-v1/${senderId}/${recipientId}`), 32))
      const ephemeralKey = exportPublic(ephemeral.publicKey)
      try {
        const rawIv = randomBytes(12)
        const iv = rawIv.toString('base64')
        const aad = connectAad({ format: 'sct-connect', version: 1, sessionId, senderId, recipientId, createdAt, expiresAt, ephemeralKey, iv })
        const sealed = sealData(key, Buffer.from(JSON.stringify(content)), aad, rawIv)
        const signature = sign(null, Buffer.concat([aad, sealed.tag, sealed.ciphertext]), self.signingKey).toString('base64')
        const outer = { format: 'sct-connect' as const, version: 1 as const, sessionId, senderId, recipientId, createdAt, expiresAt,
          ephemeralKey, iv, tag: sealed.tag.toString('base64'), ciphertext: sealed.ciphertext.toString('base64'), signature }
        const bytes = Buffer.from(JSON.stringify(outer))
        const link = `global-sct://connect/v1/${bytes.toString('base64url')}`
        if (link.length > linkLimit) throw new Error('The WebRTC connection link is too large.')
        return { link, sessionId, createdAt, expiresAt, digest: createHash('sha256').update(bytes).digest('hex') }
      } finally {
        key.fill(0)
        shared.fill(0)
      }
    })
  }

  connectOpen(link: unknown, now = Date.now()): Promise<{ senderId: string; sessionId: string; createdAt: number; expiresAt: number; contents: ConnectContents; digest: string }> {
    return this.serialize(async () => {
      const decoded = decodeConnectLink(link)
      const outer = connectOuter.parse(decoded.outer)
      const self = await this.getIdentity()
      const selfId = describeDevice(self.card).id
      if (outer.recipientId !== selfId) throw new Error('This WebRTC link belongs to another device.')
      if (outer.createdAt > now + 60_000 || outer.expiresAt <= now || outer.expiresAt - outer.createdAt > 5 * 60 * 1000) {
        throw new Error('This WebRTC link expired or has invalid times.')
      }
      const peer = (await this.readPeers()).find((card) => describeDevice(card).id === outer.senderId)
      if (!peer) throw new Error('The WebRTC sender is not a verified peer.')
      const aad = connectAad(outer)
      if (!verify(null, Buffer.concat([aad, Buffer.from(outer.tag, 'base64'), Buffer.from(outer.ciphertext, 'base64')]),
        publicKey(peer.signingKey, 'ed25519'), Buffer.from(outer.signature, 'base64'))) {
        throw new Error('The WebRTC link signature is invalid.')
      }
      const shared = diffieHellman({ privateKey: self.encryptionKey, publicKey: publicKey(outer.ephemeralKey, 'x25519') })
      const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(outer.sessionId), Buffer.from(`sct-connect-v1/${outer.senderId}/${outer.recipientId}`), 32))
      try {
        const plaintext = openSealed(key, { iv: Buffer.from(outer.iv, 'base64'), tag: Buffer.from(outer.tag, 'base64'),
          ciphertext: Buffer.from(outer.ciphertext, 'base64') }, aad)
        try {
          return { senderId: outer.senderId, sessionId: outer.sessionId, createdAt: outer.createdAt, expiresAt: outer.expiresAt,
            contents: connectContents.parse(JSON.parse(plaintext.toString('utf8'))), digest: decoded.digest }
        } finally {
          plaintext.fill(0)
        }
      } catch {
        throw new Error('Cannot open this WebRTC link.')
      } finally {
        key.fill(0)
        shared.fill(0)
      }
    })
  }

  async prepareRelayTransfer(identity: string, recipient: RelayPeerKeys, input: RelayTransferInput): Promise<SealedTransfer> {
    return this.sealSecrets({ identity, keys: await this.getIdentity() }, recipient, input)
  }

  async previewRelayTransfer(identity: string, sender: RelayPeerKeys, payload: Buffer, wrappedKey: Buffer): Promise<RelayTransferPreview> {
    const opened = openRelayEnvelope({ identity, keys: await this.getIdentity() }, sender, payload, wrappedKey)
    try {
      return relayPreview(opened)
    } finally {
      opened.contents.secrets.length = 0
    }
  }

  async acceptRelayTransfer(identity: string, sender: RelayPeerKeys, payload: Buffer, wrappedKey: Buffer,
    projectId: string, beforeWrite: (preview: RelayTransferPreview) => Promise<void>): Promise<RelayTransferAcceptance> {
    return this.acceptSealed({ identity, keys: await this.getIdentity() }, sender, payload, wrappedKey, projectId, 'relay', beforeWrite)
  }

  // Tasks and results contain no secret values, so the relay connection can read them directly.
  async prepareRelayMessage<K extends 'task' | 'result'>(identity: string, recipient: RelayPeerKeys, kind: K,
    contents: RelayMessageContents[K], deliverBy: number, id?: string): Promise<SealedTransfer> {
    return sealMessage({ identity, keys: await this.getIdentity() }, [recipient], kind, contents, deliverBy, Date.now(), id)
  }

  async openRelayMessage<K extends 'task' | 'result'>(identity: string, sender: RelayPeerKeys, kind: K,
    payload: Buffer, wrappedKey: Buffer): Promise<OpenedMessage<K>> {
    return openMessage({ identity, keys: await this.getIdentity() }, sender, kind, payload, wrappedKey)
  }

  // A delivery receipt of a task or result confirms storage only. It does not confirm approval or execution.
  async sealRelayMessageReceipt(identity: string, sender: RelayPeerKeys, message: RelayTransfer, receivedAt: number): Promise<Buffer> {
    return sealReceipt({ identity, keys: await this.getIdentity() }, sender, message, { status: 'received', receivedAt, secretCount: 0 }, receivedAt)
  }

  async verifyRelayReceipt(identity: string, recipient: RelayPeerKeys, transferId: string, receipt: Buffer): Promise<TransferReceipt> {
    return verifyTransferReceipt({ identity, keys: await this.getIdentity() }, recipient, transferId, receipt, 'mailbox')
  }

  async prepareRelayExpiryNotice(identity: string, sender: RelayPeerKeys, transferId: string,
    expiredAt: number, secretCount: number): Promise<Buffer> {
    return sealExpiryNotice({ identity, keys: await this.getIdentity() }, sender, transferId,
      { status: 'expired', expiredAt, secretCount })
  }

  async verifyRelayExpiryNotice(identity: string, recipient: RelayPeerKeys, transferId: string,
    notice: Buffer): Promise<number> {
    return openExpiryNotice({ identity, keys: await this.getIdentity() }, recipient, transferId, notice).expiredAt
  }

  // Link and Direct modes use the relay envelope without the relay. The device ID is the envelope identity,
  // and the verified peers in peers.json are the only accepted senders and recipients.
  prepareEnvelope(input: EnvelopeTransferInput): Promise<SealedTransfer & Pick<LinkRecord, 'projectName' | 'secretNames'>> {
    return this.serialize(async () => {
      const self = await this.deviceSelf()
      const recipient = deviceKeys(requirePeer(await this.readPeers(), input.recipientId, 'Verify the recipient device before sharing secrets.'))
      return this.vault.withSelectedSecrets(input.projectId, input.secretIds, async (project, secrets) => ({ ...sealTransfer(
        self,
        [recipient],
        {
          projectName: project.name,
          secrets: secrets.map(({ name, value }) => ({ name, value: value.toString('utf8') })),
          grant: { accessExpiresAt: input.accessExpiresAt, injectionOnly: input.injectionOnly }
        },
        input.deliverBy
      ), projectName: project.name, secretNames: secrets.map((secret) => secret.name) }))
    })
  }

  previewEnvelope(payload: Buffer, wrappedKey: Buffer): Promise<RelayTransferPreview> {
    return this.serialize(async () => {
      const opened = openRelayEnvelope(await this.deviceSelf(), await this.envelopeSender(payload), payload, wrappedKey)
      try {
        return relayPreview(opened)
      } finally {
        opened.contents.secrets.length = 0
      }
    })
  }

  // The vault transfer ID is the same for Link and Direct, so one envelope imports only one time across modes.
  acceptEnvelope(payload: Buffer, wrappedKey: Buffer, projectId: string,
    beforeWrite: (preview: RelayTransferPreview) => Promise<void>): Promise<RelayTransferAcceptance> {
    return this.serialize(async () => {
      const [self, sender] = await Promise.all([this.deviceSelf(), this.envelopeSender(payload)])
      const opened = openRelayEnvelope(self, sender, payload, wrappedKey)
      const preview = relayPreview(opened)
      const saved = (await this.readReceipts()).find((entry) => entry.id === opened.transfer.id)
      if (saved && (saved.digest !== opened.digest || saved.projectId !== projectId)) {
        throw new Error('This transfer was already imported into another project. Select its original destination.')
      }
      const receivedAt = Date.now()
      try {
        const secrets = await this.vault.importSecrets(projectId, opened.contents.secrets,
          `envelope:${opened.transfer.id}:${opened.digest}`, () => beforeWrite(preview), opened.contents.grant)
        if (saved?.complete && saved.receipt && saved.receivedAt !== undefined && saved.projectId === projectId) {
          return { ...preview, secrets, receivedAt: saved.receivedAt, receipt: Buffer.from(saved.receipt, 'base64') }
        }
        const receipt = sealReceipt(self, sender, opened.transfer,
          { status: 'received', receivedAt, secretCount: secrets.length }, receivedAt)
        await this.saveReceipt(opened.transfer.id, opened.digest, projectId, receivedAt, secrets.length, receipt)
        return { ...preview, secrets, receivedAt, receipt }
      } finally {
        opened.contents.secrets.length = 0
      }
    })
  }

  verifyEnvelopeReceipt(recipientId: string, transferId: string, receipt: Buffer,
    mode: Exclude<DeliveryMode, 'mailbox'>): Promise<TransferReceipt> {
    return this.serialize(async () => {
      const recipient = deviceKeys(requirePeer(await this.readPeers(), recipientId, 'This receipt comes from a device that is not verified.'))
      return verifyTransferReceipt(await this.deviceSelf(), recipient, transferId, receipt, mode)
    })
  }

  describeSend(input: unknown, mode: 'link' | 'direct' | 'webrtc'): Promise<ShareSummary> {
    return this.serialize(async () => this.describeSelection(requireLinkSend(input), mode))
  }

  describeExport(input: unknown): Promise<ShareSummary> {
    return this.serialize(async () => this.describeSelection(requireExport(input), 'airdrop'))
  }

  async createLink(input: unknown): Promise<LinkRecord> {
    const request = requireLinkSend(input)
    const sealed = await this.prepareEnvelope({ ...request, deliverBy: Date.now() + 24 * 60 * 60 * 1000 })
    const wrappedKey = sealed.wrappedKeys[0]
    if (!wrappedKey || sealed.wrappedKeys.length !== 1) throw new Error('Select one verified recipient for the link.')
    const transfer = readTransfer(sealed.payload)
    const record: LinkRecord = {
      transferId: sealed.id, recipientId: request.recipientId, projectName: sealed.projectName,
      secretNames: sealed.secretNames, deliverBy: transfer.deliverBy, createdAt: transfer.createdAt,
      link: encodeTransferLink(sealed.payload, wrappedKey.wrappedKey), state: { state: 'manual' }
    }
    return this.serialize(async () => {
      await this.writeJson('links.json', { links: [...await this.readLinks(), record] })
      return record
    })
  }

  async previewLink(link: unknown): Promise<LinkPreview> {
    const { payload, wrappedKey } = decodeTransferLink(link)
    const preview = await this.previewEnvelope(payload, wrappedKey)
    return linkPreview(preview, describeDevice((await this.envelopeSender(payload)).card))
  }

  async importLink(input: unknown): Promise<LinkImportResult> {
    const { link, projectId } = requireLinkImport(input)
    const { payload, wrappedKey } = decodeTransferLink(link)
    const sender = describeDevice((await this.envelopeSender(payload)).card)
    const imported = await this.acceptEnvelope(payload, wrappedKey, projectId, async () => undefined)
    return { ...linkPreview(imported, sender), secrets: imported.secrets, receiptLink: encodeReceiptLink(imported.receipt) }
  }

  async verifyLinkReceipt(input: unknown): Promise<TransferReceipt> {
    const { transferId, link } = requireLinkReceipt(input)
    const record = (await this.getLinkState()).find((entry) => entry.transferId === transferId)
    if (!record) throw new Error('The sent link record does not exist on this device.')
    const receipt = await this.verifyEnvelopeReceipt(record.recipientId, transferId, decodeReceiptLink(link), 'link')
    return this.serialize(async () => {
      const links = await this.readLinks()
      const saved = links.find((entry) => entry.transferId === transferId)
      if (!saved) throw new Error('The sent link record does not exist on this device.')
      saved.state = { state: 'received', receipt }
      await this.writeJson('links.json', { links })
      return receipt
    })
  }

  getLinkState(): Promise<LinkState> {
    return this.serialize(async () => {
      const links = await this.readLinks()
      let changed = false
      for (const record of links) {
        if (record.state.state === 'manual' && record.deliverBy <= Date.now()) {
          record.state = { state: 'expired' }
          changed = true
        }
      }
      if (changed) await this.writeJson('links.json', { links })
      return links
    })
  }

  deviceCardFile(): Promise<string> {
    return this.serialize(async () => {
      await mkdir(join(this.root, 'outbox'), { recursive: true, mode: 0o700 })
      const path = join(this.root, 'outbox', 'device.sct-device')
      await writeFile(path, JSON.stringify((await this.getIdentity()).card), { mode: 0o600 })
      return path
    })
  }

  previewPeer(source: string | { link: unknown }): Promise<PairingPreview> {
    return this.serialize(async () => {
      const identity = await this.getIdentity()
      const card = typeof source === 'string' ? readDeviceCard(await readLimited(source, 4096)) : readPairingLink(source.link)
      if (describeDevice(card).id === describeDevice(identity.card).id) throw new Error('This is your own device card. Select the other device’s card.')
      this.pairing = { token: randomUUID(), card }
      return { token: this.pairing.token, device: describeDevice(card), code: pairingCode(identity.card, card) }
    })
  }

  confirmPeer(token: unknown): Promise<SharingDevice> {
    return this.serialize(async () => {
      if (typeof token !== 'string' || !this.pairing || token !== this.pairing.token) {
        throw new Error('Open the device card again and compare the pairing code on both devices.')
      }
      const device = describeDevice(this.pairing.card)
      await this.writeJson('peers.json', { peers: [...(await this.readPeers()).filter((card) => describeDevice(card).id !== device.id), this.pairing.card] })
      this.pairing = undefined
      return device
    })
  }

  exportSecrets(input: unknown): Promise<string> {
    return this.serialize(async () => {
      if (typeof input !== 'object' || input === null || !('projectId' in input) || !('secretIds' in input) || !('recipientId' in input)) {
        throw new Error('Select a project, secrets, and a verified recipient.')
      }
      const recipient = (await this.readPeers()).find((peer) => describeDevice(peer).id === input.recipientId)
      if (!recipient) throw new Error('Verify the recipient device before sharing secrets.')
      const identity = await this.getIdentity()
      const contents = await this.vault.withSelectedSecrets(input.projectId, input.secretIds,
        (project, secrets) => encryptTransfer(identity, recipient, project.name, secrets))
      await mkdir(join(this.root, 'outbox'), { recursive: true, mode: 0o700 })
      const path = join(this.root, 'outbox', `${readEnvelope(contents).id}.sct-transfer`)
      await writeFile(path, contents, { mode: 0o600 })
      return path
    })
  }

  openTransfer(path: string): Promise<TransferPreview> {
    return this.serialize(async () => {
      const envelope = readEnvelope(await readLimited(path))
      const preview = this.preview(await this.getIdentity(), await this.readPeers(), envelope)
      this.requireReceipt(await this.readReceipts(), envelope)
      await mkdir(join(this.root, 'inbox'), { recursive: true, mode: 0o700 })
      const target = join(this.root, 'inbox', `${envelope.id}.sct-transfer`)
      try {
        const existing = readEnvelope(await readLimited(target))
        if (digest(existing) !== digest(envelope)) throw new Error('A different transfer already uses this message ID.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await writeFile(`${target}.tmp`, JSON.stringify(envelope), { mode: 0o600 })
      await rename(`${target}.tmp`, target)
      return preview
    })
  }

  importTransfer(input: unknown): Promise<SecretMetadata[]> {
    return this.serialize(async () => {
      const { transferId, projectId } = requireImport(input)
      const path = join(this.root, 'inbox', `${transferId}.sct-transfer`)
      const envelope = readEnvelope(await readLimited(path))
      const receipts = await this.readReceipts()
      const receipt = this.requireReceipt(receipts, envelope)
      if (receipt && receipt.projectId !== projectId) throw new Error('This import already started in another project. Select its original destination.')
      const sender = requirePeer(await this.readPeers(), envelope.sender)
      const payload = decryptTransfer(await this.getIdentity(), sender, envelope)
      try {
        const saved = await this.vault.importSecrets(projectId, payload.secrets, `${envelope.id}:${digest(envelope)}`, async () => {
          if (!receipt) {
            receipts.push({ id: envelope.id, digest: digest(envelope), projectId, complete: false })
            await this.writeJson('receipts.json', { receipts })
          }
        })
        const completed = receipts.find((entry) => entry.id === envelope.id)
        if (!completed) throw new Error('Cannot find the import receipt. Retry the same transfer and destination.')
        completed.complete = true
        await this.writeJson('receipts.json', { receipts })
        await rm(path)
        return saved
      } finally {
        // JavaScript strings cannot be cleared. Release decrypted values as soon as import finishes.
        payload.secrets.length = 0
      }
    })
  }

  dismissTransfer(id: unknown): Promise<void> {
    return this.serialize(async () => {
      requireTransferId(id)
      await rm(join(this.root, 'inbox', `${id}.sct-transfer`), { force: true })
    })
  }

  async cleanOutbox(): Promise<void> {
    // The AirDrop picker reports no transfer completion. Keep ciphertext until expiry or app exit.
    for (const name of await readdir(join(this.root, 'outbox')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })) {
      if (name.endsWith('.sct-transfer')) {
        const path = join(this.root, 'outbox', name)
        if (readEnvelope(await readLimited(path)).expiresAt <= Date.now()) await rm(path)
      }
    }
  }

  private async loadIdentity(): Promise<DeviceIdentity> {
    const saved = await this.vault.readInternal('sharing/identity')
    if (saved !== null) {
      try { return decodeIdentity(saved) } finally { saved.fill(0) }
    }
    const identity = createIdentity(this.name)
    const bytes = encodeIdentity(identity)
    try {
      const existing = await this.vault.writeInternalIfAbsent('sharing/identity', bytes)
      if (existing === null) return identity
      try { return decodeIdentity(existing) } finally { existing.fill(0) }
    } finally {
      bytes.fill(0)
    }
  }

  private async deviceSelf(): Promise<RelaySelf> {
    const keys = await this.getIdentity()
    return { identity: describeDevice(keys.card).id, keys }
  }

  // The routing fields name the sender device. Only a verified peer can open the envelope.
  private async envelopeSender(payload: Buffer): Promise<RelayPeerKeys> {
    return deviceKeys(requirePeer(await this.readPeers(), readTransfer(payload).senderDevice))
  }

  private getIdentity(): Promise<DeviceIdentity> {
    this.identity ??= this.loadIdentity().catch(() => {
      this.identity = undefined
      throw new Error('Cannot read the sharing identity. Unlock the vault and try again.')
    })
    return this.identity
  }

  // The caller reads the device identity before this call. The vault callback cannot read it, because both use the vault queue.
  private sealSecrets(self: RelaySelf, recipient: RelayPeerKeys, input: Omit<EnvelopeTransferInput, 'recipientId'>): Promise<SealedTransfer> {
    return this.vault.withSelectedSecrets(input.projectId, input.secretIds, async (project, secrets) => sealTransfer(
      self,
      [recipient],
      {
        projectName: project.name,
        secrets: secrets.map(({ name, value }) => ({ name, value: value.toString('utf8') })),
        grant: { accessExpiresAt: input.accessExpiresAt, injectionOnly: input.injectionOnly }
      },
      input.deliverBy
    ))
  }

  private async acceptSealed(self: RelaySelf, sender: RelayPeerKeys, payload: Buffer, wrappedKey: Buffer, projectId: string,
    prefix: 'relay' | 'envelope', beforeWrite: (preview: RelayTransferPreview) => Promise<void>): Promise<RelayTransferAcceptance> {
    const opened = openRelayEnvelope(self, sender, payload, wrappedKey)
    const preview = relayPreview(opened)
    const receivedAt = Date.now()
    try {
      const secrets = await this.vault.importSecrets(projectId, opened.contents.secrets,
        `${prefix}:${opened.transfer.id}:${opened.digest}`, () => beforeWrite(preview), opened.contents.grant)
      return {
        ...preview,
        secrets,
        receivedAt,
        receipt: sealReceipt(self, sender, opened.transfer,
          { status: 'received', receivedAt, secretCount: secrets.length }, receivedAt)
      }
    } finally {
      opened.contents.secrets.length = 0
    }
  }

  private preview(identity: DeviceIdentity, peers: DeviceCard[], envelope: TransferEnvelope): TransferPreview {
    const sender = requirePeer(peers, envelope.sender)
    const payload = decryptTransfer(identity, sender, envelope)
    try {
      return { id: envelope.id, sender: describeDevice(sender), projectName: payload.projectName,
        secretNames: payload.secrets.map((secret) => secret.name), expiresAt: new Date(envelope.expiresAt).toISOString() }
    } finally {
      payload.secrets.length = 0
    }
  }

  private requireReceipt(receipts: Receipt[], envelope: TransferEnvelope): Receipt | undefined {
    const receipt = receipts.find((entry) => entry.id === envelope.id)
    if (receipt && receipt.digest !== digest(envelope)) throw new Error('A different transfer already uses this message ID.')
    if (receipt?.complete) throw new Error('This transfer was already imported. No secrets were imported again.')
    return receipt
  }

  private async readPeers(): Promise<DeviceCard[]> {
    const data = await this.readJson('peers.json')
    if (!data) return []
    if (!Array.isArray(data.peers)) throw new Error('The verified device list is invalid.')
    return data.peers.map((card: unknown) => readDeviceCard(Buffer.from(JSON.stringify(card))))
  }

  private async readLinks(): Promise<LinkState> {
    return readLinkRecords(await this.readJson('links.json') ?? { links: [] })
  }

  private async readReceipts(): Promise<Receipt[]> {
    const data = await this.readJson('receipts.json')
    if (!data) return []
    if (!Array.isArray(data.receipts) || !data.receipts.every((entry: unknown): entry is Receipt =>
      typeof entry === 'object' && entry !== null && 'id' in entry && typeof entry.id === 'string' &&
      'digest' in entry && typeof entry.digest === 'string' && 'projectId' in entry && typeof entry.projectId === 'string' &&
      'complete' in entry && typeof entry.complete === 'boolean' &&
      (!('receivedAt' in entry) || typeof entry.receivedAt === 'number') &&
      (!('secretCount' in entry) || typeof entry.secretCount === 'number') &&
      (!('receipt' in entry) || typeof entry.receipt === 'string'))) throw new Error('The import receipt list is invalid.')
    return data.receipts
  }

  private async saveReceipt(id: string, digest: string, projectId: string, receivedAt: number, secretCount: number,
    receipt: Buffer): Promise<void> {
    const receipts = await this.readReceipts()
    const saved = receipts.find((entry) => entry.id === id)
    if (saved && (saved.digest !== digest || saved.projectId !== projectId)) {
      throw new Error('This import is bound to a different transfer or destination project.')
    }
    const record: Receipt = { id, digest, projectId, complete: true, receivedAt, secretCount, receipt: receipt.toString('base64') }
    await this.writeJson('receipts.json', { receipts: [...receipts.filter((entry) => entry.id !== id), record] })
  }

  private async readJson(name: string): Promise<Record<string, unknown> | undefined> {
    try { return readObject(await readFile(join(this.root, name))) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await writeFile(join(this.root, `${name}.tmp`), JSON.stringify(value), { mode: 0o600 })
    await rename(join(this.root, `${name}.tmp`), join(this.root, name))
  }

  private async incomingFiles(): Promise<string[]> {
    try { return (await readdir(join(this.root, 'inbox'))).filter((name) => name.endsWith('.sct-transfer')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async describeSelection(request: { projectId: string; secretIds: string[]; recipientId: string },
    mode: ShareSummary['mode']): Promise<ShareSummary> {
    const project = await this.vault.project(request.projectId)
    const ids = new Set(request.secretIds)
    const secretNames = (await this.vault.listProjectSecrets(request.projectId))
      .filter((secret) => ids.has(secret.id)).map((secret) => secret.name)
    if (secretNames.length !== ids.size || request.secretIds.length !== ids.size) {
      throw new Error('The selected secrets are unavailable. Refresh the project and try again.')
    }
    const peer = requirePeer(await this.readPeers(), request.recipientId, 'Verify the recipient device before sharing secrets.')
    return { mode, recipient: describeDevice(peer).name, project: project.name, secretNames }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation)
    this.pending = next.then(() => undefined, () => undefined)
    return next
  }
}

function linkPreview(preview: RelayTransferPreview, sender: SharingDevice): LinkPreview {
  return {
    transferId: preview.messageId, sender, projectName: preview.projectName, secretNames: preview.secretNames,
    deliverBy: preview.deliverBy, accessExpiresAt: preview.accessExpiresAt, injectionOnly: preview.injectionOnly
  }
}

function requireLinkSend(input: unknown): LinkSendInput {
  const parsed = z.strictObject({
    projectId: z.string().min(1), secretIds: z.array(z.string().min(1)).min(1).max(1000),
    recipientId: z.string().regex(/^[0-9a-f]{64}$/), accessExpiresAt: z.number().int().nonnegative().nullable(), injectionOnly: z.boolean()
  }).safeParse(input)
  if (!parsed.success) throw new Error('Select a project, secrets, a verified recipient, and valid access settings.')
  return parsed.data
}

function requireExport(input: unknown): { projectId: string; secretIds: string[]; recipientId: string } {
  const parsed = z.strictObject({
    projectId: z.string().min(1), secretIds: z.array(z.string().min(1)).min(1).max(1000),
    recipientId: z.string().regex(/^[0-9a-f]{64}$/)
  }).safeParse(input)
  if (!parsed.success) throw new Error('Select a project, secrets, and a verified recipient.')
  return parsed.data
}

function requireLinkImport(input: unknown): { link: string; projectId: string } {
  const parsed = z.strictObject({ link: z.string(), projectId: z.string().min(1) }).safeParse(input)
  if (!parsed.success) throw new Error('Paste an import link and select a destination project.')
  return parsed.data
}

function requireLinkReceipt(input: unknown): { transferId: string; link: string } {
  const parsed = z.strictObject({ transferId: z.uuidv4(), link: z.string() }).safeParse(input)
  if (!parsed.success) throw new Error('Select a sent link and paste its receipt link.')
  return parsed.data
}

function connectAad(input: { format: 'sct-connect'; version: 1; sessionId: string; senderId: string; recipientId: string;
  createdAt: number; expiresAt: number; ephemeralKey: string; iv: string }): Buffer {
  return Buffer.from(JSON.stringify(['sct-connect', 1, input.sessionId, input.senderId, input.recipientId,
    input.createdAt, input.expiresAt, input.ephemeralKey, input.iv]))
}

function relayPreview(opened: ReturnType<typeof openRelayEnvelope>): RelayTransferPreview {
  return {
    messageId: opened.transfer.id,
    digest: opened.digest,
    projectName: opened.contents.projectName,
    secretNames: opened.contents.secrets.map((secret) => secret.name),
    deliverBy: opened.transfer.deliverBy,
    accessExpiresAt: opened.contents.grant.accessExpiresAt,
    injectionOnly: opened.contents.grant.injectionOnly
  }
}

function deviceKeys(card: DeviceCard): RelayPeerKeys {
  return { identity: describeDevice(card).id, card }
}

function requirePeer(peers: DeviceCard[], id: unknown,
  missing = 'Verify the sender’s device card before opening this transfer.'): DeviceCard {
  const peer = peers.find((card) => describeDevice(card).id === id)
  if (!peer) throw new Error(missing)
  return peer
}

function requireImport(input: unknown): { transferId: string; projectId: string } {
  if (typeof input !== 'object' || input === null || !('transferId' in input) || !('projectId' in input) ||
    typeof input.projectId !== 'string' || !input.projectId) throw new Error('Select a received transfer and a destination project.')
  requireTransferId(input.transferId)
  return { transferId: input.transferId, projectId: input.projectId }
}

function requireTransferId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new Error('The transfer ID is invalid.')
  }
}

function digest(envelope: TransferEnvelope): string {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex')
}

async function readLimited(path: string, limit = transferLimit): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > limit) throw new Error('Select a valid global.sct file within the transfer size limit.')
    const contents = await file.readFile()
    if (contents.length > limit) throw new Error('The global.sct file exceeds the transfer size limit.')
    return contents
  } finally {
    await file.close()
  }
}
