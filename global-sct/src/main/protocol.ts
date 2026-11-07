import { randomUUID } from 'node:crypto'
import { linkLimit } from '../shared/transport'
import type { PendingLink } from '../shared/transport'
import { connectOuter } from '../shared/connect'
import { readReceipt, readTransfer } from './envelope'
import { readPairingLink } from './transfer'
import { decodeConnectLink } from './connect-link'
import { decodeReceiptLink, decodeTransferLink } from './transport-link'

type Route = 'pair' | 'import' | 'receipt' | 'connect'
const routes: { route: Route; prefix: string }[] = [
  { route: 'pair', prefix: 'pair/v1/' },
  { route: 'import', prefix: 'import/' },
  { route: 'receipt', prefix: 'receipt/' },
  { route: 'connect', prefix: 'connect/v1/' }
]
const schemes = ['global-sct://', 'sct://'] as const

// Read one external link before it reaches the renderer. This checks the route, the size, and the
// complete encoded structure. Sender trust and signatures still use the normal sharing checks.
export function readProtocolLink(input: unknown): PendingLink {
  if (typeof input !== 'string') throw invalidLink()
  const route = routeOf(input)
  if (input.length > linkLimit) throw new Error('The link exceeds 16,384 characters. Paste a shorter link.')
  if (route === 'connect') {
    connectOuter.parse(decodeConnectLink(input).outer)
    return { id: randomUUID(), kind: 'connect', link: input }
  }
  const kind = route === 'pair' ? 'pairing' : route === 'import' ? 'import' : 'receipt'
  if (kind === 'pairing') {
    readPairingLink(input)
  } else if (kind === 'import') {
    const { payload } = decodeTransferLink(input)
    const transfer = readTransfer(payload)
    if (transfer.kind !== 'transfer' || transfer.recipients.length !== 1) throw invalidLink()
  } else {
    readReceipt(decodeReceiptLink(input))
  }
  return { id: randomUUID(), kind, link: input }
}

export function protocolLinksFromArguments(args: readonly string[]): string[] {
  return args.filter((value) => schemes.some((scheme) => value.startsWith(scheme)))
}

function routeOf(link: string): Route {
  for (const scheme of schemes) {
    for (const { route, prefix } of routes) {
      if (link.startsWith(`${scheme}${prefix}`)) return route
    }
  }
  throw invalidLink()
}

function invalidLink(): Error {
  return new Error('The link is invalid. Open a global-sct://pair/v1/, global-sct://import/, global-sct://receipt/, or global-sct://connect/v1/ link.')
}
