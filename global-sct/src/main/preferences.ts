import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ThemePreference } from '../shared/api'

// Preferences have their own file. Vault.moveTo writes settings.json again with only the vault root.
const themePreference = z.enum(['light', 'dark', 'system'])
const preferences = z.object({ theme: themePreference })

export const defaultThemePreference: ThemePreference = 'light'

// A missing or damaged file gives the default. A preference never blocks the app start.
export async function readThemePreference(file: string): Promise<ThemePreference> {
  return preferences.safeParse(await readJson(file)).data?.theme ?? defaultThemePreference
}

export async function writeThemePreference(file: string, input: unknown): Promise<ThemePreference> {
  const parsed = themePreference.safeParse(input)
  if (!parsed.success) throw new Error('Select Light, Dark, or System.')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(`${file}.tmp`, JSON.stringify({ theme: parsed.data }), { mode: 0o600 })
  await rename(`${file}.tmp`, file)
  return parsed.data
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}
