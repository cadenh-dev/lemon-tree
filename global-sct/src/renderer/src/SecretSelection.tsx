import type { SecretMetadata } from '../../shared/secrets'
import type { Loaded } from './types'

export function SecretSelection({ secrets, source, selected, onChange }: {
  secrets: Loaded<SecretMetadata[]>
  source: string
  selected: Set<string>
  onChange: (selected: Set<string>) => void
}) {
  if (secrets.state === 'loading') return <p role="status">Loading secrets…</p>
  if (secrets.state !== 'ready' || !source) return null
  const projectSecrets = secrets.value.filter((secret) => secret.projectId === source)
  if (projectSecrets.length === 0) return <p className="field-help">This project has no secrets to send.</p>

  return (
    <fieldset className="sharing-selection">
      <legend>Secrets to send</legend>
      <label className="check-field">
        <input type="checkbox" checked={projectSecrets.every((secret) => selected.has(secret.id))}
          onChange={(event) => onChange(event.target.checked ? new Set(projectSecrets.map((secret) => secret.id)) : new Set())} />
        Select all secrets
      </label>
      {projectSecrets.map((secret) => (
        <label className="check-field" key={secret.id}>
          <input type="checkbox" checked={selected.has(secret.id)} onChange={(event) => {
            onChange(event.target.checked ? new Set([...selected, secret.id]) : new Set([...selected].filter((id) => id !== secret.id)))
          }} />
          {secret.name}
        </label>
      ))}
    </fieldset>
  )
}
