import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { ShareGate } from '../src/main/share-gate.ts'
import type { ShareSummary } from '../src/shared/share.ts'

const summary: ShareSummary = {
  mode: 'direct',
  recipient: 'Bob laptop',
  project: 'Private project',
  secretNames: ['API_TOKEN']
}

const cancelled = 'The share was cancelled.'
const expired = 'This share confirmation expired. Start the share again.'
const locked = 'The vault is locked. Start the share again.'

test('a wrong passphrase sends nothing and a later correct passphrase sends one time', async () => {
  let runs = 0
  const { gate, changeCount } = createGate()
  const sent = gate.run(summary, async () => {
    runs += 1
    return 'sent'
  })
  const request = gate.current()
  assert.ok(request)

  await assert.rejects(gate.confirm({ id: request.id, passphrase: 'wrong' }), /The passphrase is incorrect/)
  assert.equal(runs, 0)
  assert.deepEqual(gate.current(), request)
  assert.equal(changeCount(), 1)

  await gate.confirm({ id: request.id, passphrase: 'correct horse' })
  assert.equal(await sent, 'sent')
  assert.equal(runs, 1)
  assert.equal(gate.current(), null)
  assert.equal(changeCount(), 2)
})

test('a request expires two minutes after it becomes active', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let runs = 0
  const { gate } = createGate()
  const outcome = settled(gate.run(summary, async () => {
    runs += 1
    return 'sent'
  }))

  t.mock.timers.tick(2 * 60 * 1000 - 1)
  assert.ok(gate.current())

  t.mock.timers.tick(1)
  assert.equal(await outcome, expired)
  assert.equal(gate.current(), null)
  assert.equal(runs, 0)
})

test('cancel rejects the active request and starts the next queued request', async () => {
  let firstRuns = 0
  let secondRuns = 0
  const { gate } = createGate()
  const cancelledRun = settled(gate.run(summary, async () => {
    firstRuns += 1
  }))
  const next = gate.run({ ...summary, recipient: 'Carol laptop' }, async () => {
    secondRuns += 1
  })
  assert.ok(gate.current())

  gate.cancel()
  assert.equal(await cancelledRun, cancelled)
  assert.equal(firstRuns, 0)

  const activated = gate.current()
  assert.ok(activated)
  assert.equal(activated.recipient, 'Carol laptop')
  await gate.confirm({ id: activated.id, passphrase: 'correct horse' })
  await next
  assert.equal(secondRuns, 1)
})

test('clear on lock rejects the active request and each queued request', async () => {
  let runs = 0
  const send = async () => {
    runs += 1
    return 'sent'
  }
  const { gate } = createGate()
  const outcomes = [
    settled(gate.run(summary, send)),
    settled(gate.run({ ...summary, recipient: 'Carol laptop' }, send)),
    settled(gate.run({ ...summary, recipient: 'Dave laptop' }, send))
  ]

  gate.clear()
  assert.equal(gate.current(), null)
  for (const outcome of outcomes) assert.equal(await outcome, locked)
  assert.equal(runs, 0)
})

test('a second confirm rejects while the passphrase is being checked', async () => {
  let release = () => {}
  const checking = new Promise<void>((resolve) => {
    release = resolve
  })
  let runs = 0
  const { gate } = createGate(async (passphrase) => {
    assert.equal(passphrase, 'correct horse')
    await checking
  })
  const sent = gate.run(summary, async () => {
    runs += 1
    return 'sent'
  })
  const request = gate.current()
  assert.ok(request)

  const first = gate.confirm({ id: request.id, passphrase: 'correct horse' })
  await Promise.resolve()
  await assert.rejects(gate.confirm({ id: request.id, passphrase: 'correct horse' }), /The passphrase is already being checked/)

  release()
  await first
  assert.equal(await sent, 'sent')
  assert.equal(runs, 1)
})

test('a request waits when eight requests are already queued', async () => {
  let runs = 0
  const send = async () => {
    runs += 1
    return 'sent'
  }
  const { gate } = createGate()
  const outcomes = Array.from({ length: 9 }, (_, index) =>
    settled(gate.run({ ...summary, recipient: `Peer ${index}` }, send)))
  assert.equal(gate.current()?.recipient, 'Peer 0')

  await assert.rejects(gate.run(summary, send), /Wait for the current share confirmation to finish/)

  gate.clear()
  for (const outcome of outcomes) assert.equal(await outcome, locked)
  assert.equal(runs, 0)
})

test('confirm rejects a wrong id, a missing passphrase, and a call with no request', async () => {
  let runs = 0
  const { gate } = createGate()

  await assert.rejects(gate.confirm({ id: randomUUID(), passphrase: 'correct horse' }), /No share confirmation is waiting/)

  const sent = settled(gate.run(summary, async () => {
    runs += 1
    return 'sent'
  }))
  const request = gate.current()
  assert.ok(request)

  await assert.rejects(gate.confirm({ id: randomUUID(), passphrase: 'correct horse' }), /no longer active/)
  await assert.rejects(gate.confirm({ id: request.id }), /Enter your vault passphrase to confirm the share/)
  assert.deepEqual(gate.current(), request)
  assert.equal(runs, 0)

  gate.clear()
  assert.equal(await sent, locked)
})

function createGate(verify: (passphrase: unknown) => Promise<void> = checkPassphrase) {
  let changes = 0
  const gate = new ShareGate(verify, () => {
    changes += 1
  })
  return { gate, changeCount: () => changes }
}

async function checkPassphrase(passphrase: unknown): Promise<void> {
  if (passphrase !== 'correct horse') throw new Error('The passphrase is incorrect.')
}

function settled<T>(promise: Promise<T>): Promise<T | string> {
  return promise.then((value) => value, (error: Error) => error.message)
}
