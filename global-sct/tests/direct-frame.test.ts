import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FrameReader, encodeFrame, readTransferBody, transferBody, transferLimit, wrappedKeyLimit }
  from '../src/main/direct-frame.ts'

// src/main/direct-frame.ts keeps frameBodyLimit private. The tests use the two exported limits.
const frameBodyLimit = 1 + 4 + transferLimit + wrappedKeyLimit

function lengthHeader(length: number): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(length, 0)
  return header
}

test('a frame that arrives in split chunks gives one frame after the last byte', () => {
  const frame = encodeFrame(7, Buffer.from('hello'))
  const reader = new FrameReader()
  // Split the 4-byte length header, then split the body before the last byte.
  for (const chunk of [frame.subarray(0, 2), frame.subarray(2, 4), frame.subarray(4, 9)]) {
    assert.deepEqual(reader.push(chunk), [])
  }
  const frames = reader.push(frame.subarray(9))
  assert.equal(frames.length, 1)
  assert.equal(frames[0]?.kind, 7)
  assert.deepEqual(frames[0]?.body, Buffer.from('hello'))
})

test('two frames in one chunk give two frames in order, and a later chunk gives the next frame', () => {
  const reader = new FrameReader()
  const frames = reader.push(Buffer.concat([encodeFrame(1, Buffer.from('first')), encodeFrame(2, Buffer.from('second'))]))
  assert.deepEqual(frames.map((frame) => [frame.kind, frame.body.toString()]), [[1, 'first'], [2, 'second']])
  const later = reader.push(encodeFrame(3, Buffer.from('third')))
  assert.equal(later.length, 1)
  assert.equal(later[0]?.kind, 3)
  assert.equal(later[0]?.body.toString(), 'third')
})

test('a frame with length 0 is rejected', () => {
  assert.throws(() => new FrameReader().push(lengthHeader(0)), { message: 'The Direct frame is too large.' })
})

test('a frame length above the body limit is rejected as soon as the header arrives', () => {
  assert.throws(() => new FrameReader().push(lengthHeader(frameBodyLimit + 1)), { message: 'The Direct frame is too large.' })
  // The body limit is inclusive. An incomplete valid frame gives no error and no frame.
  assert.deepEqual(new FrameReader().push(lengthHeader(frameBodyLimit)), [])
})

test('encodeFrame and transferBody round-trip through FrameReader and readTransferBody', () => {
  const payload = Buffer.from('payload bytes')
  const wrappedKey = Buffer.from('wrapped key bytes')
  const frames = new FrameReader().push(encodeFrame(9, transferBody(payload, wrappedKey)))
  assert.equal(frames.length, 1)
  assert.equal(frames[0]?.kind, 9)
  assert.ok(frames[0])
  const read = readTransferBody(frames[0].body)
  assert.deepEqual(read.payload, payload)
  assert.deepEqual(read.wrappedKey, wrappedKey)
})

test('readTransferBody rejects a body with payload length 0, no wrapped key, or a short length', () => {
  assert.throws(() => readTransferBody(Buffer.concat([lengthHeader(0), Buffer.from('key')])), { message: 'The Direct transfer is invalid.' })
  assert.throws(() => readTransferBody(transferBody(Buffer.from('p'), Buffer.alloc(0))), { message: 'The Direct transfer is invalid.' })
  assert.throws(() => readTransferBody(Buffer.alloc(4)), { message: 'The Direct transfer is incomplete.' })
})

test('readTransferBody rejects a wrapped key above the limit and accepts the limit', () => {
  const payload = Buffer.from('p')
  const tooLarge = transferBody(payload, Buffer.alloc(wrappedKeyLimit + 1))
  assert.throws(() => readTransferBody(tooLarge), { message: 'The Direct wrapped key is invalid.' })
  const read = readTransferBody(transferBody(payload, Buffer.alloc(wrappedKeyLimit)))
  assert.deepEqual(read.wrappedKey, Buffer.alloc(wrappedKeyLimit))
})
