import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Project } from '../../shared/projects'
import type { SecretMetadata } from '../../shared/secrets'
import type { DirectImportResult, DirectSentItem } from '../../shared/direct'
import type { WebRtcIceConfig, WebRtcState } from '../../shared/webrtc'
import type { PendingLink } from '../../shared/transport'
import type { WebRtcLinkPreview } from '../../shared/connect'
import { errorText } from './operation'
import { PendingReceipts } from './PendingReceipts'
import { SecretSelection } from './SecretSelection'
import type { Loaded, Run, UpdateSecrets } from './types'

export function WebRtcSharing({ active, projectId, projects, secrets, updateSecrets, busy, run,
  pendingLink, onDismissPendingLink }: {
  active: boolean
  projectId?: string
  projects: Loaded<Project[]>
  secrets: Loaded<SecretMetadata[]>
  updateSecrets: UpdateSecrets
  busy: boolean
  run: Run
  pendingLink: PendingLink | null
  onDismissPendingLink: (id: string) => void
}) {
  const [state, setState] = useState<Loaded<WebRtcState>>({ state: 'loading' })
  const [preview, setPreview] = useState<Loaded<WebRtcLinkPreview | null>>({ state: 'ready', value: null })

  useEffect(() => {
    if (!active) return
    let mounted = true
    const refresh = () => {
      window.sct.getWebRtcState().then((value) => {
        if (mounted) setState({ state: 'ready', value })
      }).catch((cause: unknown) => {
        if (mounted) setState({ state: 'error', error: errorText(cause, 'Cannot read WebRTC sharing.') })
      })
    }
    const stop = window.sct.onWebRtcChanged(refresh)
    refresh()
    return () => { mounted = false; stop() }
  }, [active])

  useEffect(() => {
    if (!active || pendingLink?.kind !== 'connect') {
      setPreview({ state: 'ready', value: null })
      return
    }
    let mounted = true
    setPreview({ state: 'loading' })
    window.sct.previewWebRtcLink(pendingLink.link).then((value) => {
      if (mounted) setPreview({ state: 'ready', value })
    }).catch((cause: unknown) => {
      if (mounted) setPreview({ state: 'error', error: errorText(cause, 'Cannot open this WebRTC link.') })
    })
    return () => { mounted = false }
  }, [active, pendingLink])

  const refresh = async () => setState({ state: 'ready', value: await window.sct.getWebRtcState() })

  return <>
    {state.state === 'loading' && <p role="status">Loading WebRTC sharing…</p>}
    {state.state === 'error' && <p className="error" role="alert">{state.error}</p>}
    {state.state === 'ready' && <>
      {state.value.error && <p className="error" role="alert">{state.value.error}</p>}
      {preview.state === 'loading' && <p role="status">Opening the WebRTC link…</p>}
      {preview.state === 'error' && <>
        <p className="error" role="alert">{preview.error}</p>
        {pendingLink?.kind === 'connect' && <div className="form-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => onDismissPendingLink(pendingLink.id)}>
            Dismiss link
          </button>
        </div>}
      </>}
      <WebRtcConnection state={state.value} busy={busy} run={run} refresh={refresh}
        initial={preview.state === 'ready' && pendingLink?.kind === 'connect' && preview.value
          ? { ...preview.value, link: pendingLink.link } : undefined}
        onAccepted={pendingLink?.kind === 'connect' ? () => onDismissPendingLink(pendingLink.id) : undefined}
        onDismiss={pendingLink?.kind === 'connect' ? () => onDismissPendingLink(pendingLink.id) : undefined} />
      <WebRtcNetwork busy={busy} run={run} />
      <WebRtcSend state={state.value} projectId={projectId} projects={projects} secrets={secrets}
        busy={busy} run={run} refresh={refresh} />
      <WebRtcIncoming state={state.value} projects={projects} busy={busy} run={run}
        refresh={refresh} updateSecrets={updateSecrets} />
      <PendingReceipts receipts={state.value.receipts} busy={busy} run={run} />
      <WebRtcSent state={state.value} busy={busy} run={run} refresh={refresh} />
    </>}
  </>
}

function WebRtcConnection({ state, busy, run, refresh, initial, onAccepted, onDismiss }: {
  state: WebRtcState
  busy: boolean
  run: Run
  refresh: () => Promise<void>
  initial?: WebRtcLinkPreview & { link: string }
  onAccepted?: () => void
  onDismiss?: () => void
}) {
  const [peer, setPeer] = useState(state.peerId ?? '')
  const [answer, setAnswer] = useState('')
  const [offer, setOffer] = useState('')

  useEffect(() => {
    if (!initial) return
    if (initial.kind === 'offer') setOffer(initial.link)
    else setAnswer(initial.link)
  }, [initial?.kind, initial?.link])

  async function createOffer() {
    await run('Creating the WebRTC offer…', async () => {
      await window.sct.createWebRtcOffer(peer)
      await refresh()
      return 'Offer link created. Send it to the peer.'
    })
  }

  async function acceptOffer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await run('Creating the WebRTC answer…', async () => {
      await window.sct.acceptWebRtcOffer(offer)
      await refresh()
      onAccepted?.()
      return 'Answer link created. Send it back to the sender.'
    })
  }

  async function acceptAnswer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await run('Opening the WebRTC connection…', async () => {
      await window.sct.acceptWebRtcAnswer(answer)
      await refresh()
      onAccepted?.()
      return 'The WebRTC connection is opening.'
    })
  }

  return <section className="panel" aria-labelledby="webrtc-heading">
    <h2 id="webrtc-heading">WebRTC connection</h2>
    <p>Exchange one offer link and one answer link. Both apps must be open and unlocked.</p>
    {initial && <div className="field-help">
      <p>{initial.kind === 'offer' ? `Offer from ${initial.sender}.` : `Answer from ${initial.sender}.`}</p>
      {onDismiss && <div className="form-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onDismiss}>Dismiss link</button>
      </div>}
    </div>}
    {state.connection === 'ready' && <p>The WebRTC connection is ready.{state.route === 'turn' ? ' Direct via TURN.' : ''}</p>}
    {state.connection === 'connecting' && <p role="status">The WebRTC connection is opening…</p>}
    {state.offerLink && <>
      <label htmlFor="webrtc-offer-link">Offer link</label>
      <textarea className="link-text" id="webrtc-offer-link" value={state.offerLink} readOnly spellCheck={false} />
      <div className="form-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => {
          void copy(state.offerLink ?? '', 'Offer link copied.', run)
        }}>Copy offer link</button>
      </div>
      <form onSubmit={(event) => { void acceptAnswer(event) }}>
        <fieldset disabled={busy}>
          <label htmlFor="webrtc-answer-link">Paste answer link</label>
          <textarea className="link-text" id="webrtc-answer-link" value={answer} spellCheck={false}
            onChange={(event) => setAnswer(event.target.value)} />
          <div className="form-actions"><button type="submit" disabled={!answer}>Accept answer</button></div>
        </fieldset>
      </form>
    </>}
    {state.answerLink && <>
      <label htmlFor="webrtc-answer-out">Answer link</label>
      <textarea className="link-text" id="webrtc-answer-out" value={state.answerLink} readOnly spellCheck={false} />
      <div className="form-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => {
          void copy(state.answerLink ?? '', 'Answer link copied.', run)
        }}>Copy answer link</button>
      </div>
    </>}
    {!state.offerLink && !state.answerLink && <>
      <label htmlFor="webrtc-peer">Verified device</label>
      <select id="webrtc-peer" value={peer} disabled={busy} onChange={(event) => setPeer(event.target.value)}>
        <option value="">Choose a verified device</option>
        {state.peers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <div className="form-actions">
        <button type="button" disabled={busy || !peer} onClick={() => { void createOffer() }}>Create WebRTC offer</button>
      </div>
      <form onSubmit={(event) => { void acceptOffer(event) }}>
        <fieldset disabled={busy}>
          <label htmlFor="webrtc-offer-in">Paste offer link</label>
          <textarea className="link-text" id="webrtc-offer-in" value={offer} spellCheck={false}
            onChange={(event) => setOffer(event.target.value)} />
          <div className="form-actions"><button type="submit" className="secondary" disabled={!offer}>Create answer</button></div>
        </fieldset>
      </form>
    </>}
    {state.connection !== 'off' && <div className="form-actions">
      <button type="button" className="secondary" disabled={busy} onClick={() => {
        void run('Closing the WebRTC connection…', async () => {
          await window.sct.closeWebRtc()
          await refresh()
          return 'The WebRTC connection is closed.'
        })
      }}>Close connection</button>
    </div>}
  </section>
}

// The visible window sees server names only. The TURN password stays in the vault and the hidden session window.
function WebRtcNetwork({ busy, run }: { busy: boolean; run: Run }) {
  const [config, setConfig] = useState<Loaded<WebRtcIceConfig>>({ state: 'loading' })
  const [stunUrl, setStunUrl] = useState('')
  const [turnUrls, setTurnUrls] = useState('')
  const [turnUsername, setTurnUsername] = useState('')
  const [turnCredential, setTurnCredential] = useState('')
  const [turnOnly, setTurnOnly] = useState(false)

  useEffect(() => {
    let mounted = true
    window.sct.getWebRtcIce().then((value) => {
      if (!mounted) return
      setConfig({ state: 'ready', value })
      setStunUrl(value.stunUrl ?? '')
      setTurnUrls(value.turnUrls.join('\n'))
      setTurnUsername(value.turnUsername ?? '')
      setTurnOnly(value.turnOnly)
    }).catch((cause: unknown) => {
      if (mounted) setConfig({ state: 'error', error: errorText(cause, 'Cannot read the WebRTC network settings.') })
    })
    return () => { mounted = false }
  }, [])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await run('Saving the WebRTC network settings…', async () => {
      const value = await window.sct.saveWebRtcIce({
        stunUrl, turnUrls: turnUrls.split(/\r?\n/).map((url) => url.trim()).filter(Boolean),
        turnUsername, turnCredential, turnOnly
      })
      setConfig({ state: 'ready', value })
      setTurnCredential('')
      return 'The WebRTC network settings are saved.'
    })
  }

  return <section className="panel" aria-labelledby="webrtc-network-heading">
    <h2 id="webrtc-network-heading">WebRTC network settings</h2>
    <p>No server is required on the same network. A public STUN server is optional. TURN forwards encrypted traffic; it is not durable Mailbox storage.</p>
    {config.state === 'loading' && <p role="status">Loading network settings…</p>}
    {config.state === 'error' && <p className="error" role="alert">{config.error}</p>}
    {config.state === 'ready' && <>
      <p className="field-help">{iceSummary(config.value)}</p>
      <form onSubmit={(event) => { void save(event) }}>
        <fieldset disabled={busy}>
          <label htmlFor="webrtc-stun">Public STUN server (optional)</label>
          <input id="webrtc-stun" value={stunUrl} placeholder="stun:stun.example.org" spellCheck={false}
            onChange={(event) => setStunUrl(event.target.value)} />
          <label htmlFor="webrtc-turn-urls">TURN server URLs (one per line, optional)</label>
          <textarea className="link-text" id="webrtc-turn-urls" value={turnUrls} placeholder="turn:turn.example.org:3478"
            spellCheck={false} onChange={(event) => setTurnUrls(event.target.value)} />
          <label htmlFor="webrtc-turn-username">TURN username</label>
          <input id="webrtc-turn-username" value={turnUsername} autoComplete="off" spellCheck={false}
            onChange={(event) => setTurnUsername(event.target.value)} />
          <label htmlFor="webrtc-turn-credential">TURN password</label>
          <input id="webrtc-turn-credential" type="password" value={turnCredential} autoComplete="new-password"
            placeholder={config.value.turnConfigured ? 'Leave empty to keep the saved password' : ''}
            onChange={(event) => setTurnCredential(event.target.value)} />
          <label className="check-field">
            <input type="checkbox" checked={turnOnly} onChange={(event) => setTurnOnly(event.target.checked)} />
            Use TURN only. Direct candidates are blocked.
          </label>
          <p className="field-help">The TURN password stays in the vault. The visible window never reads it again.</p>
          <div className="form-actions"><button type="submit">Save network settings</button></div>
        </fieldset>
      </form>
    </>}
  </section>
}

function iceSummary(config: WebRtcIceConfig): string {
  const parts: string[] = []
  if (config.stunUrl) parts.push(`STUN ${config.stunUrl}`)
  if (config.turnConfigured) parts.push(`${config.turnUrls.length} TURN ${config.turnUrls.length === 1 ? 'server' : 'servers'}${config.turnOnly ? ' with TURN only' : ''}`)
  return parts.length === 0 ? 'No STUN or TURN server is configured. Connections use direct candidates.' : `${parts.join('. ')}.`
}

function WebRtcSend({ state, projectId, projects, secrets, busy, run, refresh }: {
  state: WebRtcState
  projectId?: string
  projects: Loaded<Project[]>
  secrets: Loaded<SecretMetadata[]>
  busy: boolean
  run: Run
  refresh: () => Promise<void>
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [source, setSource] = useState(projectId ?? '')

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!state.peerId) return
    await run('Sending over WebRTC…', async () => {
      await window.sct.sendWebRtc({ projectId: source, secretIds: [...selected], recipientId: state.peerId ?? '',
        accessExpiresAt: null, injectionOnly: true })
      await refresh()
      setSelected(new Set())
      return 'The encrypted transfer is on its way.'
    })
  }

  return <section className="panel" aria-labelledby="webrtc-send-heading">
    <h2 id="webrtc-send-heading">Send over WebRTC</h2>
    <p>Create and open a WebRTC connection before you send.</p>
    <form onSubmit={(event) => { void send(event) }}>
      <fieldset disabled={busy || state.connection !== 'ready' || projects.state !== 'ready'}>
        <label htmlFor="webrtc-source">Source project</label>
        <select id="webrtc-source" value={source} required onChange={(event) => {
          setSource(event.target.value)
          setSelected(new Set())
        }}>
          <option value="">Choose a project</option>
          {projects.state === 'ready' && projects.value.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <SecretSelection secrets={secrets} source={source} selected={selected} onChange={setSelected} />
        <div className="form-actions"><button type="submit" disabled={!source || selected.size === 0}>Send over WebRTC</button></div>
      </fieldset>
    </form>
  </section>
}

function WebRtcIncoming({ state, projects, busy, run, refresh, updateSecrets }: {
  state: WebRtcState
  projects: Loaded<Project[]>
  busy: boolean
  run: Run
  refresh: () => Promise<void>
  updateSecrets: UpdateSecrets
}) {
  const [destinations, setDestinations] = useState<Record<string, string>>({})
  const [imported, setImported] = useState<DirectImportResult | null>(null)

  async function importItem(event: FormEvent<HTMLFormElement>, transferId: string, sender: string) {
    event.preventDefault()
    await run('Importing the WebRTC transfer…', async () => {
      const result = await window.sct.importWebRtc({ transferId, projectId: destinations[transferId] ?? '' })
      updateSecrets((current) => [...current.filter((secret) => !result.secrets.some((saved) => saved.id === secret.id)), ...result.secrets])
      setImported(result)
      await refresh()
      return `Imported from ${sender}.`
    })
  }

  return <section className="panel" aria-labelledby="webrtc-incoming-heading">
    <h2 id="webrtc-incoming-heading">Incoming WebRTC transfers</h2>
    {state.incoming.length === 0 && <p>No WebRTC transfer is waiting.</p>}
    {state.incoming.length > 0 && <ul className="relay-peers" aria-label="Incoming WebRTC transfers">
      {state.incoming.map((item) => <li key={item.transferId}>
        <h3>{item.projectName}</h3>
        <p>From {item.senderName}</p>
        <p>{item.secretNames.join(', ')}</p>
        <form onSubmit={(event) => { void importItem(event, item.transferId, item.senderName) }}>
          <fieldset disabled={busy || projects.state !== 'ready'}>
            <label htmlFor={`webrtc-destination-${item.transferId}`}>Destination project</label>
            <select id={`webrtc-destination-${item.transferId}`} value={destinations[item.transferId] ?? ''} required
              onChange={(event) => setDestinations((current) => ({ ...current, [item.transferId]: event.target.value }))}>
              <option value="">Choose a local project</option>
              {projects.state === 'ready' && projects.value.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <div className="form-actions"><button type="submit" disabled={!destinations[item.transferId]}>Import and send receipt</button></div>
          </fieldset>
        </form>
      </li>)}
    </ul>}
    {imported && <>
      <p>Imported {imported.secrets.length} {imported.secrets.length === 1 ? 'secret' : 'secrets'}.</p>
      <label htmlFor="webrtc-receipt-link">Receipt link</label>
      <textarea className="link-text" id="webrtc-receipt-link" value={imported.receiptLink} readOnly spellCheck={false} />
      <div className="form-actions"><button type="button" className="secondary" disabled={busy} onClick={() => {
        void copy(imported.receiptLink, 'Receipt link copied.', run)
      }}>Copy receipt link</button></div>
    </>}
  </section>
}

function WebRtcSent({ state, busy, run, refresh }: {
  state: WebRtcState
  busy: boolean
  run: Run
  refresh: () => Promise<void>
}) {
  const [receipts, setReceipts] = useState<Record<string, string>>({})

  async function verify(event: FormEvent<HTMLFormElement>, item: DirectSentItem) {
    event.preventDefault()
    await run('Verifying the receipt…', async () => {
      await window.sct.verifyWebRtcReceipt({ transferId: item.transferId, link: receipts[item.transferId] ?? '' })
      await refresh()
      return 'Receipt verified.'
    })
  }

  return <section className="panel" aria-labelledby="webrtc-sent-heading">
    <h2 id="webrtc-sent-heading">Sent over WebRTC</h2>
    {state.sent.length === 0 && <p>No WebRTC transfer was sent.</p>}
    {state.sent.length > 0 && <ul className="relay-peers" aria-label="Sent WebRTC transfers">
      {state.sent.map((item) => <li key={item.transferId}>
        <h3>{item.projectName}</h3>
        <p>{item.secretNames.join(', ')}</p>
        <p>State: {item.state}.</p>
        {(item.state === 'manual' || item.state === 'failed') && <form onSubmit={(event) => { void verify(event, item) }}>
          <fieldset disabled={busy}>
            <label htmlFor={`webrtc-receipt-${item.transferId}`}>Paste receipt link</label>
            <textarea className="link-text" id={`webrtc-receipt-${item.transferId}`} value={receipts[item.transferId] ?? ''}
              spellCheck={false} onChange={(event) => setReceipts((current) => ({ ...current, [item.transferId]: event.target.value }))} />
            <div className="form-actions"><button type="submit" disabled={!receipts[item.transferId]}>Verify receipt</button></div>
          </fieldset>
        </form>}
      </li>)}
    </ul>}
  </section>
}

async function copy(value: string, message: string, run: Run): Promise<void> {
  await run('Copying the link…', async () => {
    await window.sct.copyText(value)
    return message
  })
}
