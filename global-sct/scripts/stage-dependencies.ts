import { execFileSync } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import manifest from '../package.json'

// The packaged app loads these modules at run time. Install their complete production closure in `out`
// so the packager includes Hyperswarm's native prebuilds and the keyring binary for the current platform.
export async function stageDependencies(): Promise<void> {
  await writeFile('out/package.json', JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    main: 'main/index.js',
    dependencies: {
      '@napi-rs/keyring': manifest.dependencies['@napi-rs/keyring'],
      hyperswarm: manifest.dependencies.hyperswarm
    }
  }, null, 2))
  await rm('out/node_modules', { recursive: true, force: true })
  execFileSync(process.execPath, ['install', '--production', '--ignore-scripts'], { cwd: 'out', stdio: 'inherit' })
  await rm('out/bun.lock', { force: true })
}
