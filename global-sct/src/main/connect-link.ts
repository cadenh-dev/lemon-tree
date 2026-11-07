import { createHash } from 'node:crypto'
import { linkLimit } from '../shared/transport'
import { readObject } from './transfer'

export function decodeConnectLink(link: unknown): { outer: Record<string, unknown>; digest: string } {
  const prefix = 'global-sct://connect/v1/'
  if (typeof link !== 'string' || link.length > linkLimit || !link.startsWith(prefix)) {
    throw new Error('The WebRTC link is invalid.')
  }
  const encoded = link.slice(prefix.length)
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded) || Buffer.from(encoded, 'base64url').toString('base64url') !== encoded) {
    throw new Error('The WebRTC link is invalid.')
  }
  const bytes = Buffer.from(encoded, 'base64url')
  return { outer: readObject(bytes), digest: createHash('sha256').update(bytes).digest('hex') }
}
