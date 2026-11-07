import { _electron as electron, expect, test } from '@playwright/test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIdentity, encodePairingLink, pairingCode, readPairingLink } from '../src/main/transfer'

test('Windows shows the vault-first layout and pairing without AirDrop', async () => {
  test.skip(process.platform !== 'win32', 'This test checks the Windows layout.')
  test.setTimeout(90_000)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sct-windows-ui-')))
  const userData = join(root, 'app-data')
  await mkdir(userData)
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ vaultRoot: root }))
  const application = await electron.launch({ args: [join(__dirname, 'electron-entry.cjs'), userData] })

  try {
    const page = await application.firstWindow()
    await expect(page).toHaveTitle('global.sct')
    await page.getByLabel('Passphrase', { exact: true }).fill('test passphrase for the vault')
    await page.getByLabel('Confirm passphrase').fill('test passphrase for the vault')
    await page.getByRole('button', { name: 'Create vault' }).click()
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.local-label')).toHaveText('On this device')
    await expect(page.getByRole('link', { name: 'Cards', exact: true })).toHaveCount(0)

    await page.getByRole('link', { name: 'Sharing', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Relay sharing', exact: true })).toBeVisible()
    const navigation = page.getByRole('navigation', { name: 'Sharing', exact: true })
    await expect(navigation.getByRole('link', { name: 'Relay', exact: true })).toBeVisible()
    await expect(navigation.getByRole('link', { name: 'Verify devices', exact: true })).toBeVisible()
    await expect(navigation.getByRole('link', { name: 'Receive secrets', exact: true })).toHaveCount(0)
    await expect(navigation.getByRole('link', { name: 'Send secrets', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Send my card to…' })).toHaveCount(0)
    await expect(page.getByText('AirDrop', { exact: true })).toHaveCount(0)
    await expect(page.getByText('The relay is off. Set SCT_RELAY to connect this app.')).toBeVisible()
    await navigation.getByRole('link', { name: 'Verify devices', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'cream')
    await expect(page.getByRole('heading', { name: 'Verify your first device', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send my card to…' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Copy pairing link', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save device card…', exact: true })).toBeVisible()
    await expect(page.getByLabel('Paste pairing link', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Review pairing link', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Import .sct-device file…', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Copy pairing link', exact: true }).click()
    const localLink = await application.evaluate(({ clipboard }) => clipboard.readText())
    expect(localLink).toMatch(/^global-sct:\/\/pair\/v1\/[A-Za-z0-9_-]+$/)
    await page.getByLabel('Paste pairing link', { exact: true }).fill(localLink)
    await page.getByRole('button', { name: 'Review pairing link', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('This is your own device card. Select the other device’s card.')
    await expect(page.getByRole('button', { name: 'Confirm recipient', exact: true })).toHaveCount(0)

    await page.getByLabel('Paste pairing link', { exact: true }).fill('global-sct://pair/v2/invalid')
    await page.getByRole('button', { name: 'Review pairing link', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('The pairing link is invalid.')

    const peer = createIdentity('Other device').card
    await page.evaluate(() => window.sct.setThemePreference('dark'))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'terminal')
    await page.getByLabel('Paste pairing link', { exact: true }).fill(encodePairingLink(peer))
    await page.getByRole('button', { name: 'Review pairing link', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Compare codes with Other device', exact: true })).toBeFocused()
    await expect(page.getByLabel('Pairing code', { exact: true })).toHaveText(pairingCode(readPairingLink(localLink), peer))
    await expect(page.getByRole('button', { name: 'Confirm recipient', exact: true })).toBeDisabled()
    await page.getByLabel('I compared this code on both devices', { exact: true }).check()
    await page.getByRole('button', { name: 'Confirm recipient', exact: true }).click()
    await expect(page.getByRole('list', { name: 'Verified devices', exact: true })).toContainText('Other device')
    await expect(page.getByRole('button', { name: 'Confirm recipient', exact: true })).toHaveCount(0)
  } finally {
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
})
