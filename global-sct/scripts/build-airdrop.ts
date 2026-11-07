import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

if (process.platform === 'darwin') {
  mkdirSync('out', { recursive: true })
  execFileSync('swiftc', ['-O', 'native/airdrop.swift', '-o', 'out/airdrop'], { stdio: 'inherit' })
} else {
  console.log(`Skipping the AirDrop helper: it needs macOS (current platform: ${process.platform}).`)
}
