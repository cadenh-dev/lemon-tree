import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { Project } from '../../shared/projects'
import type { SecretMetadata } from '../../shared/secrets'
import type { DirectImportResult, DirectSentItem, DirectState } from '../../shared/direct'
import { errorText } from './operation'
import { PendingReceipts } from './PendingReceipts'
import { SecretSelection } from './SecretSelection'
import type { Loaded, Run, UpdateSecrets } from './types'

export function DirectSharing({ active, projectId, projects, secrets, updateSecrets, busy, run }: {
  active: boolean
  projectId?: string
  projects: Loaded<Project[]>
  secrets: Loaded<SecretMetadata[]>
  updateSecrets: UpdateSecrets
  busy: boolean
  run: Run
}) {
  const [state, setState] = useState<Loaded<DirectState>>({ state: 'loading' })

  useEffect(() => {
    if (!active) return
    let mounted = true
    const refresh = () => {
      window.sct.getDirectState().then((value) => {
        if (mounted) setState({ state: 'ready', value })
      }).catch((cause: unknown) => {
        if (mounted) setState({ state: 'error', error: errorText(cause, 'Cannot read Direct sharing.') })
      })
    }
    const stop = window.sct.onDirectChanged(refresh)
    refresh()
    return () => { mounted = false; stop() }
  }, [active])

  const refresh = async () => setState({ state: 'ready', value: await window.sct.getDirectState() })

  return <>
    {state.state === 'loading' && <p role="status">Loading Direct sharing…</p>}
    {state.state === 'error' && <p className="error" role="alert">{state.error}</p>}
    {state.state === 'ready' && <>
      {state.value.error && <p className="error" role="alert">{state.value.error}</p>}
      <DirectSend projectId={projectId} projects={projects} secrets={secrets} peers={state.value.peers}
        busy={busy} run={run} refresh={refresh} />
      <DirectIncoming state={state.value} projects={projects} busy={busy} run={run}
        refresh={refresh} updateSecrets={updateSecrets} />
      <PendingReceipts receipts={state.value.receipts} busy={busy} run={run} />
      <DirectSent state={state.value} busy={busy} run={run} refresh={refresh} />
    </>}
  </>
}

function DirectSend({ projectId, projects, secrets, peers, busy, run, refresh }: {
  projectId?: string
  projects: Loaded<Project[]>
  secrets: Loaded<SecretMetadata[]>
  peers: DirectState['peers']
  busy: boolean
  run: Run
  refresh: () => Promise<void>
}) {
  const [source, setSource] = useState(projectId ?? '')
  const [recipient, setRecipient] = useState(peers.length === 1 ? peers[0]?.id ?? '' : '')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await run('Sending directly…', async () => {
      await window.sct.sendDirect({ projectId: source, secretIds: [...selected], recipientId: recipient,
        accessExpiresAt: null, injectionOnly: true })
      await refresh()
      setSelected(new Set())
      return 'The encrypted transfer is on its way. The recipient confirms the import.'
    })
  }

  return <section className="panel" aria-labelledby="direct-send-heading">
    <h2 id="direct-send-heading">Send directly</h2>
    <p>Both apps must be open and unlocked. The peer must be online.</p>
    {peers.length === 0 && <p><a href="#/sharing/devices">Verify a device</a> before you send directly.</p>}
    <form onSubmit={(event) => { void send(event) }}>
      <fieldset disabled={busy || peers.length === 0 || projects.state !== 'ready'}>
        <label htmlFor="direct-source">Source project</label>
        <select id="direct-source" value={source} required onChange={(event) => {
          setSource(event.target.value)
          setSelected(new Set())
        }}>
          <option value="">Choose a project</option>
          {projects.state === 'ready' && projects.value.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <label htmlFor="direct-recipient">Verified device</label>
        <select id="direct-recipient" value={recipient} required onChange={(event) => setRecipient(event.target.value)}>
          <option value="">Choose a verified device</option>
          {peers.map((peer) => <option key={peer.id} value={peer.id}>{peer.name}{peer.available ? ' (online)' : ' (offline)'}</option>)}
        </select>
        <SecretSelection secrets={secrets} source={source} selected={selected} onChange={setSelected} />
        <div className="form-actions"><button type="submit" disabled={!source || !recipient || selected.size === 0}>Send directly</button></div>
      </fieldset>
    </form>
  </section>
}

function DirectIncoming({ state, projects, busy, run, refresh, updateSecrets }: {
  state: DirectState
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
    await run('Importing the Direct transfer…', async () => {
      const result = await window.sct.importDirect({ transferId, projectId: destinations[transferId] ?? '' })
      updateSecrets((current) => [...current.filter((secret) => !result.secrets.some((saved) => saved.id === secret.id)), ...result.secrets])
      setImported(result)
      await refresh()
      return `Imported from ${sender}. ${result.receiptSent ? 'The receipt was sent.' : 'Copy the receipt link and send it to the sender.'}`
    })
  }

  return <section className="panel" aria-labelledby="direct-incoming-heading">
    <h2 id="direct-incoming-heading">Incoming Direct transfers</h2>
    {state.incoming.length === 0 && <p>No Direct transfer is waiting.</p>}
    {state.incoming.length > 0 && <ul className="relay-peers" aria-label="Incoming Direct transfers">
      {state.incoming.map((item) => <li key={item.transferId}>
        <h3>{item.projectName}</h3>
        <p>From {item.senderName}</p>
        <p>{item.secretNames.join(', ')}</p>
        <p className="field-help">Deliver before {new Date(item.deliverBy).toLocaleString()}.
          {item.accessExpiresAt === null ? ' Access does not expire.' : ` Access expires ${new Date(item.accessExpiresAt).toLocaleString()}.`}
          {item.injectionOnly ? ' Injection only.' : ' Resharing is allowed.'}</p>
        <ItemForm id={`direct-destination-${item.transferId}`} label="Destination project"
          disabled={busy || projects.state !== 'ready'} actionLabel="Import and send receipt"
          actionDisabled={!destinations[item.transferId]} onSubmit={(event) => { void importItem(event, item.transferId, item.senderName) }}>
          <select id={`direct-destination-${item.transferId}`} value={destinations[item.transferId] ?? ''} required
            onChange={(event) => setDestinations((current) => ({ ...current, [item.transferId]: event.target.value }))}>
            <option value="">Choose a local project</option>
            {projects.state === 'ready' && projects.value.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </ItemForm>
      </li>)}
    </ul>}
    {imported && <>
      <p>Imported {imported.secrets.length} {imported.secrets.length === 1 ? 'secret' : 'secrets'}.</p>
      <label htmlFor="direct-receipt-link">Receipt link</label>
      <textarea className="link-text" id="direct-receipt-link" value={imported.receiptLink} readOnly spellCheck={false} />
      <div className="form-actions"><button type="button" className="secondary" disabled={busy} onClick={() => {
        void run('Copying the receipt link…', async () => {
          await window.sct.copyText(imported.receiptLink)
          return 'Receipt link copied. Send it to the sender.'
        })
      }}>Copy receipt link</button></div>
    </>}
  </section>
}

function ItemForm({ id, label, disabled, actionLabel, actionDisabled, onSubmit, children }: {
  id: string
  label: string
  disabled: boolean
  actionLabel: string
  actionDisabled: boolean
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  children: ReactNode
}) {
  return <form onSubmit={onSubmit}>
    <fieldset disabled={disabled}>
      <label htmlFor={id}>{label}</label>
      {children}
      <div className="form-actions"><button type="submit" disabled={actionDisabled}>{actionLabel}</button></div>
    </fieldset>
  </form>
}

function DirectSent({ state, busy, run, refresh }: {
  state: DirectState
  busy: boolean
  run: Run
  refresh: () => Promise<void>
}) {
  const [receipts, setReceipts] = useState<Record<string, string>>({})

  async function verify(event: FormEvent<HTMLFormElement>, item: DirectSentItem) {
    event.preventDefault()
    await run('Verifying the receipt…', async () => {
      await window.sct.verifyDirectReceipt({ transferId: item.transferId, link: receipts[item.transferId] ?? '' })
      await refresh()
      return 'Receipt verified. The recipient imported the secrets.'
    })
  }

  return <section className="panel" aria-labelledby="direct-sent-heading">
    <h2 id="direct-sent-heading">Sent directly</h2>
    {state.sent.length === 0 && <p>No Direct transfer was sent.</p>}
    {state.sent.length > 0 && <ul className="relay-peers" aria-label="Sent Direct transfers">
      {state.sent.map((item) => <li key={item.transferId}>
        <h3>{item.projectName}</h3>
        <p>To {state.peers.find((peer) => peer.id === item.recipientId)?.name ?? item.recipientId}</p>
        <p>{item.secretNames.join(', ')}</p>
        <p>State: {item.state}.</p>
        {item.error && <p className="error" role="alert">{item.error}</p>}
        {(item.state === 'manual' || item.state === 'failed') && <ItemForm id={`direct-receipt-${item.transferId}`}
          label="Paste receipt link" disabled={busy} actionLabel="Verify receipt"
          actionDisabled={!receipts[item.transferId]} onSubmit={(event) => { void verify(event, item) }}>
          <textarea className="link-text" id={`direct-receipt-${item.transferId}`} value={receipts[item.transferId] ?? ''}
            spellCheck={false} onChange={(event) => setReceipts((current) => ({ ...current, [item.transferId]: event.target.value }))} />
        </ItemForm>}
      </li>)}
    </ul>}
  </section>
}
