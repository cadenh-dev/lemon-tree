import type { Project } from '../../shared/projects'
import type { SecretMetadata } from '../../shared/secrets'
import type { Loaded } from './types'

interface AllSecretsViewProps {
  projects: Loaded<Project[]>
  secrets: Loaded<SecretMetadata[]>
}

export function AllSecretsView({ projects, secrets }: AllSecretsViewProps) {
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>All secrets</h1>
          <p className="description">Secret names in every project. Values stay encrypted.</p>
        </div>
      </div>

      {(projects.state === 'loading' || secrets.state === 'loading') && <p role="status">Loading secrets…</p>}
      {projects.state === 'error' && <p className="error" role="alert">{projects.error}</p>}
      {secrets.state === 'error' && <p className="error" role="alert">{secrets.error}</p>}
      {projects.state === 'ready' && secrets.state === 'ready' && projects.value.length === 0 && (
        <section className="empty-state" aria-labelledby="no-projects-heading">
          <h2 id="no-projects-heading">No projects yet</h2>
          <p>Secrets belong to a project. <a href="#/">Add a project</a> first.</p>
        </section>
      )}
      {projects.state === 'ready' && secrets.state === 'ready' && projects.value.map((project) => {
        const names = secrets.value.filter((secret) => secret.projectId === project.id)
        return (
          <section key={project.id} className="project-group" aria-labelledby={`group-${project.id}`}>
            <div className="group-heading">
              <h2 id={`group-${project.id}`}>{project.name}</h2>
              <a href={`#/projects/${encodeURIComponent(project.id)}`}>Manage {project.name} secrets</a>
            </div>
            {names.length > 0 ? (
              <ul className="name-list" aria-label={`Secrets in ${project.name}`}>
                {names.map((secret) => <li key={secret.id}>{secret.name}</li>)}
              </ul>
            ) : <p className="group-empty">No secrets in this project.</p>}
          </section>
        )
      })}
    </>
  )
}
