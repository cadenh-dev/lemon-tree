import { z } from 'zod/v4'

export interface ConnectContents {
  kind: 'offer' | 'answer'
  // Exact SDP bytes are sent in the hidden WebRTC window.
  sdp: string
  // The SHA-256 of the exact offer link bytes. Answers only.
  offerDigest?: string
}

export interface WebRtcLinkPreview {
  kind: 'offer' | 'answer'
  sender: string
  expiresAt: number
}

export const connectContents = z.strictObject({
  kind: z.enum(['offer', 'answer']),
  sdp: z.string().min(1).max(8192),
  offerDigest: z.string().regex(/^[0-9a-f]{64}$/).optional()
})

const connectBase64 = (length?: number) => z.string().refine((value) => {
  try {
    const binary = atob(value)
    return btoa(binary) === value && (length === undefined || binary.length === length)
  } catch {
    return false
  }
})

export const connectOuter = z.strictObject({
  format: z.literal('sct-connect'), version: z.literal(1), sessionId: z.uuidv4(),
  senderId: z.string().regex(/^[0-9a-f]{64}$/), recipientId: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  ephemeralKey: z.string(), iv: connectBase64(12), tag: connectBase64(16), ciphertext: connectBase64(),
  signature: connectBase64(64)
})
