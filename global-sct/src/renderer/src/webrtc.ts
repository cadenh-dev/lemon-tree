import type { WebRtcSessionConfig } from '../../shared/webrtc'

interface Command {
  type: 'offer' | 'accept-offer' | 'accept-answer' | 'send' | 'close'
  sdp?: string
  data?: string
  config?: WebRtcSessionConfig
}

interface Bridge {
  onCommand: (listener: (command: Command) => void) => void
  send: (event: unknown) => void
}

const chunkSize = 16 * 1024
const bufferedHigh = 256 * 1024
const bufferedLow = 64 * 1024

let connection: RTCPeerConnection | undefined
let channel: RTCDataChannel | undefined
let commands: Promise<void> = Promise.resolve()

declare global {
  interface Window { sctWebRtc: Bridge }
}

window.sctWebRtc.onCommand((command) => {
  commands = commands.then(() => run(command)).catch((error: unknown) => {
    window.sctWebRtc.send({ type: 'error', error: error instanceof Error ? error.message : 'The WebRTC window failed.' })
  })
})

async function run(command: Command): Promise<void> {
  if (command.type === 'offer') return offer(requireConfig(command.config))
  if (command.type === 'accept-offer') {
    return acceptOffer(requireString(command.sdp, 'The WebRTC offer is missing.'), requireConfig(command.config))
  }
  if (command.type === 'accept-answer') return acceptAnswer(requireString(command.sdp, 'The WebRTC answer is missing.'))
  if (command.type === 'send') return sendData(requireString(command.data, 'The WebRTC message is missing.'))
  if (command.type === 'close') close()
}

async function offer(config: WebRtcSessionConfig): Promise<void> {
  close()
  const peer = createPeer(config)
  setChannel(peer.createDataChannel('sct-direct-v1', { ordered: true }))
  await peer.setLocalDescription(await peer.createOffer())
  await gathered(peer)
  const sdp = peer.localDescription?.sdp
  if (!sdp) throw new Error('The WebRTC offer description is missing.')
  window.sctWebRtc.send({ type: 'offer', sdp })
}

async function acceptOffer(sdp: string, config: WebRtcSessionConfig): Promise<void> {
  close()
  const peer = createPeer(config)
  peer.ondatachannel = (event) => setChannel(event.channel)
  await peer.setRemoteDescription({ type: 'offer', sdp })
  await peer.setLocalDescription(await peer.createAnswer())
  await gathered(peer)
  const answer = peer.localDescription?.sdp
  if (!answer) throw new Error('The WebRTC answer description is missing.')
  window.sctWebRtc.send({ type: 'answer', sdp: answer })
}

async function acceptAnswer(sdp: string): Promise<void> {
  if (!connection) throw new Error('The WebRTC offer is not open.')
  await connection.setRemoteDescription({ type: 'answer', sdp })
}

async function sendData(data: string): Promise<void> {
  const target = channel
  if (!target || target.readyState !== 'open') throw new Error('The WebRTC data channel is not open.')
  const bytes = fromBase64(data)
  target.bufferedAmountLowThreshold = bufferedLow
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    if (target.readyState !== 'open') throw new Error('The WebRTC data channel closed during the transfer.')
    if (target.bufferedAmount > bufferedHigh) await drain(target)
    const buffer = new ArrayBuffer(Math.min(chunkSize, bytes.length - offset))
    new Uint8Array(buffer).set(bytes.subarray(offset, offset + buffer.byteLength))
    target.send(buffer)
  }
}

function createPeer(config: WebRtcSessionConfig): RTCPeerConnection {
  const peer = new RTCPeerConnection({ iceServers: config.iceServers, iceTransportPolicy: config.iceTransportPolicy })
  connection = peer
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
      window.sctWebRtc.send({ type: 'error', error: `The WebRTC connection is ${peer.connectionState}.` })
    }
    if (peer.connectionState === 'connected') {
      window.sctWebRtc.send({ type: 'connected' })
      void reportRoute(peer)
    }
  }
  return peer
}

function setChannel(dataChannel: RTCDataChannel): void {
  channel = dataChannel
  dataChannel.binaryType = 'arraybuffer'
  dataChannel.onopen = () => { window.sctWebRtc.send({ type: 'ready' }) }
  dataChannel.addEventListener('message', (event) => {
    if (typeof event.data === 'string') return
    window.sctWebRtc.send({ type: 'message', data: toBase64(new Uint8Array(event.data as ArrayBuffer)) })
  })
  dataChannel.onclose = () => { window.sctWebRtc.send({ type: 'close' }) }
  dataChannel.onerror = () => { window.sctWebRtc.send({ type: 'error', error: 'The WebRTC data channel failed.' }) }
}

function close(): void {
  channel?.close()
  channel = undefined
  connection?.close()
  connection = undefined
}

function gathered(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer = 0
    const cleanup = () => {
      clearTimeout(timer)
      peer.removeEventListener('icegatheringstatechange', check)
    }
    const check = () => {
      if (peer.iceGatheringState !== 'complete') return
      cleanup()
      resolve()
    }
    timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('The WebRTC candidate gathering timed out. Close the connection and retry.'))
    }, 10_000)
    peer.addEventListener('icegatheringstatechange', check)
  })
}

async function reportRoute(peer: RTCPeerConnection): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const found = await selectedRoute(peer)
    if (found) {
      window.sctWebRtc.send({ type: 'route', route: found })
      return
    }
    await delay(500)
  }
}

async function selectedRoute(peer: RTCPeerConnection): Promise<'direct' | 'turn' | null> {
  const stats = await peer.getStats()
  let selectedPairId: string | null = null
  stats.forEach((report) => {
    const value = report as unknown as { type?: string; selectedCandidatePairId?: string }
    if (value.type === 'transport' && typeof value.selectedCandidatePairId === 'string') selectedPairId = value.selectedCandidatePairId
  })
  let route: 'direct' | 'turn' | null = null
  stats.forEach((report) => {
    const value = report as unknown as { type?: string; selected?: boolean; localCandidateId?: string; remoteCandidateId?: string }
    if (value.type !== 'candidate-pair' || !(value.selected === true || (selectedPairId !== null && report.id === selectedPairId))) return
    for (const id of [value.localCandidateId, value.remoteCandidateId]) {
      if (!id) continue
      const candidate = stats.get(id) as unknown as { candidateType?: string } | undefined
      if (candidate?.candidateType === 'relay') route = 'turn'
      else if (route === null) route = 'direct'
    }
  })
  return route
}

function drain(target: RTCDataChannel): Promise<void> {
  return new Promise((resolve) => {
    let timer = 0
    const done = () => {
      clearTimeout(timer)
      target.removeEventListener('bufferedamountlow', done)
      resolve()
    }
    timer = window.setTimeout(done, 5_000)
    target.addEventListener('bufferedamountlow', done)
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, milliseconds) })
}

function requireConfig(value: WebRtcSessionConfig | undefined): WebRtcSessionConfig {
  if (!value || !Array.isArray(value.iceServers)) throw new Error('The WebRTC network settings are missing.')
  return value
}

function requireString(value: string | undefined, message: string): string {
  if (typeof value !== 'string' || !value) throw new Error(message)
  return value
}

function toBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export {}
