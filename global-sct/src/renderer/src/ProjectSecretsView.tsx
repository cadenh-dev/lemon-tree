import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Project } from '../../shared/projects'
import type { SecretMetadata } from '../../shared/secrets'
import { StatusLine, useOperation } from './operation'
import type { Loaded, Run, UpdateSecrets } from './types'

interface ProjectSecretsViewProps {
  projectId: string
  projects: Loaded<Project[]>
  secrets: Loaded<SecretMetadata[]>
  updateSecrets: UpdateSecrets
}

export function ProjectSecretsView({ projectId, projects, secrets, updateSecrets }: ProjectSecretsViewProps) {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const operation = useOperation()

  if (projects.state === 'loading') return <p role="status">Loading the project…</p>
  if (projects.state === 'error') return <p className="error" role="alert">{projects.error}</p>
  const project = projects.value.find((saved) => saved.id === projectId)
  if (!project) {
    return (
      <section className="empty-state" aria-labelledby="missing-heading">
        <h1 id="missing-heading">This project is not in your list</h1>
        <p><a href="#/">Return to your projects</a></p>
      </section>
    )
  }

  // The value leaves the renderer once. The field clears after each request, whether it succeeds or fails.
  async function save(event: FormEvent<HTMLFormElement>, current: Project) {
    event.preventDefault()
    const submitted = value
    setValue('')
    const saved = await operation.run(`Saving ${name}…`, async () => {
      const secret = await window.sct.addSecret({ projectId: current.id, name, value: submitted })
      updateSecrets((list) => [...list, secret])
      return `${secret.name} was saved in ${current.name}.`
    })
    if (saved) setName('')
  }

  const projectSecrets = secrets.state === 'ready' ? secrets.value.filter((secret) => secret.projectId === project.id) : []

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{project.name}</h1>
          <p className="description">{project.directory}</p>
        </div>
        <div className="row-actions">
          <a className="button-link secondary" href={`#/sharing/${encodeURIComponent(project.id)}`}>Share secrets</a>
          <a className="button-link secondary" href="#/">All projects</a>
        </div>
      </div>

      <StatusLine status={operation.status} />

      <section className="panel" aria-labelledby="add-secret-heading">
        <h2 id="add-secret-heading">Add a secret</h2>
        <p>global.sct encrypts the value in the vault. The value is not shown again.</p>
        <form onSubmit={(event) => { void save(event, project) }}>
          <fieldset disabled={operation.busy}>
            <label htmlFor="secret-name">Name</label>
            <input id="secret-name" value={name} maxLength={100} required pattern="[A-Za-z_][A-Za-z0-9_]*"
              placeholder="OPENAI_API_KEY" autoComplete="off" spellCheck={false} aria-describedby="secret-name-help"
              onChange={(event) => setName(event.target.value)} />
            <p id="secret-name-help" className="field-help">Use letters, digits, and underscores. Do not start with a digit.</p>
            <label htmlFor="secret-value">Value</label>
            <input id="secret-value" type="password" value={value} maxLength={65536} aria-describedby="secret-value-help"
              autoComplete="off" spellCheck={false} onChange={(event) => setValue(event.target.value)} />
            <p id="secret-value-help" className="field-help">Leave this field empty to store an empty value.</p>
            <div className="form-actions">
              <button type="submit" disabled={!name}>{operation.busy ? 'Please wait…' : 'Save secret'}</button>
            </div>
          </fieldset>
        </form>
      </section>

      <h2>Secrets</h2>
      {secrets.state === 'loading' && <p role="status">Loading secrets…</p>}
      {secrets.state === 'error' && <p className="error" role="alert">{secrets.error}</p>}
      {secrets.state === 'ready' && projectSecrets.length > 0 && (
        <ul className="item-list" aria-label={`Secrets in ${project.name}`}>
          {projectSecrets.map((secret) => (
            <SecretRow key={secret.id} secret={secret} busy={operation.busy} run={operation.run} updateSecrets={updateSecrets} />
          ))}
        </ul>
      )}
      {secrets.state === 'ready' && projectSecrets.length === 0 && (
        <section className="empty-state compact" aria-labelledby="no-secrets-heading">
          <h3 id="no-secrets-heading">No secrets in {project.name}</h3>
          <p>Add a name and value above. Approved local agents use these secrets later.</p>
        </section>
      )}
      <footer>Secret names and values are encrypted in the vault.</footer>
    </>
  )
}

interface SecretRowProps {
  secret: SecretMetadata
  busy: boolean
  run: Run
  updateSecrets: UpdateSecrets
}

function SecretRow({ secret, busy, run, updateSecrets }: SecretRowProps) {
  const [mode, setMode] = useState<'view' | 'update' | 'delete'>('view')
  const [value, setValue] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const confirm = useRef<HTMLButtonElement>(null)

  // The user opened a form, so focus moves to its first control.
  useEffect(() => {
    if (mode === 'update') field.current?.focus()
    if (mode === 'delete') confirm.current?.focus()
  }, [mode])

  async function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const submitted = value
    setValue('')
    const updated = await run(`Updating ${secret.name}…`, async () => {
      await window.sct.updateSecret({ projectId: secret.projectId, id: secret.id, value: submitted })
      return `The value of ${secret.name} was updated.`
    })
    if (updated) setMode('view')
  }

  async function remove() {
    await run(`Deleting ${secret.name}…`, async () => {
      await window.sct.deleteSecret({ projectId: secret.projectId, id: secret.id })
      updateSecrets((list) => list.filter((saved) => saved.id !== secret.id))
      return `${secret.name} was deleted.`
    })
  }

  if (mode === 'update') {
    return (
      <li>
        <form className="inline-form" aria-label={`Update ${secret.name}`} onSubmit={(event) => { void update(event) }}>
          <fieldset disabled={busy}>
            <label htmlFor={`value-${secret.id}`}>New value for {secret.name}</label>
            <div className="inline-field">
              <input ref={field} id={`value-${secret.id}`} type="password" value={value} maxLength={65536}
                autoComplete="off" spellCheck={false} onChange={(event) => setValue(event.target.value)} />
              <button type="button" className="secondary" onClick={() => { setValue(''); setMode('view') }}>Cancel</button>
              <button type="submit">Save value</button>
            </div>
          </fieldset>
        </form>
      </li>
    )
  }

  if (mode === 'delete') {
    return (
      <li>
        <div><p>Delete {secret.name}? global.sct removes its encrypted vault entry. You cannot undo this.</p></div>
        <div className="row-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => setMode('view')}>Cancel</button>
          <button ref={confirm} type="button" disabled={busy} onClick={() => { void remove() }}>Delete secret</button>
        </div>
      </li>
    )
  }

  return (
    <li>
      <div><h3>{secret.name}</h3></div>
      <div className="row-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => setMode('update')}>Update value</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setMode('delete')}>Delete</button>
      </div>
    </li>
  )
}
