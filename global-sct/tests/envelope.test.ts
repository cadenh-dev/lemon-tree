import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { createIdentity } from '../src/main/transfer.ts'
import { deliveryLimit, findReceipt, openExpiryNotice, openReceipt, openTransfer, readTransfer,
  sealExpiryNotice, sealReceipt, sealTransfer } from '../src/main/envelope.ts'
import type { RelayPeerKeys, RelaySelf } from '../src/main/envelope.ts'
import type { RelayTransferContents } from '../src/shared/envelope.ts'

const hour = 60 * 60 * 1000
const now = Date.UTC(2026, 9, 24, 12)

function device(name: string): RelaySelf & RelayPeerKeys {
  const keys = createIdentity(name)
  return { identity: randomBytes(32).toString('hex'), keys, card: keys.card }
}

function contents(accessExpiresAt: number | null = null): RelayTransferContents {
  return {
    projectName: 'Private project',
    secrets: [{ name: 'API_TOKEN', value: ' spaces "quotes" $dollars = equals\nnext line' }, { name: 'EMPTY', value: '' }],
    grant: { accessExpiresAt, injectionOnly: true }
  }
}

function wrapped(sealed: ReturnType<typeof sealTransfer>, recipient: RelayPeerKeys): Buffer {
  const entry = sealed.wrappedKeys.find((key) => key.recipient === recipient.identity)
  assert.ok(entry)
  return entry.wrappedKey
}

// Changes one field of the JSON payload, as a relay or network attacker could.
function changed(payload: Buffer, field: string, value: unknown): Buffer {
  return Buffer.from(JSON.stringify({ ...JSON.parse(payload.toString('utf8')), [field]: value }))
}

test('each recipient decrypts the transfer and the sender decrypts the correlated receipt', () => {
  const alice = device('Alice')
  const bob = device('Bob')
  const carol = device('Carol')
  const sealed = sealTransfer(alice, [bob, carol], contents(now + 48 * hour), now + 24 * hour, now)
  assert.ok(!sealed.payload.includes('API_TOKEN') && !sealed.payload.includes('Private project') && !sealed.payload.includes('quotes'))
  assert.deepEqual(readTransfer(sealed.payload).recipients, [bob.identity, carol.identity].sort())

  for (const recipient of [bob, carol]) {
    const opened = openTransfer(recipient, alice, sealed.payload, wrapped(sealed, recipient), now + hour)
    assert.equal(opened.transfer.id, sealed.id)
    assert.deepEqual(opened.contents, contents(now + 48 * hour))
  }

  const opened = openTransfer(bob, alice, sealed.payload, wrapped(sealed, bob), now + hour)
  const receipt = sealReceipt(bob, alice, opened.transfer, { status: 'received', receivedAt: now + hour, secretCount: 2 }, now + hour)
  assert.deepEqual(openReceipt(alice, bob, sealed.id, receipt, now + hour), { status: 'received', receivedAt: now + hour, secretCount: 2 })
  const notice = sealExpiryNotice(bob, alice, sealed.id, { status: 'expired', expiredAt: now + 48 * hour, secretCount: 2 }, now + 48 * hour)
  assert.deepEqual(openExpiryNotice(alice, bob, sealed.id, notice, now + 48 * hour),
    { status: 'expired', expiredAt: now + 48 * hour, secretCount: 2 })
})

test('only an intended recipient decrypts the payload', () => {
  const alice = device('Alice')
  const bob = device('Bob')
  const carol = device('Carol')
  const mallory = device('Mallory')
  const sealed = sealTransfer(alice, [bob, carol], contents(), now + hour, now)
  assert.throws(() => openTransfer(mallory, alice, sealed.payload, wrapped(sealed, bob), now), /belongs to a different device/)
  // A recipient cannot use the wrapped key of another recipient.
  assert.throws(() => openTransfer(bob, alice, sealed.payload, wrapped(sealed, carol), now), /Cannot decrypt/)
  const receipt = sealReceipt(bob, alice, readTransfer(sealed.payload), { status: 'received', receivedAt: now, secretCount: 2 }, now)
  assert.throws(() => openReceipt(carol, bob, sealed.id, receipt, now), /different transfer or device/)
})

test('tampering with routing fields, ciphertext, signature, or wrapped key fails', () => {
  const alice = device('Alice')
  const bob = device('Bob')
  const carol = device('Carol')
  const sealed = sealTransfer(alice, [bob], contents(), now + hour, now)
  const key = wrapped(sealed, bob)
  const transfer = readTransfer(sealed.payload)
  const flipped = Buffer.from(transfer.ciphertext, 'base64')
  flipped[0] ^= 1
  for (const payload of [
    changed(sealed.payload, 'deliverBy', now + 2 * hour),
    changed(sealed.payload, 'recipients', [bob.identity, carol.identity].sort()),
    changed(sealed.payload, 'ciphertext', flipped.toString('base64')),
    changed(sealed.payload, 'signature', randomBytes(64).toString('base64'))
  ]) {
    assert.throws(() => openTransfer(bob, alice, payload, key, now), /signature is invalid/)
  }
  const wrappedKey = JSON.parse(key.toString('utf8'))
  const otherKey = Buffer.from(JSON.stringify({ ...wrappedKey, key: randomBytes(32).toString('base64') }))
  assert.throws(() => openTransfer(bob, alice, sealed.payload, otherKey, now), /Cannot decrypt/)
  assert.throws(() => readTransfer(changed(sealed.payload, 'version', 2)), /invalid or uses an unsupported format/)

  const receipt = sealReceipt(bob, alice, transfer, { status: 'received', receivedAt: now, secretCount: 2 }, now)
  assert.throws(() => openReceipt(alice, bob, sealed.id, changed(receipt, 'createdAt', now - 1), now), /signature is invalid/)
  assert.throws(() => openReceipt(alice, bob, sealTransfer(alice, [bob], contents(), now + hour, now).id, receipt, now), /different transfer/)
  const notice = sealExpiryNotice(bob, alice, sealed.id, { status: 'expired', expiredAt: now + hour, secretCount: 2 }, now)
  assert.throws(() => openExpiryNotice(alice, bob, sealed.id, changed(notice, 'createdAt', now - 1), now), /signature is invalid/)
  assert.throws(() => openExpiryNotice(alice, carol, sealed.id, notice, now), /different transfer or device/)
})

test('a sender without the verified keys fails', () => {
  const alice = device('Alice')
  const bob = device('Bob')
  const imposter = createIdentity('Alice')
  const sealed = sealTransfer(alice, [bob], contents(), now + hour, now)
  // The relay shows the same relay identity, but the verified keys differ.
  assert.throws(() => openTransfer(bob, { identity: alice.identity, card: imposter.card }, sealed.payload, wrapped(sealed, bob), now), /not a verified device/)
  assert.throws(() => openTransfer(bob, { ...alice, identity: randomBytes(32).toString('hex') }, sealed.payload, wrapped(sealed, bob), now), /not a verified device/)
  // A message that an unverified device signed with its own keys fails against the verified keys of the claimed sender.
  const forged = sealTransfer({ identity: alice.identity, keys: imposter }, [bob], contents(), now + hour, now)
  assert.throws(() => openTransfer(bob, alice, forged.payload, wrapped(forged, bob), now), /not a verified device/)
})

test('expired transfers, future creation times, and expired access fail', () => {
  const alice = device('Alice')
  const bob = device('Bob')
  const sealed = sealTransfer(alice, [bob], contents(now + 2 * hour), now + hour, now)
  assert.throws(() => openTransfer(bob, alice, sealed.payload, wrapped(sealed, bob), now + hour), /expired/)
  const future = sealTransfer(alice, [bob], contents(), now + 3 * hour, now + 2 * hour)
  assert.throws(() => openTransfer(bob, alice, future.payload, wrapped(future, bob), now), /creation time is invalid/)
  const access = sealTransfer(alice, [bob], contents(now + 2 * hour), now + 3 * hour, now)
  assert.throws(() => openTransfer(bob, alice, access.payload, wrapped(access, bob), now + 2 * hour), /Access to these secrets expired/)
})

test('the sender cannot seal invalid deadlines, recipients, or secrets', () => {
  const alice = device('Alice')
  const bob = device('Bob')
  assert.throws(() => sealTransfer(alice, [bob], contents(), now + deliveryLimit + 1, now), /within the next 7 days/)
  assert.throws(() => sealTransfer(alice, [bob], contents(), now, now), /within the next 7 days/)
  assert.throws(() => sealTransfer(alice, [bob], contents(now), now + hour, now), /access deadline/)
  assert.throws(() => sealTransfer(alice, [], contents(), now + hour, now), /verified recipients/)
  assert.throws(() => sealTransfer(alice, [bob, bob], contents(), now + hour, now), /each verified recipient one time/)
  assert.throws(() => sealTransfer(alice, [alice], contents(), now + hour, now), /cannot be a recipient/)
  assert.throws(() => sealTransfer(alice, [bob], { ...contents(), secrets: [] }, now + hour, now), /invalid/)
})

test('a duplicate delivery returns the saved receipt, and a conflicting ID fails', () => {
  const alice = device('Alice')
  const bob = device('Bob')
  const sealed = sealTransfer(alice, [bob], contents(), now + hour, now)
  const opened = openTransfer(bob, alice, sealed.payload, wrapped(sealed, bob), now)
  const receipts = [{ id: opened.transfer.id, digest: opened.digest, projectId: 'project' }]
  assert.equal(findReceipt([], readTransfer(sealed.payload)), undefined)
  assert.equal(findReceipt(receipts, readTransfer(sealed.payload)), receipts[0])
  const conflicting = sealTransfer(alice, [bob], contents(), now + hour, now)
  assert.throws(() => findReceipt(receipts, readTransfer(changed(conflicting.payload, 'id', sealed.id))), /different transfer already uses this message ID/)
})
