import { readFile, writeFile } from 'node:fs/promises'

const tag = process.env.GITHUB_REF_NAME
if (!tag) throw new Error('Set GITHUB_REF_NAME to a release tag.')

const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { version: string }
manifest.version = tag.replace(/^v/, '')
await writeFile('package.json', `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Version: ${manifest.version}`)
