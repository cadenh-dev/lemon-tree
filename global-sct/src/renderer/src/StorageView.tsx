import { useEffect, useState } from 'react'
import { errorText, StatusLine, useOperation } from './operation'
import type { Loaded } from './types'
import type { ProtocolStatus, ThemePreference } from '../../shared/api'

const themeLabels: Record<ThemePreference, string> = { light: 'Light (Cream)', dark: 'Dark (Terminal)', system: 'System' }

export function StorageView() {
  const [location, setLocation] = useState<Loaded<string>>({ state: 'loading' })
  const [theme, setTheme] = useState<Loaded<ThemePreference>>({ state: 'loading' })
  const operation = useOperation()

  useEffect(() => {
    let active = true
    window.sct.getVaultLocation().then((value) => {
      if (active) setLocation({ state: 'ready', value })
    }).catch((cause: unknown) => {
      if (active) setLocation({ state: 'error', error: errorText(cause, 'Cannot read the storage location.') })
    })
    window.sct.getThemePreference().then((value) => {
      if (active) setTheme({ state: 'ready', value })
    }).catch((cause: unknown) => {
      if (active) setTheme({ state: 'error', error: errorText(cause, 'Cannot read the appearance setting.') })
    })
    return () => { active = false }
  }, [])

  async function change() {
    await operation.run('Moving the vault…', async () => {
      const moved = await window.sct.chooseVaultLocation()
      if (!moved) return 'The storage location did not change.'
      setLocation({ state: 'ready', value: moved })
      return `The vault moved to ${moved}.`
    })
  }

  async function changeTheme(value: string) {
    if (!isThemePreference(value)) return
    await operation.run('Saving the appearance…', async () => {
      await window.sct.setThemePreference(value)
      setTheme({ state: 'ready', value })
      return `The appearance is now ${themeLabels[value]}.`
    })
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Storage</h1>
          <p className="description">Where global.sct keeps encrypted secrets on this device, and how the window looks.</p>
        </div>
      </div>

      <StatusLine status={operation.status} />

      <section className="panel" aria-labelledby="location-heading">
        <h2 id="location-heading">Vault folder</h2>
        {location.state === 'loading' && <p role="status">Loading the storage location…</p>}
        {location.state === 'error' && <p className="error" role="alert">{location.error}</p>}
        {location.state === 'ready' && <p className="path">{location.value}</p>}
        <p className="field-help">Select a folder. global.sct moves its global.sct folder and all project secrets into it. The vault keys move with the folder.</p>
        <div className="form-actions">
          <button type="button" disabled={location.state !== 'ready' || operation.busy} onClick={() => { void change() }}>
            {operation.busy ? 'Please wait…' : 'Change location…'}
          </button>
        </div>
      </section>

      <section className="appearance" aria-labelledby="appearance-heading">
        <h2 id="appearance-heading">Appearance</h2>
        {theme.state === 'error' && <p className="error" role="alert">{theme.error}</p>}
        <label htmlFor="theme-select">Theme</label>
        <select id="theme-select" value={theme.state === 'ready' ? theme.value : 'light'} disabled={theme.state !== 'ready' || operation.busy}
          onChange={(event) => { void changeTheme(event.target.value) }}>
          {Object.entries(themeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <p className="field-help">System follows the light or dark setting of this computer.</p>
      </section>

      <LinkRegistration operation={operation} />
    </>
  )
}

function LinkRegistration({ operation }: { operation: ReturnType<typeof useOperation> }) {
  const [protocol, setProtocol] = useState<Loaded<ProtocolStatus>>({ state: 'loading' })

  useEffect(() => {
    let active = true
    window.sct.getProtocolStatus().then((value) => {
      if (active) setProtocol({ state: 'ready', value })
    }).catch((cause: unknown) => {
      if (active) setProtocol({ state: 'error', error: errorText(cause, 'Cannot read the link registration status.') })
    })
    return () => { active = false }
  }, [])

  async function register(replace: boolean) {
    await operation.run('Registering global-sct links…', async () => {
      const status = await window.sct.registerProtocol(replace)
      setProtocol({ state: 'ready', value: status })
      return status.detail
    })
  }

  async function remove() {
    await operation.run('Removing the link registration…', async () => {
      const status = await window.sct.removeProtocol()
      setProtocol({ state: 'ready', value: status })
      return status.detail
    })
  }

  return <section className="panel" aria-labelledby="links-heading">
    <h2 id="links-heading">Links</h2>
    <p className="field-help">Open global-sct:// links from another app in global.sct.</p>
    {protocol.state === 'loading' && <p role="status">Loading the link registration…</p>}
    {protocol.state === 'error' && <p className="error" role="alert">{protocol.error}</p>}
    {protocol.state === 'ready' && <>
      <p>{protocol.value.detail}</p>
      {protocol.value.supported && <div className="form-actions">
        {!protocol.value.registered && !protocol.value.conflict && <button type="button" disabled={operation.busy}
          onClick={() => { void register(false) }}>Register global.sct links</button>}
        {protocol.value.conflict && <button type="button" disabled={operation.busy}
          onClick={() => { void register(true) }}>Replace handler</button>}
        {protocol.value.registered && <button type="button" className="secondary" disabled={operation.busy}
          onClick={() => { void remove() }}>Remove registration</button>}
      </div>}
    </>}
  </section>
}

function isThemePreference(value: string): value is ThemePreference {
  return Object.hasOwn(themeLabels, value)
}
