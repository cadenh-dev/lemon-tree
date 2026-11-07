import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Project } from '../../shared/projects'
import type { SecretMetadata } from '../../shared/secrets'
import type { PairingPreview, SharingDevice, SharingState, TransferPreview } from '../../shared/sharing'
import { pairingLinkLimit } from '../../shared/sharing'
import { relayInboxFinished, relaySentFinished, relayTaskFinished } from '../../shared/relay'
import type { RelayActivityKey, RelayInboxItem, RelayPeer, RelaySentItem, RelayState, RelayTaskDecision, RelayTaskItem } from '../../shared/relay'
import { errorText, StatusLine, useOperation } from './operation'
import { HandoffModal, Scramble } from './SharingMotion'
import type { HandoffStage } from './SharingMotion'
import type { Loaded, Run, SharingTab, UpdateProjects, UpdateSecrets } from './types'
import type { PendingLink } from '../../shared/transport'
import { LinkSharing } from './LinkSharing'
import { DirectSharing } from './DirectSharing'
import { WebRtcSharing } from './WebRtcSharing'
import { SendSharing } from './SendSharing'
import { SecretSelection } from './SecretSelection'

interface SharingViewProps {
  projectId?: string
  tab?: SharingTab
  projects: Loaded<Project[]>
  secrets: Loaded<SecretMetadata[]>
  updateProjects: UpdateProjects
  updateSecrets: UpdateSecrets
  pendingLink: PendingLink | null
  onDismissPendingLink: (id: string) => void
}

type SharingValue = SharingState & { location: string }
type SharingOperation = ReturnType<typeof useOperation>
type SetSharing = (update: (current: Loaded<SharingValue>) => Loaded<SharingValue>) => void

interface ReadySharingProps {
  sharing: SharingValue
  activeTab: SharingTab
  projectId?: string
  projects: Loaded<Project[]>
  secrets: Loaded<SecretMetadata[]>
  receipt: Receipt | null
  setReceipt: (receipt: Receipt) => void
  operation: SharingOperation
  setSharing: SetSharing
  updateProjects: UpdateProjects
  updateSecrets: UpdateSecrets
  pendingLink: PendingLink | null
  onDismissPendingLink: (id: string) => void
}

export function SharingView({ projectId, tab, projects, secrets, updateProjects, updateSecrets,
  pendingLink, onDismissPendingLink }: SharingViewProps) {
  const [sharing, setSharing] = useState<Loaded<SharingState & { location: string }>>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const operation = useOperation()
  const isMac = window.sct.platform === 'darwin'
  const activeTab = activeSharingTab(sharing, receipt !== null, tab, isMac)

  useEffect(() => {
    let active = true
    const refresh = () => {
      Promise.all([window.sct.getSharingState(), window.sct.getVaultLocation()]).then(([value, location]) => {
        if (active) setSharing({ state: 'ready', value: { ...value, location } })
      }).catch((cause: unknown) => {
        if (active) setSharing({ state: 'error', error: errorText(cause, 'Cannot load sharing. Unlock the vault and retry.') })
      })
    }
    refresh()
    const unsubscribe = window.sct.onSharingChanged(refresh)
    return () => { active = false; unsubscribe() }
  }, [attempt])

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Sharing</h1>
          <p className="description">{isMac ? 'Send encrypted secrets by link, Direct, WebRTC, AirDrop, or Mailbox.' : 'Send encrypted secrets by link, Direct, WebRTC, or Mailbox.'} Received values stay in the main process.</p>
        </div>
      </div>

      <StatusLine status={operation.status} />
      {sharing.state === 'loading' && <p role="status">Loading sharing…</p>}
      {sharing.state === 'error' && <p className="error" role="alert">{sharing.error}</p>}
      {sharing.state === 'error' && <button type="button" className="secondary" onClick={() => {
        setSharing({ state: 'loading' })
        setAttempt((current) => current + 1)
      }}>Retry sharing</button>}
      {projects.state === 'error' && <p className="error" role="alert">{projects.error}</p>}
      {secrets.state === 'error' && <p className="error" role="alert">{secrets.error}</p>}

      {sharing.state === 'ready' && (isMac ? <MacSharing sharing={sharing.value} activeTab={activeTab} projectId={projectId}
        projects={projects} secrets={secrets} receipt={receipt} setReceipt={setReceipt} operation={operation}
        setSharing={setSharing} updateProjects={updateProjects} updateSecrets={updateSecrets}
        pendingLink={pendingLink} onDismissPendingLink={onDismissPendingLink} />
        : <RelayAndPairing sharing={sharing.value} setSharing={setSharing} activeTab={activeTab} projectId={projectId} projects={projects} secrets={secrets}
          operation={operation} updateProjects={updateProjects} updateSecrets={updateSecrets}
          pendingLink={pendingLink} onDismissPendingLink={onDismissPendingLink} />)}
      <div hidden={activeTab !== 'send'}>
        <SendSharing projectId={projectId} active={activeTab === 'send'} projects={projects} secrets={secrets}
          busy={operation.busy} run={operation.run} />
      </div>
      {sharing.state === 'ready' && <div hidden={activeTab !== 'link'}>
        <LinkSharing projectId={projectId} active={activeTab === 'link'} projects={projects} secrets={secrets}
          peers={sharing.value.peers} busy={operation.busy} run={operation.run} updateSecrets={updateSecrets}
          pendingLink={pendingLink} onDismissPendingLink={onDismissPendingLink} />
      </div>}
      <div hidden={activeTab !== 'direct'}>
        <DirectSharing projectId={projectId} active={activeTab === 'direct'} projects={projects} secrets={secrets}
          updateSecrets={updateSecrets} busy={operation.busy} run={operation.run} />
      </div>
      <div hidden={activeTab !== 'webrtc'}>
        <WebRtcSharing projectId={projectId} active={activeTab === 'webrtc'} projects={projects} secrets={secrets}
          updateSecrets={updateSecrets} busy={operation.busy} run={operation.run}
          pendingLink={pendingLink} onDismissPendingLink={onDismissPendingLink} />
      </div>
    </>
  )
}

function MacSharing({ sharing, activeTab, projectId, projects, secrets, receipt, setReceipt, operation, setSharing,
  updateProjects, updateSecrets, pendingLink, onDismissPendingLink }: ReadySharingProps) {
  return (
    <>
      {activeTab !== 'receive' && sharing.incoming.length > 0 && <p className="sharing-waiting">
        <a href={sharingRoute('receive', projectId)}>
          {sharing.incoming.length === 1 ? 'A received transfer is waiting.' : `${sharing.incoming.length} received transfers are waiting.`}
        </a>
      </p>}
      <SharingTabs activeTab={activeTab} projectId={projectId} canShare={sharing.peers.length > 0} isMac />
      {sharing.peers.length > 0 && <div hidden={activeTab !== 'secrets'}>
        <SendSecrets projectId={projectId} active={activeTab === 'secrets'} projects={projects} secrets={secrets}
          peers={sharing.peers} busy={operation.busy} run={operation.run} />
      </div>}
      <div hidden={activeTab !== 'receive'}>
        <ReceiveSecrets device={sharing.device} incoming={sharing.incoming} canImport={sharing.peers.length > 0}
          receipt={receipt} projects={projects} location={sharing.location} busy={operation.busy} run={operation.run}
          updateSecrets={updateSecrets} setReceipt={setReceipt}
          update={(incoming) => setSharing((current) => current.state === 'ready' ? {
            state: 'ready', value: { ...current.value, incoming: incoming(current.value.incoming) }
          } : current)} />
      </div>
      <div hidden={activeTab !== 'devices'}>
        <DeviceVerification key={pendingLink?.kind === 'pairing' ? pendingLink.id : 'device-verification'}
          projectId={projectId} device={sharing.device} peers={sharing.peers}
          busy={operation.busy} run={operation.run} isMac
          initialLink={pendingLink?.kind === 'pairing' ? pendingLink.link : undefined}
          onDismissLink={pendingLink?.kind === 'pairing' ? () => onDismissPendingLink(pendingLink.id) : undefined}
          onVerified={(device) => setSharing((current) => current.state === 'ready' ? {
            state: 'ready', value: { ...current.value, peers: [...current.value.peers.filter((peer) => peer.id !== device.id), device] }
          } : current)} />
      </div>
      <div hidden={activeTab !== 'relay'}>
        <RelaySharing projectId={projectId} active={activeTab === 'relay'} projects={projects} secrets={secrets}
          busy={operation.busy} run={operation.run} updateProjects={updateProjects} updateSecrets={updateSecrets} />
      </div>
    </>
  )
}

function RelayAndPairing({ sharing, setSharing, activeTab, projectId, projects, secrets, operation, updateProjects, updateSecrets,
  pendingLink, onDismissPendingLink }: Pick<ReadySharingProps,
  'sharing' | 'setSharing' | 'activeTab' | 'projectId' | 'projects' | 'secrets' | 'operation' | 'updateProjects' | 'updateSecrets' |
  'pendingLink' | 'onDismissPendingLink'>) {
  return (
    <>
      <SharingTabs activeTab={activeTab} projectId={projectId} canShare={false} isMac={false} />
      <div hidden={activeTab !== 'devices'}>
        <DeviceVerification key={pendingLink?.kind === 'pairing' ? pendingLink.id : 'device-verification'}
          projectId={projectId} device={sharing.device} peers={sharing.peers}
          busy={operation.busy} run={operation.run} isMac={false}
          initialLink={pendingLink?.kind === 'pairing' ? pendingLink.link : undefined}
          onDismissLink={pendingLink?.kind === 'pairing' ? () => onDismissPendingLink(pendingLink.id) : undefined}
          onVerified={(device) => setSharing((current) => current.state === 'ready' ? {
            state: 'ready', value: { ...current.value, peers: [...current.value.peers.filter((peer) => peer.id !== device.id), device] }
          } : current)} />
      </div>
      <div hidden={activeTab !== 'relay'}>
        <RelaySharing projectId={projectId} active={activeTab === 'relay'} projects={projects} secrets={secrets}
          busy={operation.busy} run={operation.run} updateProjects={updateProjects} updateSecrets={updateSecrets} />
      </div>
    </>
  )
}

interface Receipt {
  id: string
  sender: string
  project: string
  names: string[]
}

// A waiting transfer or a new receipt opens the Receive tab unless the route names another tab.
function activeSharingTab(sharing: Loaded<SharingState>, received: boolean, tab: SharingTab | undefined, isMac: boolean): SharingTab {
  if (tab === 'link' || tab === 'direct' || tab === 'webrtc' || tab === 'send') return tab
  if (!isMac) return tab === 'devices' ? 'devices' : 'relay'
  if (tab === 'relay') return 'relay'
  if (tab === 'receive') return 'receive'
  if (sharing.state !== 'ready') return 'devices'
  if (!tab && (received || sharing.value.incoming.length > 0)) return 'receive'
  return sharing.value.peers.length > 0 ? tab ?? 'secrets' : 'devices'
}

function selectedNames(secrets: Loaded<SecretMetadata[]>, selected: Set<string>): string[] {
  return secrets.state === 'ready' ? secrets.value.filter((secret) => selected.has(secret.id)).map((secret) => secret.name) : []
}

function secretCount(count: number): string {
  return count === 1 ? '1 secret' : `${count} secrets`
}

function sharingRoute(tab: SharingTab, projectId?: string): string {
  return `#/sharing/${tab}${projectId ? `/${encodeURIComponent(projectId)}` : ''}`
}

function SharingTabs({ activeTab, projectId, canShare, isMac }: {
  activeTab: SharingTab
  projectId?: string
  canShare: boolean
  isMac: boolean
}) {
  const navigation = useRef<HTMLElement>(null)

  useEffect(() => {
    const showActiveTab = () => {
      const tabs = navigation.current
      const active = tabs?.querySelector<HTMLElement>('[aria-current="page"]')
      if (!tabs || !active) return
      if (active.offsetLeft < tabs.scrollLeft) tabs.scrollLeft = active.offsetLeft
      else if (active.offsetLeft + active.offsetWidth > tabs.scrollLeft + tabs.clientWidth) {
        tabs.scrollLeft = active.offsetLeft + active.offsetWidth - tabs.clientWidth
      }
    }
    showActiveTab()
    const observer = new ResizeObserver(showActiveTab)
    if (navigation.current) observer.observe(navigation.current)
    return () => observer.disconnect()
  }, [activeTab])

  return (
    <>
      <nav ref={navigation} className="sharing-tabs" aria-label="Sharing">
        <a href={sharingRoute('devices', projectId)} aria-current={activeTab === 'devices' ? 'page' : undefined}>Verify devices</a>
        <a href={sharingRoute('send', projectId)} aria-current={activeTab === 'send' ? 'page' : undefined}>Send</a>
        {isMac && (canShare ? (
          <a href={sharingRoute('secrets', projectId)} aria-current={activeTab === 'secrets' ? 'page' : undefined}>Send secrets</a>
        ) : <span aria-disabled="true" aria-describedby="sharing-verification-required">Send secrets</span>)}
        {isMac && <a href={sharingRoute('receive', projectId)} aria-current={activeTab === 'receive' ? 'page' : undefined}>Receive secrets</a>}
        <a href={sharingRoute('relay', projectId)} aria-current={activeTab === 'relay' ? 'page' : undefined}>Relay</a>
        <a href={sharingRoute('link', projectId)} aria-current={activeTab === 'link' ? 'page' : undefined}
          aria-label="Link sharing">Link</a>
        <a href={sharingRoute('direct', projectId)} aria-current={activeTab === 'direct' ? 'page' : undefined}
          aria-label="Direct sharing">Direct</a>
        <a href={sharingRoute('webrtc', projectId)} aria-current={activeTab === 'webrtc' ? 'page' : undefined}
          aria-label="WebRTC sharing">WebRTC</a>
      </nav>
      {isMac && !canShare && activeTab !== 'relay' && <p id="sharing-verification-required" className="field-help sharing-tab-help">
        Verify a device before you can send secrets.
      </p>}
    </>
  )
}

function RelaySharing({ projectId, active, projects, secrets, busy, run, updateProjects, updateSecrets }: {
  projectId?: string
  active: boolean
  projects: Loaded<Project[]>
  secrets: Loaded<SecretMetadata[]>
  busy: boolean
  run: Run
  updateProjects: UpdateProjects
  updateSecrets: UpdateSecrets
}) {
  const [relay, setRelay] = useState<Loaded<RelayState>>({ state: 'loading' })
  // Inbox rows that were present at the first load, or that already showed an arrival.
  const [seen, setSeen] = useState<Set<string> | null>(null)
  // The arrival that asks for a destination project after its animation.
  const [asking, setAsking] = useState<string | null>(null)
  const [imported, setImported] = useState<ImportedTransfer | null>(null)

  useEffect(() => {
    let mounted = true
    const refresh = () => {
      window.sct.getRelayState().then((value) => {
        if (!mounted) return
        setRelay({ state: 'ready', value })
        setSeen((current) => current ?? new Set(value.inbox.map((item) => item.messageId)))
      }).catch((cause: unknown) => {
        if (mounted) setRelay({ state: 'error', error: errorText(cause, 'Cannot read relay status.') })
      })
    }
    refresh()
    const unsubscribe = window.sct.onRelayChanged(refresh)
    return () => { mounted = false; unsubscribe() }
  }, [])

  if (relay.state === 'loading') return <p role="status">Loading relay…</p>
  if (relay.state === 'error') return <p className="error" role="alert">{relay.error}</p>
  // A dialog inside the hidden tab cannot show, so a new arrival waits until the Relay tab is open.
  const arrival = active && seen ? relay.value.inbox.find((item) => !seen.has(item.messageId)) : undefined
  const sender = arrival ? peerName(relay.value, arrival.sender) : ''
  // Only a transfer that this device can open and has not imported asks for a project.
  const destination = active ? relay.value.inbox.find((item) => item.messageId === asking && item.state === 'pending') : undefined
  return (
    <>
      {arrival && <HandoffModal key={arrival.messageId} heading={`Receiving from ${sender}`} via="relay" from={sender} to="This device"
        stage="received" object={{ shape: 'key', title: 'Encrypted transfer', detail: shortId(arrival.messageId) }}
        onDone={() => {
          setSeen((current) => new Set([...(current ?? []), arrival.messageId]))
          setAsking(arrival.messageId)
        }} />}
      {destination && projects.state === 'ready' && <RelayImportDialog key={destination.messageId} item={destination}
        sender={peerName(relay.value, destination.sender)} projects={projects.value} updateProjects={updateProjects}
        updateSecrets={updateSecrets} onClose={() => setAsking(null)} onImported={(value) => {
          setAsking(null)
          setImported(value)
        }} />}
      {imported && <HandoffModal heading={`Receiving from ${imported.sender}`} via="relay" from={imported.sender} to={imported.project}
        stage="arrived" onDone={() => setImported(null)} object={{
          shape: 'key',
          title: secretCount(imported.names.length),
          detail: imported.names.join(' ')
        }} />}
      <RelayConnection state={relay.value} />
      <RelayPairing state={relay.value} busy={busy} run={run} />
      <RelaySend projectId={projectId} projects={projects} secrets={secrets} state={relay.value} busy={busy} run={run} />
      <RelayActivity state={relay.value} projects={projects} busy={busy} run={run} updateProjects={updateProjects}
        updateSecrets={updateSecrets} onImported={setImported} />
    </>
  )
}

interface ImportedTransfer {
  sender: string
  project: string
  names: string[]
}

// After the arrival animation, the recipient chooses a project or makes one. The import sends the receipt,
// so the sender shows the transfer as sent until the recipient imports it.
function RelayImportDialog({ item, sender, projects, updateProjects, updateSecrets, onClose, onImported }: {
  item: RelayInboxItem
  sender: string
  projects: Project[]
  updateProjects: UpdateProjects
  updateSecrets: UpdateSecrets
  onClose: () => void
  onImported: (imported: ImportedTransfer) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const operation = useOperation()

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  return (
    <dialog ref={dialog} className="import-dialog" aria-labelledby="import-heading"
      onCancel={(event) => { if (operation.busy) event.preventDefault() }} onClose={onClose}>
      <h2 id="import-heading">Save secrets from {sender}</h2>
      <p>{item.projectName}: {item.secretNames.join(', ')}</p>
      <p className="field-help">Choose a project on this device or make a new one. The transfer stays pending until you import it.</p>
      <StatusLine status={operation.status} />
      <RelayImportForm item={item} sender={sender} projects={projects} busy={operation.busy} run={operation.run}
        updateProjects={updateProjects} updateSecrets={updateSecrets} onImported={onImported}
        onLater={() => dialog.current?.close()} />
    </dialog>
  )
}

function RelayConnection({ state }: { state: RelayState }) {
  const live = state.connection === 'connected'
  return (
    <section className="relay-summary" aria-labelledby="relay-heading">
      <div>
        <h2 id="relay-heading">Relay sharing</h2>
        <p>{relayConnectionText(state)}</p>
      </div>
      <p className="relay-state" data-state={state.connection}>{live ? 'Live status' : 'Cached status'}</p>
      {state.identity && <div className="relay-identity">
        <span>This device’s relay ID</span>
        <code>{state.identity}</code>
      </div>}
      {!live && state.updatedAt && <p className="field-help">Last relay update: {formatTime(state.updatedAt)}.</p>}
      {state.error && <p className="error" role="alert">{state.error}</p>}
    </section>
  )
}

function relayConnectionText(state: RelayState): string {
  if (state.connection === 'connected') return state.registered
    ? 'This device is connected. Relay updates appear without a page reload.'
    : 'This device is connected but is not registered yet.'
  if (state.connection === 'connecting') return 'This device is connecting. Saved activity remains available.'
  if (state.connection === 'offline') return 'The relay is offline. Saved activity can be out of date.'
  return 'The relay is off. Set SCT_RELAY to connect this app.'
}

function RelayPairing({ state, busy, run }: { state: RelayState; busy: boolean; run: Run }) {
  const [identity, setIdentity] = useState('')
  const [compared, setCompared] = useState<Set<string>>(() => new Set())

  async function requestPair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await run('Sending the relay pairing request…', async () => {
      await window.sct.requestRelayPair(identity)
      setIdentity('')
      return 'The relay pairing request was sent.'
    })
  }

  return (
    <section className="panel" aria-labelledby="relay-pair-heading">
      <h2 id="relay-pair-heading">Pair relay devices</h2>
      <p>Enter the relay ID from the other device. Compare the code on both screens before confirmation.</p>
      <form onSubmit={(event) => { void requestPair(event) }}>
        <fieldset disabled={busy || state.connection !== 'connected'}>
          <label htmlFor="relay-peer-identity">Other device’s relay ID</label>
          <input id="relay-peer-identity" name="relayPeerIdentity" autoComplete="off" spellCheck="false"
            value={identity} minLength={64} maxLength={64} pattern="[0-9a-f]{64}" required
            onChange={(event) => setIdentity(event.target.value.trim().toLowerCase())} />
          <div className="form-actions">
            <button type="submit" disabled={busy || identity.length !== 64}>Request pairing</button>
          </div>
        </fieldset>
      </form>
      {state.peers.length === 0 ? <p className="field-help">No relay devices are paired.</p> : (
        <ul className="relay-peers" aria-label="Relay devices">
          {state.peers.map((peer) => <li key={peer.pairId}>
            <div className="relay-peer-heading">
              <div><h3>{peer.name}</h3><p>{relayPeerState(peer)}</p></div>
              <button type="button" className="secondary" disabled={busy} onClick={() => {
                void run('Removing the relay pair…', async () => {
                  await window.sct.removeRelayPair(peer.pairId)
                  return `${peer.name} was removed from relay sharing.`
                })
              }}>Remove</button>
            </div>
            {/* Saved keys can outlive a relay pair, so both devices show the code again while the pair is pending. */}
            {peer.code && (peer.trust !== 'verified' || peer.status === 'Pending') && <div className="relay-code">
              <p aria-label={`Pairing code for ${peer.name}`}>{peer.code}</p>
              <label className="check-field">
                <input type="checkbox" checked={compared.has(peer.pairId)} onChange={(event) => setCompared((current) => {
                  const next = new Set(current)
                  if (event.target.checked) next.add(peer.pairId)
                  else next.delete(peer.pairId)
                  return next
                })} />
                I compared this code on both devices
              </label>
              <button type="button" disabled={busy || !compared.has(peer.pairId)} onClick={() => {
                void run('Saving the verified relay device…', async () => {
                  await window.sct.confirmRelayPair({ pairId: peer.pairId, code: peer.code ?? '' })
                  return `${peer.name} is verified for relay sharing.`
                })
              }}>Confirm relay device</button>
            </div>}
          </li>)}
        </ul>
      )}
    </section>
  )
}

function relayPeerState(peer: RelayPeer): string {
  if (peer.trust === 'changed') return 'Keys changed. Compare a new code before sharing.'
  if (peer.trust === 'invalid') return 'The device keys are invalid.'
  if (peer.trust === 'verified' && peer.status === 'Verified') return 'Verified recipient'
  return peer.requestedByMe ? 'Waiting for the other device' : 'Pairing request received'
}

function RelaySend({ projectId, projects, secrets, state, busy, run }: {
  projectId?: string
  projects: Loaded<Project[]>
  secrets: Loaded<SecretMetadata[]>
  state: RelayState
  busy: boolean
  run: Run
}) {
  const recipients = state.peers.filter((peer) => peer.status === 'Verified' && peer.trust === 'verified')
  const [source, setSource] = useState(projectId ?? '')
  const [recipient, setRecipient] = useState(recipients.length === 1 ? recipients[0]?.identity ?? '' : '')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [accessExpiresAt, setAccessExpiresAt] = useState('')
  const [injectionOnly, setInjectionOnly] = useState(true)
  const [handoff, setHandoff] = useState<RelayHandoffState | null>(null)

  async function queue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const sent = {
      recipient: recipients.find((peer) => peer.identity === recipient)?.name ?? 'the recipient',
      names: selectedNames(secrets, selected)
    }
    setHandoff({ stage: 'prepare', messageId: '', ...sent })
    const queued = await run('Encrypting and saving the relay transfer…', async () => {
      const messageId = await window.sct.queueRelayTransfer({
        projectId: source,
        secretIds: [...selected],
        recipient,
        accessExpiresAt: accessExpiresAt ? new Date(accessExpiresAt).getTime() : null,
        injectionOnly
      })
      setHandoff({ stage: 'wait', messageId, ...sent })
      setSelected(new Set())
      return 'The encrypted transfer is queued on this device.'
    })
    if (!queued) setHandoff(null)
  }

  return (
    <section className="panel" aria-labelledby="relay-send-heading">
      <h2 id="relay-send-heading">Queue a relay transfer</h2>
      {handoff && <RelayHandoff handoff={handoff} sent={state.sent} onDone={() => setHandoff(null)} />}
      {recipients.length === 0 && <p>Verify a relay device before you queue secrets.</p>}
      {projects.state === 'ready' && projects.value.length === 0 && <p><a href="#/">Add a project</a> to store and share secrets.</p>}
      {recipients.length > 0 && projects.state === 'ready' && projects.value.length > 0 && <form onSubmit={(event) => { void queue(event) }}>
        <fieldset disabled={busy}>
          <label htmlFor="relay-project">Source project</label>
          <select id="relay-project" value={source} required onChange={(event) => {
            setSource(event.target.value)
            setSelected(new Set())
          }}>
            <option value="">Choose a project</option>
            {projects.value.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <label htmlFor="relay-recipient">Verified relay recipient</label>
          <select id="relay-recipient" value={recipient} required onChange={(event) => setRecipient(event.target.value)}>
            <option value="">Choose a verified device</option>
            {recipients.map((peer) => <option key={peer.identity} value={peer.identity}>{peer.name}</option>)}
          </select>
          <SecretSelection secrets={secrets} source={source} selected={selected} onChange={setSelected} />
          <label htmlFor="relay-access-expires">Access expires (optional)</label>
          <input id="relay-access-expires" name="accessExpiresAt" type="datetime-local" value={accessExpiresAt}
            onChange={(event) => setAccessExpiresAt(event.target.value)} />
          <label className="check-field">
            <input type="checkbox" checked={injectionOnly} onChange={(event) => setInjectionOnly(event.target.checked)} />
            Allow command injection only. Block reveal, copy, and reshare.
          </label>
          <p className="field-help">Queued transfers stay encrypted on this device. Secret values never enter this screen.</p>
          <div className="form-actions">
            <button type="submit" disabled={busy || !source || !recipient || selected.size === 0}>Queue encrypted transfer</button>
          </div>
        </fieldset>
      </form>}
    </section>
  )
}

interface RelayHandoffState {
  stage: 'prepare' | 'wait'
  messageId: string
  recipient: string
  names: string[]
}

// The relay state drives the last stage. A failed or expired transfer closes the modal, and the activity table shows why.
function RelayHandoff({ handoff, sent, onDone }: { handoff: RelayHandoffState; sent: RelaySentItem[]; onDone: () => void }) {
  const delivery = sent.find((item) => item.messageId === handoff.messageId)?.state
  if (delivery === 'failed' || delivery === 'expired') return null
  return (
    <HandoffModal heading={`Sending secrets to ${handoff.recipient}`} via="relay" from="This device" to={handoff.recipient}
      stage={delivery === 'received' ? 'delivered' : handoff.stage} onDone={onDone} object={{
        shape: 'key',
        title: secretCount(handoff.names.length),
        detail: <Scramble text={handoff.names.join(' ')} mode="encrypt" />
      }} />
  )
}

function RelayActivity({ state, projects, busy, run, updateProjects, updateSecrets, onImported }: {
  state: RelayState
  projects: Loaded<Project[]>
  busy: boolean
  run: Run
  updateProjects: UpdateProjects
  updateSecrets: UpdateSecrets
  onImported: (imported: ImportedTransfer) => void
}) {
  const cached = state.connection !== 'connected'
  const empty = state.sent.length === 0 && state.inbox.length === 0 && state.tasks.length === 0
  return (
    <section className="relay-activity" aria-labelledby="relay-activity-heading">
      <div className="group-heading">
        <h2 id="relay-activity-heading">Delivery activity</h2>
        {cached && <span>Cached status</span>}
        {!empty && <button type="button" className="secondary" disabled={busy} onClick={() => {
          void run('Deleting all activity…', async () => {
            await window.sct.hideAllRelayActivity()
            return 'All activity was deleted from this list. A row that changes state shows again.'
          })
        }}>Delete all</button>}
      </div>
      {empty ? (
        <div className="empty-state compact"><p>No relay delivery activity is saved on this device.</p></div>
      ) : <>
        {state.sent.length > 0 && <table>
          <caption>Sent transfers</caption>
          <thead><tr><th scope="col">Transfer</th><th scope="col">Recipient</th><th scope="col">Delivery</th>
            <th scope="col">Receipt</th><th scope="col">Delivery deadline</th><th scope="col">Recipient access</th><th scope="col">Remote demo</th>
            <th scope="col"><span className="sr-only">Delete</span></th></tr></thead>
          <tbody>{state.sent.map((item) => <RelayActivityRow key={`${item.messageId}/${item.recipient}`} item={item} state={state}
            busy={busy} run={run} />)}</tbody>
        </table>}
        {state.tasks.length > 0 && <div className="relay-inbox">
          <h3>Remote demo runs</h3>
          <ul>{state.tasks.map((task) => <RelayTask key={`${task.direction}/${task.messageId}`} task={task} state={state} busy={busy} run={run} />)}</ul>
        </div>}
        {state.inbox.length > 0 && <div className="relay-inbox">
          <h3>Received transfers</h3>
          <ul>{state.inbox.map((item) => <RelayInboxTransfer key={item.messageId} item={item} state={state}
            projects={projects} busy={busy} run={run} updateProjects={updateProjects} updateSecrets={updateSecrets}
            onImported={onImported} />)}</ul>
        </div>}
      </>}
    </section>
  )
}

function RelayInboxTransfer({ item, state, projects, busy, run, updateProjects, updateSecrets, onImported }: {
  item: RelayInboxItem
  state: RelayState
  projects: Loaded<Project[]>
  busy: boolean
  run: Run
  updateProjects: UpdateProjects
  updateSecrets: UpdateSecrets
  onImported: (imported: ImportedTransfer) => void
}) {
  const sender = peerName(state, item.sender)
  return <li>
    <div className="relay-inbox-heading">
      <div>
        <h4>{item.projectName ?? 'Unreadable transfer'}</h4>
        <p>From {sender}. Transfer <code>{shortId(item.messageId)}</code>.</p>
      </div>
      <span className="delivery-state" data-state={item.state}>{item.state}</span>
    </div>
    {item.secretNames.length > 0 && <p>{item.secretNames.join(', ')}</p>}
    <p className="field-help">Deliver before {formatTime(item.deliverBy)}. {grantText(item)}</p>
    {item.error && <p className="error" role="alert">{item.error}</p>}
    <RelayInboxAction item={item} sender={sender} projects={projects} busy={busy} run={run} updateProjects={updateProjects}
      updateSecrets={updateSecrets} onImported={onImported} />
    {relayInboxFinished(item) && <div className="form-actions">
      <DeleteActivity activity={{ kind: 'inbox', messageId: item.messageId, peer: item.sender }}
        label={`Delete transfer ${shortId(item.messageId)}`} busy={busy} run={run} />
    </div>}
  </li>
}

function RelayInboxAction({ item, sender, projects, busy, run, updateProjects, updateSecrets, onImported }: {
  item: RelayInboxItem
  sender: string
  projects: Loaded<Project[]>
  busy: boolean
  run: Run
  updateProjects: UpdateProjects
  updateSecrets: UpdateSecrets
  onImported: (imported: ImportedTransfer) => void
}) {
  if (item.state === 'received' && item.receivedAt) return <p className="field-help">
    Imported {formatTime(item.receivedAt)}. The receipt confirms durable delivery.
  </p>
  if (item.state !== 'pending' || projects.state !== 'ready') return null
  return <RelayImportForm item={item} sender={sender} projects={projects.value} busy={busy} run={run} updateProjects={updateProjects}
    updateSecrets={updateSecrets} onImported={onImported} />
}

// Project IDs are UUIDs, so this select value cannot match a project.
const newProject = 'new'

function RelayImportForm({ item, sender, projects, busy, run, updateProjects, updateSecrets, onImported, onLater }: {
  item: RelayInboxItem
  sender: string
  projects: Project[]
  busy: boolean
  run: Run
  updateProjects: UpdateProjects
  updateSecrets: UpdateSecrets
  onImported: (imported: ImportedTransfer) => void
  onLater?: () => void
}) {
  const [destination, setDestination] = useState(item.destinationProjectId
    ?? (projects.length === 0 ? newProject : projects.length === 1 ? projects[0]?.id ?? '' : ''))
  const [name, setName] = useState(item.projectName ?? '')
  const [directory, setDirectory] = useState('')
  const creating = destination === newProject

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await run('Verifying and importing the relay transfer…', async () => {
      const project = creating ? await addProject() : projects.find((saved) => saved.id === destination)
      if (!project) throw new Error('Choose a destination project.')
      const saved = await window.sct.acceptRelayTransfer({ messageId: item.messageId, projectId: project.id })
      updateSecrets((current) => [...current.filter((secret) => !saved.some((added) => added.id === secret.id)), ...saved])
      onImported({ sender, project: project.name, names: saved.map((secret) => secret.name) })
      return `Imported ${saved.length} ${saved.length === 1 ? 'secret' : 'secrets'}. The encrypted receipt is saved.`
    })
  }

  // A failed import keeps the new project selected, so a retry does not add the project again.
  async function addProject(): Promise<Project> {
    const project = await window.sct.addProject({ name, directory })
    updateProjects((current) => [...current, project])
    setDestination(project.id)
    return project
  }

  async function browse() {
    await run('Opening the folder picker…', async () => {
      const selected = await window.sct.pickDirectory()
      if (!selected) return ''
      setDirectory(selected)
      if (!name.trim()) setName(selected.split('/').filter(Boolean).at(-1) ?? 'Project')
      return ''
    })
  }

  return <form onSubmit={(event) => { void accept(event) }}>
      <fieldset disabled={busy}>
        <label htmlFor={`relay-destination-${item.messageId}`}>Destination project</label>
        <select id={`relay-destination-${item.messageId}`} value={destination} required
          onChange={(event) => setDestination(event.target.value)}>
          <option value="">Choose a project</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          <option value={newProject}>New project</option>
        </select>
        {creating && <>
          <label htmlFor={`relay-project-name-${item.messageId}`}>Project name</label>
          <input id={`relay-project-name-${item.messageId}`} value={name} maxLength={100} required placeholder="My project"
            onChange={(event) => setName(event.target.value)} />
          <label htmlFor={`relay-project-directory-${item.messageId}`}>Folder path</label>
          <div className="folder-field">
            <input id={`relay-project-directory-${item.messageId}`} value={directory} maxLength={4096} required
              placeholder="/Users/you/projects/my-project" onChange={(event) => setDirectory(event.target.value)} />
            <button type="button" className="secondary" onClick={() => { void browse() }}>Choose folder…</button>
          </div>
        </>}
        <div className="form-actions">
          {onLater && <button type="button" className="secondary" onClick={onLater}>Later</button>}
          <button type="submit" disabled={busy || !destination || (creating && (!name.trim() || !directory.trim()))}>
            Import and send receipt
          </button>
        </div>
      </fieldset>
    </form>
}

// Deletes a finished row from this list only. The local record stays, so duplicate checks and grants still work.
function DeleteActivity({ activity, label, busy, run }: { activity: RelayActivityKey; label: string; busy: boolean; run: Run }) {
  return <button type="button" className="secondary" aria-label={label} disabled={busy} onClick={() => {
    void run('Deleting the activity…', async () => {
      await window.sct.hideRelayActivity(activity)
      return 'The activity was deleted from this list.'
    })
  }}>Delete</button>
}

function grantText(item: RelayInboxItem): string {
  const use = item.injectionOnly ? 'Injection only.' : 'Resharing is allowed.'
  return item.accessExpiresAt ? `${use} Access expires ${formatTime(item.accessExpiresAt)}.` : `${use} Access does not expire.`
}

// The recipient approves or refuses on its own device. Only this window can send that decision.
function RelayTask({ task, state, busy, run }: { task: RelayTaskItem; state: RelayState; busy: boolean; run: Run }) {
  const peer = peerName(state, task.peer)
  const decide = (decision: RelayTaskDecision['decision'], pending: string, done: string) => {
    if (!task.digest) return
    const input = { messageId: task.messageId, digest: task.digest, decision }
    void run(pending, async () => {
      await window.sct.respondRelayTask(input)
      return done
    })
  }
  return <li>
    <div className="relay-inbox-heading">
      <div>
        <h4>{task.direction === 'sent' ? `Fixed demo on ${peer}` : `${peer} asks to run the fixed demo`}</h4>
        <p>Task <code>{shortId(task.messageId)}</code> with grant <code>{task.grantId ? shortId(task.grantId) : 'unknown'}</code>.</p>
      </div>
      <span className="delivery-state" data-state={task.state}>{task.state.replace('-', ' ')}</span>
    </div>
    {task.projectName && <p>{task.projectName}: {task.secretNames.join(', ')}</p>}
    <p className="field-help">{relayTaskText(task)}</p>
    {task.error && <p className="error" role="alert">{task.error}</p>}
    {task.direction === 'received' && task.state === 'awaiting-approval' && <div className="form-actions">
      <button type="button" className="secondary" disabled={busy}
        onClick={() => decide('refuse', 'Refusing the task…', 'The task was refused. global.sct sends the refusal.')}>Refuse</button>
      <button type="button" disabled={busy}
        onClick={() => decide('approve', 'Running the fixed demo…', 'The run finished. global.sct sends the result.')}>Approve once</button>
    </div>}
    {task.reviewRequired && <>
      <p>The app stopped during this run. global.sct cannot know whether the demo finished. It does not run this task again.</p>
      <div className="form-actions">
        <button type="button" disabled={busy}
          onClick={() => decide('report', 'Saving the review…', 'The uncertain result is queued for the sender.')}>Send uncertain result</button>
      </div>
    </>}
    {relayTaskFinished(task) && <div className="form-actions">
      <DeleteActivity activity={{ kind: 'task', messageId: task.messageId, peer: task.peer }}
        label={`Delete task ${shortId(task.messageId)}`} busy={busy} run={run} />
    </div>}
  </li>
}

function relayTaskText(task: RelayTaskItem): string {
  const outcome = task.exitCode === null ? '' : ` Exit code ${task.exitCode}. SCT_DEMO_TOKEN ${task.secretPresent ? 'was' : 'was not'} present.`
  if (task.direction === 'sent') {
    if (task.state === 'delivered') return `The other device saved the task. Approval is due by ${formatTime(task.approveBy)}.`
    return task.finishedAt ? `Result from ${formatTime(task.finishedAt)}.${outcome}` : `Approval is due by ${formatTime(task.approveBy)}.`
  }
  if (task.state === 'awaiting-approval') return `Approve by ${formatTime(task.approveBy)}. The run injects only these grant secrets and returns no output.`
  const reply = task.reply === 'none' ? 'The result is not queued.' : `Result delivery: ${task.reply}.`
  return task.finishedAt ? `Finished ${formatTime(task.finishedAt)}.${outcome} ${reply}` : reply
}

function RelayActivityRow({ item, state, busy, run }: { item: RelaySentItem; state: RelayState; busy: boolean; run: Run }) {
  const usable = item.state === 'received' && !item.accessExpiredAt && (!item.accessExpiresAt || Date.parse(item.accessExpiresAt) > Date.now())
  return <tr>
    <td><code>{shortId(item.messageId)}</code></td>
    <td>{peerName(state, item.recipient)}</td>
    <td>
      <span className="delivery-state" data-state={item.state}>{item.state}</span>
      {item.error && <span className="delivery-error">{item.error}</span>}
    </td>
    <td>{relayReceiptText(item)}</td>
    <td>{item.deliverBy ? formatTime(item.deliverBy) : 'Not cached'}</td>
    <td>{relayAccessText(item)}</td>
    <td>{usable ? <button type="button" className="secondary" disabled={busy || state.connection !== 'connected'} onClick={() => {
      void run('Encrypting and saving the task…', async () => {
        await window.sct.queueRelayTask(item.messageId)
        return `The task is queued. ${peerName(state, item.recipient)} must approve it on that device.`
      })
    }}>Request run</button> : 'Not available'}</td>
    <td>{relaySentFinished(item) && <DeleteActivity activity={{ kind: 'sent', messageId: item.messageId, peer: item.recipient }}
      label={`Delete transfer ${shortId(item.messageId)}`} busy={busy} run={run} />}</td>
  </tr>
}

function relayReceiptText(item: RelaySentItem): string {
  if (item.receiptState.state === 'received') return 'Verified'
  if (item.receiptState.state === 'pending') return 'Waiting'
  if (item.receiptState.state === 'expired') return 'Expired'
  return 'Failed'
}

function relayAccessText(item: RelaySentItem): string {
  if (item.accessExpiredAt) return `Expired and removed ${formatTime(item.accessExpiredAt)}`
  if (!item.accessExpiresAt) return 'Does not expire'
  return Date.parse(item.accessExpiresAt) <= Date.now()
    ? `Expired ${formatTime(item.accessExpiresAt)}. Waiting for cleanup notice.`
    : `Expires ${formatTime(item.accessExpiresAt)}`
}

function peerName(state: RelayState, identity: string): string {
  return state.peers.find((peer) => peer.identity === identity)?.name ?? shortId(identity)
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString()
}

function SendSecrets({ projectId, active, projects, secrets, peers, busy, run }: {
  projectId?: string
  active: boolean
  projects: Loaded<Project[]>
  secrets: Loaded<SecretMetadata[]>
  peers: SharingDevice[]
  busy: boolean
  run: Run
}) {
  const source = projectId ?? ''
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [recipient, setRecipient] = useState(peers.length === 1 ? peers[0]?.id ?? '' : '')
  const [handoff, setHandoff] = useState<{ stage: HandoffStage; names: string[]; recipient: string } | null>(null)
  const projectField = useRef<HTMLSelectElement>(null)
  const recipientField = useRef<HTMLSelectElement>(null)

  useEffect(() => {
    if (!active) return
    if (projectId) recipientField.current?.focus()
    else projectField.current?.focus()
  }, [active, projectId])

  const recipientName = peers.find((peer) => peer.id === recipient)?.name ?? 'their device'

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const sent = { names: selectedNames(secrets, selected), recipient: recipientName }
    setHandoff({ stage: 'wait', ...sent })
    const shared = await run(`Encrypting the secrets. Choose ${recipientName} in the picker.`, async () => {
      await window.sct.shareSecrets({ projectId: source, secretIds: [...selected], recipientId: recipient })
      return `If you chose ${recipientName}, the encrypted secrets are on their way. Their app confirms import.`
    })
    setHandoff(shared ? { stage: 'handed', ...sent } : null)
  }

  return (
    <section className="panel" aria-labelledby="send-heading">
      <h2 id="send-heading">Send secrets</h2>
      {projects.state === 'loading' && <p role="status">Loading projects…</p>}
      {projects.state === 'ready' && projects.value.length === 0 && <p><a href="#/">Add a project</a> to store and send secrets.</p>}
      {projects.state === 'ready' && projects.value.length > 0 && (
        <form onSubmit={(event) => { void send(event) }}>
          <fieldset disabled={busy}>
            <label htmlFor="sharing-project">Source project</label>
            <select ref={projectField} id="sharing-project" value={source} required onChange={(event) => {
              window.location.hash = sharingRoute('secrets', event.target.value)
            }}>
              <option value="">Choose a project</option>
              {projects.value.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <label htmlFor="sharing-recipient">Verified recipient</label>
            <select ref={recipientField} id="sharing-recipient" value={recipient} required onChange={(event) => setRecipient(event.target.value)}>
              <option value="">Choose a verified device</option>
              {peers.map((peer) => <option key={peer.id} value={peer.id}>{peer.name}</option>)}
            </select>
            <SecretSelection secrets={secrets} source={source} selected={selected} onChange={setSelected} />
            <p className="field-help">Choose the same device in the picker. Only that device can open the secrets and choose a destination project.</p>
            <div className="form-actions">
              <button type="submit" disabled={!source || !recipient || selected.size === 0}>
                {busy ? 'Please wait…' : 'Send to…'}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {handoff && <HandoffModal heading={`Sending secrets to ${handoff.recipient}`} from="This device" to={handoff.recipient}
        stage={handoff.stage} onDone={() => setHandoff(null)} object={{
          shape: 'key',
          title: secretCount(handoff.names.length),
          detail: <Scramble text={handoff.names.join(' ')} mode="encrypt" />
        }} />}
    </section>
  )
}

function DeviceVerification({ projectId, device, peers, busy, run, isMac, initialLink, onDismissLink, onVerified }: {
  projectId?: string
  device: SharingDevice
  peers: SharingDevice[]
  busy: boolean
  run: Run
  isMac: boolean
  initialLink?: string
  onDismissLink?: () => void
  onVerified: (device: SharingDevice) => void
}) {
  const [pairing, setPairing] = useState<PairingPreview | null>(null)
  const [compared, setCompared] = useState(false)
  const [link, setLink] = useState(initialLink ?? '')
  const [cardStage, setCardStage] = useState<HandoffStage | null>(null)
  const importButton = useRef<HTMLButtonElement>(null)
  const comparisonHeading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (pairing) comparisonHeading.current?.focus()
  }, [pairing])

  async function shareCard() {
    setCardStage('wait')
    const shared = await run('Choose their Mac in the picker.', async () => {
      await window.sct.shareDeviceCard()
      return 'If you chose their Mac, your public device card is on its way. Ask them to send their card back.'
    })
    setCardStage(shared ? 'handed' : null)
  }

  async function addPeer() {
    await run('Reading the device card…', async () => {
      setPairing(await window.sct.pickSharingPeer())
      setCompared(false)
      return ''
    })
  }

  async function pastePeer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await run('Reading the pairing link…', async () => {
      setPairing(await window.sct.previewPairingLink(link))
      setCompared(false)
      return ''
    })
  }

  async function confirmPeer() {
    if (!pairing) return
    await run('Saving the verified device…', async () => {
      const verified = await window.sct.confirmSharingPeer(pairing.token)
      onVerified(verified)
      onDismissLink?.()
      setPairing(null)
      setCompared(false)
      return `${verified.name} is verified on this device.`
    })
  }

  return (
    <>
      {peers.length > 0 && <section className="sharing-verified" aria-labelledby="verified-heading">
        <div className="group-heading">
          <h2 id="verified-heading">Verified devices</h2>
          {isMac && <a className="button-link" href={sharingRoute('secrets', projectId)}>Continue to Send secrets</a>}
        </div>
        <ul className="sharing-peers" aria-label="Verified devices">
          {peers.map((peer) => <li key={peer.id}>
            <details className="sharing-details">
              <summary>{peer.name}</summary>
              <p className="sharing-fingerprint">{peer.fingerprint}</p>
            </details>
          </li>)}
        </ul>
      </section>}
      <section className="panel" aria-labelledby="devices-heading">
      <h2 id="devices-heading">{peers.length === 0 ? 'Verify your first device' : 'Verify another device'}</h2>
      <p>Exchange public device cards by link or file. Pairing needs no relay.</p>
      <ol className="sharing-setup">
        <li>
          <h3>Send your device card</h3>
          <p>Your card contains public keys only. Send the link or saved file to the other device.</p>
          <div className="form-actions">
            <button type="button" disabled={busy} onClick={() => {
              void run('Copying the pairing link…', async () => {
                await window.sct.copyPairingLink()
                return 'Pairing link copied. Send it to the other device.'
              })
            }}>Copy pairing link</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => {
              void run('Choose where to save your device card.', async () =>
                await window.sct.saveDeviceCard() ? 'Device card saved. Send it to the other device.' : '')
            }}>Save device card…</button>
            {isMac && <button type="button" className="secondary" disabled={busy}
              onClick={() => { void shareCard() }}>Send my card to…</button>}
          </div>
          {cardStage && <HandoffModal heading="Sending your device card" from="This device" to="Their Mac" stage={cardStage}
            onDone={() => setCardStage(null)} object={{ shape: 'device', name: device.name, fingerprint: device.fingerprint }} />}
        </li>
        <li>
          <h3>Import their device card</h3>
          <form onSubmit={(event) => { void pastePeer(event) }}>
            <fieldset disabled={busy}>
              <label htmlFor="pairing-link">Paste pairing link</label>
              <input id="pairing-link" value={link} maxLength={pairingLinkLimit} required spellCheck={false}
                autoComplete="off" onChange={(event) => setLink(event.target.value)} />
              <div className="form-actions">
                <button type="submit" className="secondary" disabled={!link}>Review pairing link</button>
              </div>
            </fieldset>
          </form>
          <p>Or choose their .sct-device file.</p>
          <button ref={importButton} type="button" className="secondary" disabled={busy}
            onClick={() => { void addPeer() }}>Import .sct-device file…</button>
        </li>
      </ol>
      {pairing && (
        <div className="pairing-review" aria-labelledby="pairing-heading">
          <h3 ref={comparisonHeading} tabIndex={-1} id="pairing-heading">Compare codes with {pairing.device.name}</h3>
          <p className="pairing-code" aria-label="Pairing code">{pairing.code}</p>
          <p className="field-help">Have them import your card too. Both devices must show this exact code before either person confirms.</p>
          <label className="check-field">
            <input type="checkbox" checked={compared} disabled={busy} onChange={(event) => setCompared(event.target.checked)} />
            I compared this code on both devices
          </label>
          <div className="form-actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => {
              onDismissLink?.()
              setPairing(null)
              setCompared(false)
              importButton.current?.focus()
            }}>Cancel verification</button>
            <button type="button" disabled={busy || !compared} onClick={() => { void confirmPeer() }}>Confirm recipient</button>
          </div>
        </div>
      )}
      {isMac && <details className="sharing-details">
        <summary>Their Mac is not in the picker?</summary>
        <p>On both Macs, turn on Wi-Fi and Bluetooth. In Finder, open AirDrop and allow discovery by Everyone.</p>
      </details>}
      <details className="sharing-details">
        <summary>This device’s details</summary>
        <p>{device.name}</p>
        <p className="path sharing-fingerprint">{device.fingerprint}</p>
      </details>
      </section>
    </>
  )
}

function ReceiveSecrets({ device, incoming, canImport, receipt, projects, location, busy, run, updateSecrets, setReceipt, update }: {
  device: SharingDevice
  incoming: TransferPreview[]
  canImport: boolean
  receipt: Receipt | null
  projects: Loaded<Project[]>
  location: string
  busy: boolean
  run: Run
  updateSecrets: UpdateSecrets
  setReceipt: (receipt: Receipt) => void
  update: (change: (incoming: TransferPreview[]) => TransferPreview[]) => void
}) {
  // The arrival modal shows one time for each receipt.
  const [closedReceipt, setClosedReceipt] = useState<string | null>(null)

  async function chooseFile() {
    await run('Reading the received file…', async () => {
      const transfer = await window.sct.pickTransfer()
      if (!transfer) return ''
      update((current) => [...current.filter((item) => item.id !== transfer.id), transfer])
      return 'Choose a project for these secrets.'
    })
  }

  return (
    <>
      {receipt && <section key={receipt.id} className="panel" aria-labelledby="receipt-heading">
        <h2 id="receipt-heading">Received from {receipt.sender}</h2>
        <ul className="sharing-names" aria-label={`Secrets imported into ${receipt.project}`}>
          {receipt.names.map((name) => <li key={name}><Scramble text={name} mode="decrypt" /></li>)}
        </ul>
      </section>}
      {receipt && closedReceipt !== receipt.id && <HandoffModal heading={`Receiving from ${receipt.sender}`}
        from={receipt.sender} to={receipt.project} stage="arrived" onDone={() => setClosedReceipt(receipt.id)} object={{
          shape: 'key',
          title: secretCount(receipt.names.length),
          detail: receipt.names.join(' ')
        }} />}
      {incoming.length > 0 && <section className="sharing-section" aria-labelledby="incoming-heading">
        <h2 id="incoming-heading">Received transfers</h2>
        {incoming.map((transfer) => (
          <IncomingTransfer key={transfer.id} transfer={transfer} projects={projects} location={location}
            busy={busy} run={run} updateSecrets={updateSecrets} setReceipt={setReceipt}
            remove={() => update((current) => current.filter((item) => item.id !== transfer.id))} />
        ))}
      </section>}
      <section className="panel" aria-labelledby="receive-heading">
        <h2 id="receive-heading">Receive secrets</h2>
        {!canImport && <p className="field-help">Verify the sender’s device before you import their secrets.</p>}
        <ol className="sharing-setup">
          <li>
            <h3>Ask them to send to this device</h3>
            <p>They choose {device.name} in the picker. Accept the file when the system asks.</p>
          </li>
          <li>
            <h3>Open the received file</h3>
            <p>The file name ends in .sct-transfer.</p>
            <button type="button" className={incoming.length > 0 ? 'secondary' : undefined} disabled={busy}
              onClick={() => { void chooseFile() }}>Choose received file…</button>
          </li>
          <li>
            <h3>Choose a project</h3>
            <p>The secrets appear on this tab. Choose the local project that keeps them.</p>
          </li>
        </ol>
      </section>
    </>
  )
}

function IncomingTransfer({ transfer, projects, location, busy, run, updateSecrets, setReceipt, remove }: {
  transfer: TransferPreview
  projects: Loaded<Project[]>
  location: string
  busy: boolean
  run: Run
  updateSecrets: UpdateSecrets
  setReceipt: (receipt: Receipt) => void
  remove: () => void
}) {
  const [destination, setDestination] = useState('')
  const project = projects.state === 'ready' ? projects.value.find((item) => item.id === destination) : undefined

  async function receive(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await run('Importing the encrypted transfer…', async () => {
      const imported = await window.sct.importTransfer({ transferId: transfer.id, projectId: destination })
      updateSecrets((current) => [...current.filter((secret) => !imported.some((saved) => saved.id === secret.id)), ...imported])
      setReceipt({ id: transfer.id, sender: transfer.sender.name, project: project?.name ?? 'the selected project', names: imported.map((secret) => secret.name) })
      remove()
      return `Imported ${imported.length} ${imported.length === 1 ? 'secret' : 'secrets'} into ${project?.name ?? 'the selected project'}.`
    })
  }

  return (
    <section className="panel" aria-labelledby={`transfer-${transfer.id}`}>
      <h3 id={`transfer-${transfer.id}`}>From {transfer.sender.name}</h3>
      <p className="field-help">Source project: {transfer.projectName}. Import before {new Date(transfer.expiresAt).toLocaleString()}.</p>
      <ul className="sharing-names" aria-label={`Received secrets from ${transfer.projectName}`}>
        {transfer.secretNames.map((name) => <li key={name}>{name}</li>)}
      </ul>
      {projects.state === 'ready' && projects.value.length === 0 && <p><a href="#/">Add a local project</a> before you import these secrets.</p>}
      <form onSubmit={(event) => { void receive(event) }}>
        <fieldset disabled={busy || projects.state !== 'ready'}>
          <label htmlFor={`destination-${transfer.id}`}>Destination project</label>
          <select id={`destination-${transfer.id}`} value={destination} required onChange={(event) => setDestination(event.target.value)}>
            <option value="">Choose a local project</option>
            {projects.state === 'ready' && projects.value.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          {project && <p className="path sharing-destination">{location}/{project.name}/secrets.sct</p>}
          <p className="field-help">Existing secrets stay unchanged. If names conflict, choose another project or resolve the names before import.</p>
          <div className="form-actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => {
              void run('Removing the pending transfer…', async () => {
                await window.sct.dismissTransfer(transfer.id)
                remove()
                return 'The pending transfer was removed.'
              })
            }}>Dismiss transfer</button>
            <button type="submit" disabled={!project || busy}>Import secrets</button>
          </div>
        </fieldset>
      </form>
    </section>
  )
}
