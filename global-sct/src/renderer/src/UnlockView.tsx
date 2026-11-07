import { useState } from 'react'
import type { FormEvent } from 'react'
import type { VaultStatus } from '../../shared/vault'
import { errorText } from './operation'

export function UnlockView({ status, onUnlocked }: { status: VaultStatus; onUnlocked: (status: VaultStatus) => void }) {
  const creating = !status.initialized
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    if (creating && passphrase !== confirmation) {
      setError('The two passphrases are different.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const unlocked = await window.sct.unlockVault({ passphrase, remember })
      setPassphrase('')
      setConfirmation('')
      onUnlocked(unlocked)
    } catch (cause) {
      setError(errorText(cause, 'The vault did not open.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app unlock-screen">
      <main className="unlock-panel">
        <span className="wordmark">global.sct</span>
        <h1>{creating ? 'Create a vault passphrase' : 'Unlock your vault'}</h1>
        <p className="description">
          {creating
            ? 'The passphrase derives the key for every project. global.sct does not store the passphrase.'
            : 'Enter the passphrase for this vault.'}
        </p>
        <form className="panel" onSubmit={(event) => { void submit(event) }}>
          <label htmlFor="vault-passphrase">Passphrase</label>
          <input id="vault-passphrase" type="password" autoComplete={creating ? 'new-password' : 'current-password'}
            value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
          {creating && (
            <>
              <label htmlFor="vault-passphrase-2">Confirm passphrase</label>
              <input id="vault-passphrase-2" type="password" autoComplete="new-password"
                value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
              <p className="field-help">Use at least 8 characters. A longer passphrase is stronger.</p>
            </>
          )}
          <label className="check-field" htmlFor="vault-remember">
            <input id="vault-remember" type="checkbox" checked={remember} disabled={!status.rememberAvailable}
              onChange={(event) => setRemember(event.target.checked)} />
            <span>Remember this device</span>
          </label>
          <p className="field-help">
            {status.rememberAvailable
              ? 'Stores the vault key in this system’s secret store. The passphrase still works when the stored key is gone.'
              : 'This system has no secret service. Use the passphrase each time.'}
          </p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="form-actions">
            <button type="submit" disabled={busy || passphrase.length === 0}>
              {busy ? 'Opening…' : creating ? 'Create vault' : 'Unlock'}
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}
