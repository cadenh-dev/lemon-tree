import { packager } from '@electron/packager'
import electron from 'electron/package.json'
import { stageDependencies } from './stage-dependencies'

if (process.platform !== 'linux' || (process.arch !== 'arm64' && process.arch !== 'x64')) {
  throw new Error(`The Linux package requires an arm64 or x64 Linux machine (current: ${process.platform}/${process.arch}).`)
}

await stageDependencies()

const [output] = await packager({
  dir: 'out',
  out: 'dist',
  name: 'global.sct',
  executableName: 'sct',
  electronVersion: electron.version,
  platform: 'linux',
  arch: process.arch,
  extraResource: ['out/demo', 'skills'],
  // Linux cannot load a native library from inside the archive.
  asar: { unpack: '*.node' },
  overwrite: true
})

console.log(`Packaged app: ${output}`)
