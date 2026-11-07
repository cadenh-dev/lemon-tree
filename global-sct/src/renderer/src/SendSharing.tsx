import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Project } from '../../shared/projects'
import type { SecretMetadata } from '../../shared/secrets'
import type { SharingState } from '../../shared/sharing'
import type { DirectState } from '../../shared/direct'
import type { WebRtcState } from '../../shared/webrtc'
import type { RelayState } from '../../shared/relay'
import { errorText } from './operation'
import { SecretSelection } from './SecretSelection'
import type { Loaded, Run } from './types'

type SendMode = 'link' | 'direct' | 'webrtc' | 'mailbox'
type SendData = { sharing: SharingState; direct: DirectState; webrtc: WebRtcState; relay: RelayState }
type ModeOption = { value: SendMode; label: string; enabled: boolean }

// One send form chooses the mode from the sessions that are actually open. Mailbox needs explicit permission.
export function SendSharing({ active, projectId, projects, secrets, busy, run }: {
  active: boolean
  projectId?: string
  projects: Loaded<Project[]>
  secrets: Loaded<SecretMetadata[]>
  busy: boolean
  run: Run
}) {
  const [data, setData] = useState<Loaded<SendData>>({ state: 'loading' })

  useEffect(() => {
    if (!active) return
    let mounted = true
    const refresh = async () => {
      try {
        const [sharing, direct, webrtc, relay] = await Promise.all([
          window.sct.getSharingState(), window.sct.getDirectState(), window.sct.getWebRtcState(), window.sct.getRelayState()
        ])
        if (mounted) setData({ state: 'ready', value: { sharing, direct, webrtc, relay } })
      } catch (cause) {
        if (mounted) setData({ state: 'error', error: errorText(cause, 'Cannot read the delivery modes.') })
      }
    }
    const stops = [window.sct.onSharingChanged(refresh), window.sct.onDirectChanged(refresh),
      window.sct.onWebRtcChanged(refresh), window.sct.onRelayChanged(refresh)]
    void refresh()
    return () => { mounted = false; for (const stop of stops) stop() }
  }, [active])

  if (data.state === 'loading') return <p role="status">Loading delivery modes…</p>
  if (data.state === 'error') return <p className="error" role="alert">{data.error}</p>
  return <SendForm data={data.value} projectId={projectId} projects={projects} secrets={secrets} busy={busy} run={run} />
}

function SendForm({ data, projectId, projects, secrets, busy, run }: {
  data: SendData
  projectId?: string
  projects: Loaded<Project[]>
  secrets: Loaded<SecretMetadata[]>
  busy: boolean
  run: Run
}) {
  const [source, setSource] = useState(projectId ?? '')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [mode, setMode] = useState<SendMode | null>(null)
  const [recipient, setRecipient] = useState('')
  const [permitMailbox, setPermitMailbox] = useState(false)
  const [accessExpiresAt, setAccessExpiresAt] = useState('')
  const [injectionOnly, setInjectionOnly] = useState(true)
  const [createdLink, setCreatedLink] = useState<string | null>(null)
  const setup = sendSetup(data, permitMailbox)
  const isEnabled = (value: SendMode) => setup.modes.find((item) => item.value === value)?.enabled ?? false
  const chosenMode: SendMode = mode && isEnabled(mode) ? mode : setup.preferred
  const options = recipients(chosenMode, data, setup.directPeers, setup.webRtcPeer?.id, setup.relayPeers)
  const chosen = chooseRecipient(options, recipient)
  const canSend = canOpenSendForm(projects, data.sharing.peers.length > 0, setup.mailboxConfigured)

  function chooseMailbox(checked: boolean) {
    setPermitMailbox(checked)
    setMode(mailboxChoice(checked, chosenMode, setup) ?? mode)
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreatedLink(null)
    await run('Confirm the share with your vault passphrase…', async () => {
      const result = await performSend(chosenMode, {
        projectId: source, secretIds: [...selected], recipientId: chosen,
        accessExpiresAt: accessExpiresAt ? new Date(accessExpiresAt).getTime() : null, injectionOnly
      })
      setSelected(new Set())
      setCreatedLink(result.link)
      return result.message
    })
  }

  return <section className="panel" aria-labelledby="send-mode-heading">
    <h2 id="send-mode-heading">Send secrets</h2>
    <p>Choose a mode that is available now. Every send asks for your vault passphrase.</p>
    {projects.state === 'ready' && projects.value.length === 0 &&
      <p><a href="#/">Add a project</a> to store and send secrets.</p>}
    {data.sharing.peers.length === 0 && !setup.mailboxConfigured &&
      <p><a href="#/sharing/devices">Verify a device</a> before you send.</p>}
    {canSend && <form onSubmit={(event) => { void send(event) }}>
      <fieldset disabled={busy}>
        <ProjectField source={source} projects={projects} onChange={(value) => {
          setMode(chosenMode)
          setSource(value)
          setSelected(new Set())
        }} />
        <ModeFields modes={setup.modes} chosenMode={chosenMode} busy={busy} permitMailbox={permitMailbox}
          mailboxConfigured={setup.mailboxConfigured} relayPeerCount={setup.relayPeers.length}
          onMode={(value) => { setMode(value); setRecipient('') }} onMailbox={chooseMailbox} />
        <RecipientFields mode={chosenMode} options={options} chosen={chosen}
          onRecipient={(value) => { setMode(chosenMode); setRecipient(value) }} />
        <SecretSelection secrets={secrets} source={source} selected={selected}
          onChange={(next) => { setMode(chosenMode); setSelected(next) }} />
        <AccessFields accessExpiresAt={accessExpiresAt} injectionOnly={injectionOnly}
          onAccessExpiresAt={setAccessExpiresAt} onInjectionOnly={setInjectionOnly} />
        <div className="form-actions">
          <button type="submit" disabled={busy || !source || !chosen || selected.size === 0 || !isEnabled(chosenMode)}>Send secrets</button>
        </div>
      </fieldset>
    </form>}
    {createdLink && <CreatedLink link={createdLink} busy={busy} run={run} />}
  </section>
}

function ProjectField({ source, projects, onChange }: {
  source: string
  projects: Loaded<Project[]>
  onChange: (value: string) => void
}) {
  return <>
    <label htmlFor="send-source">Source project</label>
    <select id="send-source" value={source} required onChange={(event) => onChange(event.target.value)}>
      <option value="">Choose a project</option>
      {projects.state === 'ready' && projects.value.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
    </select>
  </>
}

function ModeFields({ modes, chosenMode, busy, permitMailbox, mailboxConfigured, relayPeerCount, onMode, onMailbox }: {
  modes: ModeOption[]
  chosenMode: SendMode
  busy: boolean
  permitMailbox: boolean
  mailboxConfigured: boolean
  relayPeerCount: number
  onMode: (mode: SendMode) => void
  onMailbox: (checked: boolean) => void
}) {
  return <>
    <fieldset className="mode-fieldset">
      <legend>Delivery mode</legend>
      {modes.filter((item) => item.enabled).map((item) => <label key={item.value} className="check-field">
        <input type="radio" name="sendMode" value={item.value} checked={chosenMode === item.value}
          onChange={() => onMode(item.value)} />
        {item.label}
      </label>)}
      {modes.every((item) => !item.enabled) && <p className="field-help">No delivery mode is available yet.</p>}
    </fieldset>
    {mailboxConfigured
      ? <label className="check-field">
        <input type="checkbox" checked={permitMailbox} disabled={busy || relayPeerCount === 0}
          onChange={(event) => onMailbox(event.target.checked)} />
        Allow an encrypted copy on the Mailbox server for this send.
      </label>
      : <p className="field-help">Mailbox needs a configured relay and a verified relay device.</p>}
  </>
}

function RecipientFields({ mode, options, chosen, onRecipient }: {
  mode: SendMode
  options: { value: string; label: string }[]
  chosen: string
  onRecipient: (value: string) => void
}) {
  return <>
    <label htmlFor="send-recipient">Recipient</label>
    <select id="send-recipient" value={chosen} required disabled={options.length === 0}
      onChange={(event) => onRecipient(event.target.value)}>
      <option value="">Choose a recipient</option>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    {mode === 'link' && <p className="field-help">A link has a 16,384-character limit. The app stops an oversized link before you share it.</p>}
    {mode === 'mailbox' && <p className="field-help">The Mailbox server stores one encrypted copy until the recipient imports it. Only choose this with the recipient’s agreement.</p>}
    {(mode === 'direct' || mode === 'webrtc') && options.length === 0 && <p className="field-help">
      Open an authenticated session in the <a href="#/sharing/direct">Direct</a> or <a href="#/sharing/webrtc">WebRTC</a> tab first.
    </p>}
  </>
}

function AccessFields({ accessExpiresAt, injectionOnly, onAccessExpiresAt, onInjectionOnly }: {
  accessExpiresAt: string
  injectionOnly: boolean
  onAccessExpiresAt: (value: string) => void
  onInjectionOnly: (checked: boolean) => void
}) {
  return <>
    <label htmlFor="send-access-expires">Access expires (optional)</label>
    <input id="send-access-expires" name="accessExpiresAt" type="datetime-local" value={accessExpiresAt}
      onChange={(event) => onAccessExpiresAt(event.target.value)} />
    <label className="check-field">
      <input type="checkbox" checked={injectionOnly} onChange={(event) => onInjectionOnly(event.target.checked)} />
      Allow command injection only. Block reveal, copy, and reshare.
    </label>
  </>
}

function CreatedLink({ link, busy, run }: { link: string; busy: boolean; run: Run }) {
  return <>
    <label htmlFor="send-link">Link</label>
    <textarea className="link-text" id="send-link" value={link} readOnly spellCheck={false} />
    <div className="form-actions"><button type="button" className="secondary" disabled={busy} onClick={() => {
      void run('Copying the link…', async () => {
        await window.sct.copyText(link)
        return 'Link copied.'
      })
    }}>Copy link</button></div>
  </>
}

function sendSetup(data: SendData, permitMailbox: boolean) {
  const directPeers = data.direct.peers.filter((peer) => peer.available)
  const webRtcPeer = data.webrtc.peers.find((peer) => peer.available)
  const relayPeers = data.relay.peers.filter((peer) => peer.status === 'Verified' && peer.trust === 'verified')
  const mailboxConfigured = data.relay.connection !== 'off' && data.relay.registered
  const mailboxAvailable = mailboxConfigured && relayPeers.length > 0
  const modes: ModeOption[] = [
    { value: 'direct', label: 'Direct', enabled: directPeers.length > 0 },
    { value: 'webrtc', label: 'WebRTC', enabled: webRtcPeer !== undefined },
    { value: 'link', label: 'Link', enabled: data.sharing.peers.length > 0 },
    { value: 'mailbox', label: 'Mailbox', enabled: mailboxAvailable && permitMailbox }
  ]
  const preferred: SendMode = directPeers.length > 0 ? 'direct' : webRtcPeer ? 'webrtc'
    : mailboxAvailable && permitMailbox ? 'mailbox' : 'link'
  return { directPeers, webRtcPeer, relayPeers, mailboxConfigured, modes, preferred }
}

function canOpenSendForm(projects: Loaded<Project[]>, hasPeers: boolean, mailboxConfigured: boolean): boolean {
  return projects.state === 'ready' && projects.value.length > 0 && (hasPeers || mailboxConfigured)
}

function chooseRecipient(options: { value: string }[], recipient: string): string {
  if (options.some((option) => option.value === recipient)) return recipient
  return options.length === 1 ? options[0]?.value ?? '' : ''
}

function mailboxChoice(checked: boolean, current: SendMode, setup: ReturnType<typeof sendSetup>): SendMode | null {
  if (checked && setup.directPeers.length === 0 && !setup.webRtcPeer) return 'mailbox'
  if (!checked && current === 'mailbox') return setup.preferred
  return null
}

async function performSend(mode: SendMode, input: {
  projectId: string
  secretIds: string[]
  recipientId: string
  accessExpiresAt: number | null
  injectionOnly: boolean
}): Promise<{ message: string; link: string | null }> {
  if (mode === 'link') {
    const record = await window.sct.createLink(input)
    return { message: 'The link is ready. Send it to the recipient.', link: record.link }
  }
  if (mode === 'direct') {
    await window.sct.sendDirect(input)
    return { message: 'The encrypted transfer is on its way. The recipient confirms the import.', link: null }
  }
  if (mode === 'webrtc') {
    await window.sct.sendWebRtc(input)
    return { message: 'The encrypted transfer is on its way over WebRTC.', link: null }
  }
  await window.sct.queueRelayTransfer({ projectId: input.projectId, secretIds: input.secretIds,
    recipient: input.recipientId, accessExpiresAt: input.accessExpiresAt, injectionOnly: input.injectionOnly })
  return { message: 'The encrypted transfer is queued for the Mailbox server.', link: null }
}

function recipients(mode: SendMode, data: SendData, directPeers: DirectState['peers'], webRtcId: string | undefined,
  relayPeers: RelayState['peers']): { value: string; label: string }[] {
  if (mode === 'mailbox') return relayPeers.map((peer) => ({ value: peer.identity, label: peer.name }))
  if (mode === 'webrtc') return webRtcId ? data.webrtc.peers.filter((peer) => peer.id === webRtcId)
    .map((peer) => ({ value: peer.id, label: peer.name })) : []
  if (mode === 'direct') return directPeers.map((peer) => ({ value: peer.id, label: peer.name }))
  return data.sharing.peers.map((peer) => ({ value: peer.id, label: peer.name }))
}
