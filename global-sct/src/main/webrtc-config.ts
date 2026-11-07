import { z } from 'zod/v4'
import type { Vault } from './vault'
import type { WebRtcIceConfig, WebRtcSessionConfig } from '../shared/webrtc'

const storedSchema = z.strictObject({
  stunUrl: z.string().max(2048).nullable(),
  turnUrls: z.array(z.string().max(2048)).max(2),
  turnUsername: z.string().max(256).nullable(),
  turnCredential: z.string().max(1024).nullable(),
  turnOnly: z.boolean()
})
const inputSchema = z.strictObject({
  stunUrl: z.string().max(2048),
  turnUrls: z.array(z.string().max(2048)).max(4),
  turnUsername: z.string().max(256),
  turnCredential: z.string().max(1024),
  turnOnly: z.boolean()
})

type StoredIce = z.infer<typeof storedSchema>
const empty: StoredIce = { stunUrl: null, turnUrls: [], turnUsername: null, turnCredential: null, turnOnly: false }

// TURN credentials live in the vault's .internal area. The visible window receives only the server names.
export class WebRtcConfig {
  constructor(private readonly vault: Vault) {}

  get(): Promise<WebRtcIceConfig> {
    return this.stored().then(publicConfig)
  }

  save(value: unknown): Promise<WebRtcIceConfig> {
    return this.vault.writeInternal('webrtc-ice', Buffer.from(JSON.stringify(requireConfig(value, empty)))).then(() => this.get())
  }

  async session(): Promise<WebRtcSessionConfig> {
    const config = await this.stored()
    const iceServers: WebRtcSessionConfig['iceServers'] = []
    if (config.stunUrl) iceServers.push({ urls: [config.stunUrl] })
    if (config.turnUrls.length > 0 && config.turnUsername && config.turnCredential) {
      iceServers.push({ urls: config.turnUrls, username: config.turnUsername, credential: config.turnCredential })
    }
    return { iceServers, iceTransportPolicy: config.turnOnly ? 'relay' : 'all' }
  }

  private async stored(): Promise<StoredIce> {
    const value = await this.vault.readInternal('webrtc-ice')
    if (!value) return empty
    try {
      const parsed = storedSchema.safeParse(JSON.parse(value.toString('utf8')))
      if (!parsed.success) throw new Error('Invalid WebRTC settings.')
      return parsed.data
    } catch {
      throw new Error('The saved WebRTC network settings are invalid. Remove them and save the settings again.')
    }
  }
}

function publicConfig(config: StoredIce): WebRtcIceConfig {
  return {
    stunUrl: config.stunUrl,
    turnUrls: config.turnUrls,
    turnUsername: config.turnUsername,
    turnConfigured: config.turnUrls.length > 0 && config.turnUsername !== null && config.turnCredential !== null,
    turnOnly: config.turnOnly
  }
}

function requireConfig(value: unknown, saved: StoredIce): StoredIce {
  const parsed = inputSchema.safeParse(value)
  if (!parsed.success) throw new Error('Enter valid WebRTC network settings.')
  const stunUrl = parsed.data.stunUrl.trim()
  const turnUrls = parsed.data.turnUrls.map((url) => url.trim()).filter(Boolean)
  const turnUsername = parsed.data.turnUsername.trim()
  if (stunUrl) requireIceUrl(stunUrl, ['stun', 'stuns'], 'STUN server')
  if (turnUrls.length > 2) throw new Error('Use at most two TURN server URLs.')
  if (new Set(turnUrls).size !== turnUrls.length) throw new Error('The TURN server URLs must be different.')
  for (const url of turnUrls) requireIceUrl(url, ['turn', 'turns'], 'TURN server')
  if (turnUrls.length === 0) {
    if (parsed.data.turnOnly) throw new Error('TURN only needs a TURN server.')
    return { stunUrl: stunUrl || null, turnUrls: [], turnUsername: null, turnCredential: null, turnOnly: false }
  }
  if (!turnUsername) throw new Error('Enter the TURN username.')
  let turnCredential = parsed.data.turnCredential
  if (!turnCredential && saved.turnUsername === turnUsername && saved.turnCredential && sameUrls(saved.turnUrls, turnUrls)) {
    turnCredential = saved.turnCredential
  }
  if (!turnCredential) throw new Error('Enter the TURN password.')
  return { stunUrl: stunUrl || null, turnUrls, turnUsername, turnCredential, turnOnly: parsed.data.turnOnly }
}

function requireIceUrl(value: string, protocols: string[], label: string): void {
  const match = /^([a-z]+):(.+)$/.exec(value)
  if (!match || !protocols.includes(match[1] ?? '')) throw new Error(`${label} must start with ${protocols.join(' or ')}.`)
  const authority = match[2] ?? ''
  const query = authority.indexOf('?')
  const host = query === -1 ? authority : authority.slice(0, query)
  const transport = query === -1 ? '' : authority.slice(query)
  if (transport && (!protocols.includes('turn') || !/^\?transport=(udp|tcp)$/.test(transport))) {
    throw new Error(`${label} has an unsupported query string.`)
  }
  if (host.startsWith('//') || host.includes('@') || /[\s#]/.test(host) || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) {
    throw new Error(`${label} is not a valid server URL.`)
  }
}

function sameUrls(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
