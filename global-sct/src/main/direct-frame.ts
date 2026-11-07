export const transferLimit = 8 * 1024 * 1024
export const wrappedKeyLimit = 4096
const frameBodyLimit = 1 + 4 + transferLimit + wrappedKeyLimit

export class FrameReader {
  private buffer = Buffer.alloc(0)

  push(chunk: Buffer): { kind: number; body: Buffer }[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const frames: { kind: number; body: Buffer }[] = []
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0)
      if (length < 1 || length > frameBodyLimit) throw new Error('The Direct frame is too large.')
      if (this.buffer.length < 4 + length) break
      const body = this.buffer.subarray(4, 4 + length)
      frames.push({ kind: body[0] ?? -1, body: body.subarray(1) })
      this.buffer = this.buffer.subarray(4 + length)
    }
    return frames
  }
}

export function encodeFrame(kind: number, body: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(5 + body.length)
  frame.writeUInt32BE(body.length + 1, 0)
  frame[4] = kind
  body.copy(frame, 5)
  return frame
}

export function transferBody(payload: Buffer, wrappedKey: Buffer): Buffer {
  const body = Buffer.allocUnsafe(4 + payload.length + wrappedKey.length)
  body.writeUInt32BE(payload.length, 0)
  payload.copy(body, 4)
  wrappedKey.copy(body, 4 + payload.length)
  return body
}

export function readTransferBody(body: Buffer): { payload: Buffer; wrappedKey: Buffer } {
  if (body.length < 5) throw new Error('The Direct transfer is incomplete.')
  const length = body.readUInt32BE(0)
  if (length === 0 || length > transferLimit || body.length <= 4 + length) throw new Error('The Direct transfer is invalid.')
  const wrappedKey = body.subarray(4 + length)
  if (wrappedKey.length === 0 || wrappedKey.length > wrappedKeyLimit) throw new Error('The Direct wrapped key is invalid.')
  return { payload: body.subarray(4, 4 + length), wrappedKey }
}
