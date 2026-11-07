import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { Project, ProjectInput, ProjectRename } from '../shared/projects.ts'

// Project names become directory names under the vault, so they exclude path separators and leading dots.
export function isProjectName(name: unknown): name is string {
  return typeof name === 'string' && name.trim() === name && name.length > 0 && name.length <= 100 &&
    !name.startsWith('.') && !/[/\\:\p{Cc}]/u.test(name)
}

function isProjectInput(value: unknown): value is ProjectInput {
  if (typeof value !== 'object' || value === null) return false
  const input = value as Record<string, unknown>
  return typeof input.name === 'string' && isProjectName(input.name.trim()) &&
    typeof input.directory === 'string' && input.directory.length <= 4096 && isAbsolute(input.directory)
}

function isProjectRename(value: unknown): value is ProjectRename {
  if (typeof value !== 'object' || value === null) return false
  const input = value as Record<string, unknown>
  return typeof input.id === 'string' && typeof input.name === 'string' && isProjectName(input.name.trim())
}

function isSavedProject(value: unknown): value is Project {
  if (typeof value !== 'object' || value === null) return false
  const project = value as Record<string, unknown>
  return typeof project.id === 'string' && project.id.length > 0 && typeof project.name === 'string' &&
    project.name.length > 0 && typeof project.directory === 'string' && isAbsolute(project.directory)
}

const invalidName = 'Enter a project name of 1 to 100 characters. Do not start it with a dot or use /, \\, or :.'

export class ProjectStore {
  private pending: Promise<void> = Promise.resolve()
  private readonly filename: string

  constructor(filename: string) {
    this.filename = filename
  }

  async list(): Promise<Project[]> {
    let contents: string
    try {
      contents = await readFile(this.filename, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('Cannot read the saved project list.', { cause: error })
    }

    let projects: unknown
    try {
      projects = JSON.parse(contents)
    } catch (error) {
      throw new Error('The saved project list is invalid. global.sct did not change it.', { cause: error })
    }
    if (!Array.isArray(projects) || !projects.every(isSavedProject)) {
      throw new Error('The saved project list is invalid. global.sct did not change it.')
    }
    return projects
  }

  async find(id: unknown): Promise<Project> {
    const project = (await this.list()).find((saved) => saved.id === id)
    if (!project) throw new Error('This project is not in your project list.')
    return project
  }

  add(input: unknown): Promise<Project> {
    return this.serialize(() => this.save(input))
  }

  // moveFiles runs before the list changes. If the list cannot change, moveFiles runs again to restore the files.
  rename(input: unknown, moveFiles: (project: Project, name: string) => Promise<void>): Promise<Project> {
    return this.serialize(async () => {
      if (!isProjectRename(input)) throw new Error(invalidName)
      const projects = await this.list()
      const project = projects.find((saved) => saved.id === input.id)
      if (!project) throw new Error('This project is not in your project list.')
      const renamed: Project = { ...project, name: input.name.trim() }
      requireUniqueName(projects, renamed)
      await moveFiles(project, renamed.name)
      try {
        await this.write(projects.map((saved) => saved.id === renamed.id ? renamed : saved))
      } catch (error) {
        await moveFiles(renamed, project.name)
        throw error
      }
      return renamed
    })
  }

  // removeFiles runs first, so a failed removal keeps the project in the list for another attempt.
  remove(id: unknown, removeFiles: (project: Project) => Promise<void>): Promise<void> {
    return this.serialize(async () => {
      const projects = await this.list()
      const project = projects.find((saved) => saved.id === id)
      if (!project) throw new Error('This project is not in your project list.')
      await removeFiles(project)
      await this.write(projects.filter((saved) => saved.id !== project.id))
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }

  private async save(input: unknown): Promise<Project> {
    if (!isProjectInput(input)) {
      throw new Error(`Select an absolute folder path. ${invalidName}`)
    }

    let directory: string
    try {
      directory = await realpath(input.directory)
      if (!(await stat(directory)).isDirectory()) throw new Error('Not a directory.')
    } catch (error) {
      throw new Error('Select an existing folder that global.sct can access.', { cause: error })
    }

    const projects = await this.list()
    if (projects.some((project) => project.directory === directory)) {
      throw new Error('This folder is already in your project list.')
    }
    const project: Project = { id: randomUUID(), name: input.name.trim(), directory }
    requireUniqueName(projects, project)
    await this.write([...projects, project])
    return project
  }

  private async write(projects: Project[]): Promise<void> {
    try {
      await mkdir(dirname(this.filename), { recursive: true })
      await writeFile(`${this.filename}.tmp`, JSON.stringify(projects, null, 2), { mode: 0o600 })
      await rename(`${this.filename}.tmp`, this.filename)
    } catch (error) {
      throw new Error('Cannot save the project list. Check your local storage permissions.', { cause: error })
    }
  }
}

// macOS file names ignore case by default, so "App" and "app" would share one vault directory.
function requireUniqueName(projects: Project[], project: Project): void {
  const name = project.name.toLowerCase()
  if (projects.some((saved) => saved.id !== project.id && saved.name.toLowerCase() === name)) {
    throw new Error('A project with this name already exists. Enter a different name.')
  }
}
