import { _electron as electron, expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlock } from './ui'

const passphrase = 'test passphrase for the vault'

test('Cream is the default and the selected theme stays after a restart', async () => {
  test.setTimeout(90_000)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sct-theme-ui-')))
  const userData = join(root, 'app-data')
  await mkdir(userData)
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ vaultRoot: root }))
  const launch = () => electron.launch({ args: [join(__dirname, 'electron-entry.cjs'), userData] })
  let application = await launch()

  try {
    let page = await application.firstWindow()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'cream')
    await unlock(page, passphrase)
    await page.getByRole('link', { name: 'Storage', exact: true }).click()
    await expect(page.getByLabel('Theme')).toHaveValue('light')
    await page.getByLabel('Theme').selectOption('dark')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'terminal')
    await expect(page.getByRole('status')).toHaveText('The appearance is now Dark (Terminal).')
    expect(JSON.parse(await readFile(join(userData, 'preferences.json'), 'utf8'))).toEqual({ theme: 'dark' })

    await application.close()
    application = await launch()
    page = await application.firstWindow()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'terminal')
    await unlock(page, passphrase)
    await page.getByRole('link', { name: 'Storage', exact: true }).click()
    await expect(page.getByLabel('Theme')).toHaveValue('dark')
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
