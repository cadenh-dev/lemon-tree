import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Project } from '../../shared/projects'
import type { SecretMetadata } from '../../shared/secrets'
import { StatusLine, useOperation } from './operation'
import type { Loaded, Run, UpdateProjects, UpdateSecrets } from './types'

interface ProjectsViewProps {
  projects: Loaded<Project[]>
  secrets: Loaded<SecretMetadata[]>
  updateProjects: UpdateProjects
  updateSecrets: UpdateSecrets
}

export function ProjectsView({ projects, secrets, updateProjects, updateSecrets }: ProjectsViewProps) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [directory, setDirectory] = useState('')
  const operation = useOperation()
  const nameInput = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (adding) nameInput.current?.focus()
    else addButton.current?.focus()
  }, [adding])

  async function browse() {
    await operation.run('Opening the folder picker…', async () => {
      const selected = await window.sct.pickDirectory()
      if (!selected) return ''
      setDirectory(selected)
      if (!name.trim()) setName(selected.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Project')
      return ''
    })
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await operation.run('Adding the project…', async () => {
      const project = await window.sct.addProject({ name, directory })
      updateProjects((current) => [...current, project])
      setAdding(false)
      setName('')
      setDirectory('')
      return `${project.name} was added.`
    })
  }

  function cancel() {
    setAdding(false)
    setName('')
    setDirectory('')
    operation.clear()
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Projects</h1>
          <p className="description">Your folders. Right where you left them.</p>
        </div>
        <button ref={addButton} type="button" disabled={projects.state !== 'ready' || adding} onClick={() => {
          setAdding(true)
          operation.clear()
        }}><span aria-hidden="true">+</span> Add a project</button>
      </div>

      <StatusLine status={operation.status} />

      {adding && (
        <section className="panel" aria-labelledby="add-heading">
          <h2 id="add-heading">Add a project</h2>
          <p>Choose an existing folder on this device. Your files stay where they are.</p>
          <form onSubmit={(event) => { void save(event) }}>
            <fieldset disabled={operation.busy}>
              <label htmlFor="project-name">Project name</label>
              <input ref={nameInput} id="project-name" value={name} maxLength={100} required
                placeholder="My project" onChange={(event) => setName(event.target.value)} />
              <label htmlFor="project-directory">Folder path</label>
              <div className="folder-field">
                <input id="project-directory" value={directory} maxLength={4096} required
                  placeholder="~/projects/my-project" aria-describedby="folder-help"
                  onChange={(event) => setDirectory(event.target.value)} />
                <button type="button" className="secondary" onClick={() => { void browse() }}>Choose folder…</button>
              </div>
              <p id="folder-help" className="field-help">Select a folder or enter its full path.</p>
              <div className="form-actions">
                <button type="button" className="secondary" onClick={cancel}>Cancel</button>
                <button type="submit" disabled={!name.trim() || !directory.trim()}>{operation.busy ? 'Please wait…' : 'Add project'}</button>
              </div>
            </fieldset>
          </form>
        </section>
      )}

      {projects.state === 'loading' && <p role="status">Loading projects…</p>}
      {projects.state === 'error' && <p className="error" role="alert">{projects.error}</p>}
      {projects.state === 'ready' && projects.value.length > 0 && (
        <ul className="item-list" aria-label="Projects">
          {projects.value.map((project) => (
            <ProjectRow key={project.id} project={project} secretCount={secretCount(secrets, project.id)}
              busy={operation.busy} run={operation.run} updateProjects={updateProjects} updateSecrets={updateSecrets} />
          ))}
        </ul>
      )}
      {projects.state === 'ready' && projects.value.length === 0 && !adding && (
        <section className="empty-state" aria-labelledby="empty-heading">
          <h2 id="empty-heading">Your projects start here</h2>
          <p>Add an existing folder to get started.</p>
          <p className="empty-note">Your files stay on this device.</p>
        </section>
      )}
      <footer>Project names and folder paths are saved on this device.</footer>
    </>
  )
}

interface ProjectRowProps {
  project: Project
  secretCount: string
  busy: boolean
  run: Run
  updateProjects: UpdateProjects
  updateSecrets: UpdateSecrets
}

function ProjectRow({ project, secretCount, busy, run, updateProjects, updateSecrets }: ProjectRowProps) {
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view')
  const [name, setName] = useState(project.name)
  const [confirmation, setConfirmation] = useState('')
  const field = useRef<HTMLInputElement>(null)

  // The user opened a form to type into it, so focus moves to its field.
  useEffect(() => {
    if (mode !== 'view') field.current?.focus()
  }, [mode])

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const renamed = await run('Renaming the project…', async () => {
      const updated = await window.sct.renameProject({ id: project.id, name })
      updateProjects((current) => current.map((saved) => saved.id === updated.id ? updated : saved))
      return `${project.name} was renamed to ${updated.name}.`
    })
    if (renamed) setMode('view')
  }

  async function remove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await run('Deleting the project…', async () => {
      await window.sct.deleteProject(project.id)
      updateSecrets((current) => current.filter((secret) => secret.projectId !== project.id))
      updateProjects((current) => current.filter((saved) => saved.id !== project.id))
      return `${project.name} and its secrets were deleted. The project folder did not change.`
    })
  }

  if (mode === 'rename') {
    return (
      <li>
        <form className="inline-form" aria-label={`Rename ${project.name}`} onSubmit={(event) => { void rename(event) }}>
          <fieldset disabled={busy}>
            <label htmlFor={`rename-${project.id}`}>New name for {project.name}</label>
            <div className="inline-field">
              <input ref={field} id={`rename-${project.id}`} value={name} maxLength={100} required
                onChange={(event) => setName(event.target.value)} />
              <button type="button" className="secondary" onClick={() => { setName(project.name); setMode('view') }}>Cancel</button>
              <button type="submit" disabled={!name.trim() || name.trim() === project.name}>Save name</button>
            </div>
          </fieldset>
        </form>
      </li>
    )
  }

  if (mode === 'delete') {
    return (
      <li>
        <form className="inline-form" aria-label={`Delete ${project.name}`} onSubmit={(event) => { void remove(event) }}>
          <fieldset disabled={busy}>
            <p>Delete {project.name} and all of its secrets? global.sct removes the vault folder and encrypted entries of this project. The project folder does not change.</p>
            <label htmlFor={`delete-${project.id}`}>Type {project.name} to confirm</label>
            <div className="inline-field">
              <input ref={field} id={`delete-${project.id}`} value={confirmation} autoComplete="off"
                onChange={(event) => setConfirmation(event.target.value)} />
              <button type="button" className="secondary" onClick={() => { setConfirmation(''); setMode('view') }}>Cancel</button>
              <button type="submit" disabled={confirmation !== project.name}>Delete project</button>
            </div>
          </fieldset>
        </form>
      </li>
    )
  }

  return (
    <li>
      <div><h2>{project.name}</h2><p>{project.directory}</p></div>
      <span className="item-tag">{secretCount}</span>
      <div className="row-actions">
        <a className="button-link" href={`#/projects/${encodeURIComponent(project.id)}`}>Open secrets</a>
        <button type="button" className="secondary" disabled={busy} onClick={() => setMode('rename')}>Rename</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setMode('delete')}>Delete</button>
      </div>
    </li>
  )
}

function secretCount(secrets: Loaded<SecretMetadata[]>, projectId: string): string {
  if (secrets.state !== 'ready') return ''
  const count = secrets.value.filter((secret) => secret.projectId === projectId).length
  return count === 1 ? '1 secret' : `${count} secrets`
}

