export interface Project {
  id: string
  name: string
  directory: string
}

export interface ProjectInput {
  name: string
  directory: string
}

export interface ProjectRename {
  id: string
  name: string
}
