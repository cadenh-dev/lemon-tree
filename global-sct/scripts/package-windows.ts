import { packager } from '@electron/packager'
import electron from 'electron/package.json'
import { stageDependencies } from './stage-dependencies'

if (process.platform !== 'win32' || (process.arch !== 'arm64' && process.arch !== 'x64' && process.arch !== 'ia32')) {
  throw new Error(`The Windows package requires an arm64, x64, or ia32 Windows machine (current: ${process.platform}/${process.arch}).`)
}

await stageDependencies()

const [output] = await packager({
  dir: 'out',
  out: 'dist',
  name: 'global.sct',
  executableName: 'sct',
  electronVersion: electron.version,
  platform: 'win32',
  arch: process.arch,
  extraResource: ['out/demo', 'skills'],
  // Windows cannot load a native library from inside the archive.
  asar: { unpack: '*.node' },
  overwrite: true
})

console.log(`Packaged app: ${output}`)
