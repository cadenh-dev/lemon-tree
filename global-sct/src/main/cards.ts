import { randomUUID } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { cardNotice } from '../shared/cards'
import type { MockCardInput } from '../shared/cards'

const passLimit = 10 * 1024 * 1024
const serviceTimeout = 30_000
const fileName = 'sct-mock-card.pkpass'

// walletmcppass.com signs the pass with its own certificate. It needs no account or API key.
export class Cards {
  constructor(private readonly root: string) {}

  // Sends only the fake form fields to the signing service, then keeps the signed pass in the outbox for AirDrop.
  async create(input: unknown): Promise<string> {
    const contents = await download(await requestPass(requireCard(input)))
    requirePass(contents)
    const id = randomUUID()
    await mkdir(join(this.root, 'outbox', id), { recursive: true, mode: 0o700 })
    await writeFile(join(this.root, 'outbox', id, fileName), contents, { mode: 0o600 })
    return id
  }

  async passFile(id: unknown): Promise<string> {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
      throw new Error('Create the card again.')
    }
    const path = join(this.root, 'outbox', id, fileName)
    if (!(await stat(path).catch(() => null))?.isFile()) throw new Error('The signed pass is gone. Create the card again.')
    return path
  }
}

function requireCard(input: unknown): MockCardInput {
  if (!isRecord(input) || typeof input.cardholder !== 'string' || typeof input.label !== 'string') {
    throw new Error('Enter a fake cardholder name and a card label.')
  }
  const cardholder = input.cardholder.trim()
  const label = input.label.trim()
  if (!cardholder || cardholder.length > 40) throw new Error('Enter a fake cardholder name of 40 characters or fewer.')
  if (!label || label.length > 40) throw new Error('Enter a card label of 40 characters or fewer.')
  return { cardholder, label }
}

async function requestPass(card: MockCardInput): Promise<URL> {
  const response = await fetch('https://walletmcppass.com/api/passes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The service rejects unknown keys. The colors are the paper, ink, and accent tokens of the Terminal theme.
    body: JSON.stringify({
      style: 'generic',
      organization_name: 'global.sct',
      description: `Mock card. ${cardNotice}.`,
      logo_text: 'global.sct',
      header_fields: [{ key: 'notice', value: cardNotice }],
      primary_fields: [{ key: 'cardholder', label: 'Cardholder', value: card.cardholder }],
      secondary_fields: [{ key: 'card', label: 'Card', value: card.label }],
      back_fields: [{ key: 'about', label: 'Notice', value: `${cardNotice}. This card has demonstration data only.` }],
      background_color: '#040805',
      foreground_color: '#e1f1de',
      label_color: '#7ef473'
    }),
    signal: AbortSignal.timeout(serviceTimeout)
  }).catch(() => {
    throw new Error('Cannot reach walletmcppass.com. Check the internet connection and try again.')
  })
  // global.sct never pays. Past the free limit, the service asks for an x402 payment with status 402.
  if (response.status === 402 || response.status === 429) throw new Error('The free daily limit of walletmcppass.com is used. Try again after 00:00 UTC.')
  if (response.status === 503) throw new Error('walletmcppass.com is busy. Try again later.')
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`walletmcppass.com did not create the pass. ${serviceError(body)}`)
  if (!isRecord(body) || typeof body.download_url !== 'string' || !URL.canParse(body.download_url)) {
    throw new Error('walletmcppass.com sent no download link.')
  }
  const url = new URL(body.download_url)
  if (url.protocol !== 'https:') throw new Error('walletmcppass.com sent a download link that is not HTTPS.')
  return url
}

function serviceError(body: unknown): string {
  if (!isRecord(body) || typeof body.error !== 'string') return 'Try again later.'
  const details = Array.isArray(body.details) ? body.details.filter((item) => typeof item === 'string') : []
  return [body.error, ...details].join(' ').slice(0, 300)
}

async function download(url: URL): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(serviceTimeout) }).catch(() => {
    throw new Error('Cannot download the signed pass. Check the internet connection and try again.')
  })
  if (!response.ok) throw new Error(`Cannot download the signed pass. walletmcppass.com replied with status ${response.status}.`)
  if (Number(response.headers.get('content-length')) > passLimit) throw new Error('The signed pass is larger than 10 MiB.')
  const contents = Buffer.from(await response.arrayBuffer())
  if (contents.length > passLimit) throw new Error('The signed pass is larger than 10 MiB.')
  return contents
}

// A .pkpass file is a ZIP archive. Wallet needs pass.json, manifest.json, and signature.
function requirePass(contents: Buffer): void {
  const entries = zipEntries(contents)
  const pass = entries.get('pass.json')
  if (!pass || !entries.has('manifest.json') || !entries.has('signature')) {
    throw new Error('The downloaded file is not a signed Apple Wallet pass.')
  }
  if (!readPassJson(contents, pass).includes(cardNotice)) {
    throw new Error(`The signed pass does not show “${cardNotice}”. global.sct did not send it.`)
  }
}

interface ZipEntry {
  method: number
  size: number
  offset: number
}

function zipEntries(contents: Buffer): Map<string, ZipEntry> {
  const entries = new Map<string, ZipEntry>()
  const end = contents.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (contents.length < 22 || contents.readUInt32LE(0) !== 0x04034b50 || end < 0 || end + 22 > contents.length) return entries
  let offset = contents.readUInt32LE(end + 16)
  for (let index = contents.readUInt16LE(end + 10); index > 0; index--) {
    if (offset + 46 > contents.length || contents.readUInt32LE(offset) !== 0x02014b50) return new Map()
    const nameLength = contents.readUInt16LE(offset + 28)
    entries.set(contents.toString('utf8', offset + 46, offset + 46 + nameLength), {
      method: contents.readUInt16LE(offset + 10), size: contents.readUInt32LE(offset + 20), offset: contents.readUInt32LE(offset + 42)
    })
    offset += 46 + nameLength + contents.readUInt16LE(offset + 30) + contents.readUInt16LE(offset + 32)
  }
  return entries
}

// Returns pass.json with JSON escapes resolved, so an escaped dash still matches the notice.
function readPassJson(contents: Buffer, entry: ZipEntry): string {
  try {
    if (contents.readUInt32LE(entry.offset) !== 0x04034b50) return ''
    const start = entry.offset + 30 + contents.readUInt16LE(entry.offset + 26) + contents.readUInt16LE(entry.offset + 28)
    const data = contents.subarray(start, start + entry.size)
    const text = (entry.method === 8 ? inflateRawSync(data, { maxOutputLength: passLimit }) : data).toString('utf8')
    return JSON.stringify(JSON.parse(text))
  } catch {
    return ''
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
