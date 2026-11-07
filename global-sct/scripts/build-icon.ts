import { app, BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Electron runs this file after the build:icon script bundles it into out/. Run it from the repository root.
// Chromium renders the OKLCH tokens and the variable font axes. sips and Quick Look cannot render them.
const iconset = 'out/icon.iconset'

// A top-level await on whenReady() blocks the ready event in an ESM main file.
app.whenReady().then(buildIcon).then(() => app.quit(), (error: unknown) => {
  console.error(error)
  app.exit(1)
})

async function buildIcon() {
  const window = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true }
  })
  // loadFile resolves a relative path from the app folder, which is out/.
  await window.loadFile(resolve('build/icon.svg'))
  const fontLoaded: unknown = await window.webContents.executeJavaScript(
    `document.fonts.ready.then(() => document.fonts.check('500 200px "Martian Mono"'))`
  )
  if (fontLoaded !== true) throw new Error('Martian Mono did not load. Run bun install.')

  const master = (await window.webContents.capturePage()).resize({ width: 1024, height: 1024, quality: 'best' })
  await rm(iconset, { recursive: true, force: true })
  await mkdir(iconset, { recursive: true })
  await writeFile(`${iconset}/icon_512x512@2x.png`, master.toPNG())

  for (const size of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [[1, ''], [2, '@2x']] as const) {
      const name = `icon_${size}x${size}${suffix}.png`
      if (name === 'icon_512x512@2x.png') continue
      execFileSync('/usr/bin/sips', ['-z', `${size * scale}`, `${size * scale}`, `${iconset}/icon_512x512@2x.png`, '--out', `${iconset}/${name}`], { stdio: 'ignore' })
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', 'build/icon.icns'])
  console.log('Icon: build/icon.icns')
}
