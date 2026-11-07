import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Project } from '../../shared/projects'
import type { SecretMetadata } from '../../shared/secrets'
import { AllSecretsView } from './AllSecretsView'
import { errorText } from './operation'
import { ProjectSecretsView } from './ProjectSecretsView'
import { ProjectsView } from './ProjectsView'
import { StorageView } from './StorageView'
import { SharingView } from './SharingView'
import { AgentAccessView } from './AgentAccessView'
import { CardsView } from './CardsView'
import { UnlockView } from './UnlockView'
import { ShareConfirmation } from './ShareConfirmation'
import type { Loaded, SharingTab, UpdateProjects, UpdateSecrets } from './types'
import type { VaultStatus } from '../../shared/vault'
import type { PendingLink } from '../../shared/transport'

type Route = { view: 'projects' } | { view: 'project'; id: string } | { view: 'secrets' } | { view: 'storage' } | { view: 'sharing'; projectId?: string; tab?: SharingTab } | { view: 'cards' } | { view: 'agent' }

export function App() {
  const isMac = window.sct.platform === 'darwin'
  const route = parseRoute(useSyncExternalStore(subscribeToHash, () => window.location.hash), isMac)
  const [status, setStatus] = useState<Loaded<VaultStatus>>({ state: 'loading' })

  useEffect(() => {
    let active = true
    window.sct.getVaultStatus().then((value) => {
      if (active) setStatus({ state: 'ready', value })
    }).catch((cause: unknown) => {
      if (active) setStatus({ state: 'error', error: errorText(cause, 'Cannot open the vault.') })
    })
    return () => { active = false }
  }, [])

  if (status.state === 'loading') {
    return <div className="app"><main><p role="status">Opening the vault…</p></main></div>
  }
  if (status.state === 'error') {
    return <div className="app"><main><p className="error" role="alert">{status.error}</p></main></div>
  }
  if (status.value.locked) {
    return <UnlockView status={status.value} onUnlocked={(value) => setStatus({ state: 'ready', value })} />
  }
  return <>
    {route.view === 'agent' ? <AgentAccessView /> : <DesktopApp route={route} isMac={isMac} />}
    <ShareConfirmation />
  </>
}

function DesktopApp({ route, isMac }: { route: Exclude<Route, { view: 'agent' }>; isMac: boolean }) {
  const [projects, setProjects] = useState<Loaded<Project[]>>({ state: 'loading' })
  const [secrets, setSecrets] = useState<Loaded<SecretMetadata[]>>({ state: 'loading' })
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null)

  useEffect(() => {
    let active = true
    window.sct.listProjects().then((value) => {
      if (active) setProjects({ state: 'ready', value })
    }).catch((cause: unknown) => {
      if (active) setProjects({ state: 'error', error: errorText(cause, 'Cannot load your projects.') })
    })
    window.sct.listSecrets().then((value) => {
      if (active) setSecrets({ state: 'ready', value })
    }).catch((cause: unknown) => {
      if (active) setSecrets({ state: 'error', error: errorText(cause, 'Cannot load your secrets.') })
    })
    return () => { active = false }
  }, [])

  useEffect(() => window.sct.onSharingChanged(() => {
    if (!window.location.hash.startsWith('#/sharing')) window.location.hash = '#/sharing'
  }), [])

  useEffect(() => {
    let active = true
    const refresh = () => window.sct.getPendingLink().then((value) => {
      if (active) setPendingLink(value)
    }).catch(() => undefined)
    const stop = window.sct.onPendingLinkChanged(refresh)
    void refresh()
    return () => { active = false; stop() }
  }, [])

  useEffect(() => {
    if (!pendingLink) return
    const target = pendingLink.kind === 'pairing' ? '#/sharing/devices'
      : pendingLink.kind === 'connect' ? '#/sharing/webrtc' : '#/sharing/link'
    if (window.location.hash !== target) window.location.hash = target
  }, [pendingLink])

  const updateProjects: UpdateProjects = (change) =>
    setProjects((current) => current.state === 'ready' ? { state: 'ready', value: change(current.value) } : current)
  const updateSecrets: UpdateSecrets = (change) =>
    setSecrets((current) => current.state === 'ready' ? { state: 'ready', value: change(current.value) } : current)

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-start">
          <span className="wordmark">global.sct</span>
          <nav aria-label="Main">
            <a href="#/" aria-current={route.view === 'projects' || route.view === 'project' ? 'page' : undefined}>Projects</a>
            <a href="#/secrets" aria-current={route.view === 'secrets' ? 'page' : undefined}>All secrets</a>
            <a href="#/sharing" aria-current={route.view === 'sharing' ? 'page' : undefined}>Sharing</a>
            {isMac && <a href="#/cards" aria-current={route.view === 'cards' ? 'page' : undefined}>Cards</a>}
            <a href="#/storage" aria-current={route.view === 'storage' ? 'page' : undefined}>Storage</a>
          </nav>
        </div>
        <span className="local-label">On this device</span>
      </header>
      <main>
        {route.view === 'projects' && (
          <ProjectsView projects={projects} secrets={secrets} updateProjects={updateProjects} updateSecrets={updateSecrets} />
        )}
        {route.view === 'project' && (
          <ProjectSecretsView projectId={route.id} projects={projects} secrets={secrets} updateSecrets={updateSecrets} />
        )}
        {route.view === 'secrets' && <AllSecretsView projects={projects} secrets={secrets} />}
        {route.view === 'storage' && <StorageView />}
        {route.view === 'cards' && <CardsView />}
        {route.view === 'sharing' && (
          <SharingView key={route.projectId ?? 'sharing'} projectId={route.projectId}
            tab={route.tab} projects={projects} secrets={secrets} updateProjects={updateProjects} updateSecrets={updateSecrets}
            pendingLink={pendingLink} onDismissPendingLink={(id) => {
              void window.sct.dismissPendingLink(id)
              setPendingLink(null)
            }} />
        )}
      </main>
    </div>
  )
}

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

function parseRoute(hash: string, isMac: boolean): Route {
  const [view, id, projectId] = hash.replace(/^#\/?/, '').split('/')
  if (view === 'projects' && id) return { view: 'project', id: decodeURIComponent(id) }
  if (view === 'secrets') return { view: 'secrets' }
  if (view === 'storage') return { view: 'storage' }
  if (view === 'cards' && isMac) return { view: 'cards' }
  if (view === 'agent') return { view: 'agent' }
  if (view === 'sharing') {
    if (id === 'devices' || id === 'secrets' || id === 'receive' || id === 'relay' || id === 'link' || id === 'direct' || id === 'webrtc' || id === 'send') {
      return { view: 'sharing', tab: id, projectId: projectId ? decodeURIComponent(projectId) : undefined }
    }
    return { view: 'sharing', projectId: id ? decodeURIComponent(id) : undefined }
  }
  return { view: 'projects' }
}
