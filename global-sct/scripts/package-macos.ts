import { packager } from '@electron/packager'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import electron from 'electron/package.json'
import { stageDependencies } from './stage-dependencies'

const identityName = 'global.sct Development'
const bundleId = 'app.global-sct.desktop'

if (process.platform !== 'darwin' || (process.arch !== 'arm64' && process.arch !== 'x64')) {
  throw new Error('The signed macOS build requires an Apple Silicon or Intel Mac.')
}

// CI has no local identity. SCT_SIGN=adhoc signs without a certificate, which gives no stable identity between builds.
const adhoc = process.env.SCT_SIGN === 'adhoc'
const identity = adhoc ? '-' : requireLocalIdentity()

await stageDependencies()

const [output] = await packager({
  dir: 'out',
  out: 'dist',
  name: 'global.sct',
  executableName: 'sct',
  appBundleId: bundleId,
  appCategoryType: 'public.app-category.developer-tools',
  icon: 'build/icon.icns',
  extendInfo: {
    CFBundleURLTypes: [{
      CFBundleURLName: 'app.global-sct.desktop.link',
      CFBundleTypeRole: 'Viewer',
      CFBundleURLSchemes: ['global-sct']
    }],
    CFBundleDocumentTypes: [{
      CFBundleTypeName: 'global.sct encrypted transfer',
      CFBundleTypeRole: 'Viewer',
      LSHandlerRank: 'Owner',
      LSItemContentTypes: ['app.global-sct.desktop.transfer']
    }],
    UTExportedTypeDeclarations: [{
      UTTypeIdentifier: 'app.global-sct.desktop.transfer',
      UTTypeDescription: 'global.sct encrypted transfer',
      UTTypeConformsTo: ['public.data'],
      UTTypeTagSpecification: { 'public.filename-extension': ['sct-transfer'] }
    }]
  },
  electronVersion: electron.version,
  platform: 'darwin',
  arch: process.arch,
  extraResource: ['out/demo', 'out/airdrop', 'skills'],
  // macOS cannot load a native library from inside the archive.
  asar: { unpack: '*.node' },
  overwrite: true,
  osxSign: {
    identity,
    continueOnError: false,
    // The explicit code-signing policy check replaces osx-sign's basic-policy lookup.
    identityValidation: false,
    type: 'development',
    optionsForFile: () => ({
      // Local certificates lack the Team ID required by library validation.
      entitlements: ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.disable-library-validation'],
      timestamp: 'none'
    })
  }
})

const appPath = join(output, 'global.sct.app')
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' })
if (!adhoc) {
  execFileSync('/usr/bin/codesign', [
    '--verify', '-R', `=identifier "${bundleId}" and certificate leaf = H"${identity}"`, appPath
  ], { stdio: 'inherit' })
}
console.log(`Signed app: ${appPath}`)
console.log(`Signing certificate: ${adhoc ? 'ad-hoc' : `${identityName} (${identity})`}`)

function requireLocalIdentity() {
  const identities = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8'
  }).split('\n').filter((line) => line.trimEnd().endsWith(`"${identityName}"`))

  if (identities.length !== 1) {
    throw new Error(`Keep exactly one valid "${identityName}" identity in your Keychain. See docs/macos-signing.md.`)
  }

  const fingerprint = identities[0].match(/\b[0-9A-F]{40}\b/i)?.[0]
  if (!fingerprint) throw new Error('Cannot read the signing certificate fingerprint.')
  return fingerprint
}
