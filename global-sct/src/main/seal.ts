import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ivLength = 12
const tagLength = 16

export interface Sealed {
  iv: Buffer
  tag: Buffer
  ciphertext: Buffer
}

export function seal(key: Buffer, plaintext: Buffer, data: Buffer, iv = randomBytes(ivLength)): Sealed {
  if (iv.length !== ivLength) throw new Error('The AES-GCM IV must be 12 bytes.')
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(data)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { iv, tag: cipher.getAuthTag(), ciphertext }
}

export function open(key: Buffer, { iv, tag, ciphertext }: Sealed, data: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv).setAAD(data).setAuthTag(tag)
  const plaintext = decipher.update(ciphertext)
  try {
    return Buffer.concat([plaintext, decipher.final()])
  } finally {
    // GCM can produce plaintext before final() checks the authentication tag.
    plaintext.fill(0)
  }
}

// Encrypted file layout: magic | IV | GCM tag | ciphertext.
export function encodeFile(magic: Buffer, { iv, tag, ciphertext }: Sealed): Buffer {
  return Buffer.concat([magic, iv, tag, ciphertext])
}

export function decodeFile(magic: Buffer, contents: Buffer): Sealed | undefined {
  if (contents.length < magic.length + ivLength + tagLength || !contents.subarray(0, magic.length).equals(magic)) return undefined
  const tagStart = magic.length + ivLength
  const dataStart = tagStart + tagLength
  return { iv: contents.subarray(magic.length, tagStart), tag: contents.subarray(tagStart, dataStart), ciphertext: contents.subarray(dataStart) }
}
