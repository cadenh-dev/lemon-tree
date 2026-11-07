import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { unlock } from './ui'

const passphrase = 'test passphrase for the vault'

test('shares selected secrets into the recipient project without exposing values', async () => {
  test.setTimeout(90_000)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sct-sharing-ui-')))
  const applications: { app: ElectronApplication; data: string }[] = []
  const value = `sct-transfer-${randomUUID()}`

  try {
    for (const name of ['sender', 'recipient']) {
      await mkdir(join(root, name, 'app-data'), { recursive: true })
      await writeFile(join(root, name, 'app-data', 'settings.json'), JSON.stringify({ vaultRoot: join(root, name) }))
      applications.push({
        app: await electron.launch({ args: [join(__dirname, 'electron-entry.cjs'), join(root, name, 'app-data')] }),
        data: join(root, name, 'app-data')
      })
    }
    const sender = applications[0]
    const recipient = applications[1]
    if (!sender || !recipient) throw new Error('Both global.sct windows must start.')
    const source = await sender.app.firstWindow()
    const destination = await recipient.app.firstWindow()
    await unlock(source, passphrase)
    await unlock(destination, passphrase)
    const errors: string[] = []
    for (const { app } of applications) {
      await app.evaluate(() => {
        // The native AirDrop picker cannot run in automation. Encryption and vault operations remain real.
        Object.assign(process.getBuiltinModule('node:child_process'), {
          execFile(_file: string, _args: string[], callback: (error: null, stdout: string, stderr: string) => void) { callback(null, '', '') }
        })
      })
    }
    for (const page of [source, destination]) {
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    }

    await addProject(source, root, 'backend')
    await source.getByRole('link', { name: 'Open secrets' }).click()
    await addSecret(source, 'API_TOKEN', value)
    await addSecret(source, 'SECOND_TOKEN', `${value}-second`)
    await addProject(destination, root, 'api')
    await addProject(destination, root, 'other')

    await source.getByRole('link', { name: 'Share secrets', exact: true }).click()
    await destination.getByRole('link', { name: 'Sharing', exact: true }).click()
    for (const page of [source, destination]) {
      const tabs = page.getByRole('navigation', { name: 'Sharing', exact: true })
      await tabs.getByRole('link', { name: 'Relay', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Relay sharing', exact: true })).toBeVisible()
      await expect(page.getByText('The relay is off. Set SCT_RELAY to connect this app.')).toBeVisible()
      await expect(page.getByLabel('Other device’s relay ID')).toBeDisabled()
      await expect(page.getByRole('heading', { name: 'Delivery activity', exact: true })).toBeVisible()
      await expect(page.getByText('No relay delivery activity is saved on this device.')).toBeVisible()
      if (page === source) {
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.screenshot({ path: test.info().outputPath('relay-desktop.png'), fullPage: true })
        await page.setViewportSize({ width: 375, height: 812 })
        await expect(tabs.getByRole('link', { name: 'Relay', exact: true })).toBeInViewport()
        await expect(page.getByRole('heading', { name: 'Relay sharing', exact: true })).toBeInViewport()
        await page.screenshot({ path: test.info().outputPath('relay-phone.png'), fullPage: true })
        await page.setViewportSize({ width: 1000, height: 720 })
      }
      await tabs.getByRole('link', { name: 'Verify devices', exact: true }).click()
      await expect(tabs.getByRole('link', { name: 'Verify devices', exact: true })).toHaveAttribute('aria-current', 'page')
      await expect(tabs.getByText('Send secrets', { exact: true })).toHaveAttribute('aria-disabled', 'true')
      await expect(page.getByRole('heading', { name: 'Send secrets', exact: true })).toHaveCount(0)
      await expect(page.getByText('Verify a device before you can send secrets.', { exact: true })).toBeVisible()
      await tabs.getByRole('link', { name: 'Verify devices', exact: true }).click()
      await page.getByRole('button', { name: 'Send my card to…' }).click()
      await expect(page.getByRole('status').first()).toContainText('public device card')
    }
    await source.screenshot({ path: test.info().outputPath('verify-devices.png'), fullPage: true })

    await chooseFile(sender.app, join(recipient.data, 'sharing', 'outbox', 'device.sct-device'))
    await source.getByRole('button', { name: 'Import .sct-device file…' }).click()
    await chooseFile(recipient.app, join(sender.data, 'sharing', 'outbox', 'device.sct-device'))
    await destination.getByRole('button', { name: 'Import .sct-device file…' }).click()
    await expect(source.getByRole('button', { name: 'Confirm recipient' })).toBeDisabled()
    await expect(destination.getByRole('button', { name: 'Confirm recipient' })).toBeDisabled()
    await expect(source.getByLabel('Pairing code')).toHaveText(await destination.getByLabel('Pairing code').innerText())
    for (const page of [source, destination]) {
      await page.getByLabel('I compared this code on both devices').check()
      await page.getByRole('button', { name: 'Confirm recipient' }).click()
      await expect(page.getByRole('list', { name: 'Verified devices' })).toBeVisible()
      await expect(page.getByRole('navigation', { name: 'Sharing', exact: true })
        .getByRole('link', { name: 'Send secrets', exact: true })).toBeVisible()
    }

    await source.getByRole('link', { name: 'Continue to Send secrets', exact: true }).click()
    await expect(source.getByLabel('Source project').locator('option:checked')).toHaveText('backend')
    await expect(source.getByLabel('Verified recipient')).toBeFocused()
    await source.getByLabel('Verified recipient').selectOption({ index: 1 })
    await source.getByLabel('Select all secrets').check()
    await expect(source.getByLabel('API_TOKEN', { exact: true })).toBeChecked()
    await expect(source.getByLabel('SECOND_TOKEN', { exact: true })).toBeChecked()
    await source.getByLabel('Select all secrets').uncheck()
    await source.getByLabel('API_TOKEN', { exact: true }).check()
    await expect(source.getByLabel('SECOND_TOKEN', { exact: true })).not.toBeChecked()
    await source.getByRole('navigation', { name: 'Sharing', exact: true }).getByRole('link', { name: 'Verify devices', exact: true }).click()
    await expect(source.getByRole('heading', { name: 'Send secrets', exact: true })).not.toBeVisible()
    await source.getByRole('navigation', { name: 'Sharing', exact: true }).getByRole('link', { name: 'Send secrets', exact: true }).click()
    await expect(source.getByLabel('Source project').locator('option:checked')).toHaveText('backend')
    await expect(source.getByLabel('API_TOKEN', { exact: true })).toBeChecked()
    await expect(source.getByLabel('SECOND_TOKEN', { exact: true })).not.toBeChecked()
    await source.getByRole('button', { name: 'Send to…' }).click()
    await expect(source.getByRole('status').first()).toContainText('the encrypted secrets are on their way')
    const packages = (await readdir(join(sender.data, 'sharing', 'outbox'))).filter((name) => name.endsWith('.sct-transfer'))
    expect(packages).toHaveLength(1)
    const transferFile = packages[0]
    if (!transferFile) throw new Error('The encrypted transfer file is missing.')
    const transfer = await readFile(join(sender.data, 'sharing', 'outbox', transferFile))
    expect(transfer.includes(value)).toBe(false)
    expect(transfer.includes('API_TOKEN')).toBe(false)

    await writeFile(join(root, 'recipient', 'received.sct-transfer'), transfer)
    await chooseFile(recipient.app, join(root, 'recipient', 'received.sct-transfer'))
    await destination.getByRole('link', { name: 'Projects', exact: true }).click()
    await recipient.app.evaluate(({ app }, path) => {
      app.emit('open-file', { preventDefault() {} }, path)
    }, join(root, 'recipient', 'received.sct-transfer'))
    await expect(destination.getByRole('heading', { name: 'Sharing', exact: true })).toBeVisible()
    await expect(destination.getByRole('heading', { name: 'Received transfers' })).toBeVisible()
    await expect(destination.getByRole('list', { name: 'Received secrets from backend' })).toHaveText('API_TOKEN')
    await destination.getByLabel('Destination project').selectOption({ label: 'api' })
    await expect(destination.getByText(join(root, 'recipient', 'global.sct', 'api', 'secrets.sct'), { exact: true })).toBeVisible()
    await destination.screenshot({ path: test.info().outputPath('receive-secrets.png') })
    await destination.getByRole('button', { name: 'Import secrets' }).click()
    await expect(destination.getByRole('status').first()).toContainText('Imported 1 secret into api')
    await expect(destination.getByRole('heading', { name: /^Received from / })).toBeVisible()
    await expect(destination.locator('.sharing-scramble')).toHaveText('API_TOKEN')

    const projects = await destination.evaluate(() => window.sct.listProjects())
    const imported = await destination.evaluate(() => window.sct.listSecrets())
    expect(imported).toHaveLength(1)
    expect(imported[0]).toMatchObject({ name: 'API_TOKEN', projectId: projects.find((project) => project.name === 'api')?.id })
    expect((await readFile(join(root, 'recipient', 'global.sct', 'api', 'secrets.sct'))).includes(value)).toBe(false)
    expect(await readdir(join(root, 'recipient', 'global.sct', 'other'))).toEqual([])
    expect(await source.content()).not.toContain(value)
    expect(await destination.content()).not.toContain(value)

    await writeFile(join(root, 'recipient', 'received.sct-transfer'), transfer)
    await destination.getByRole('button', { name: 'Choose received file…' }).click()
    await expect(destination.getByRole('alert')).toContainText(/already|imported/i)
    expect(await destination.evaluate(() => window.sct.listSecrets())).toHaveLength(1)
    await source.screenshot({ path: test.info().outputPath('send-secrets.png') })
    await destination.emulateMedia({ reducedMotion: 'reduce' })
    expect(errors).toEqual([])
  } finally {
    const cleanup = await Promise.allSettled(applications.map(async ({ app, data }) => {
      try {
        await (await app.firstWindow()).evaluate(async () => {
          for (const project of await window.sct.listProjects()) await window.sct.deleteProject(project.id)
        })
        await app.evaluate(async ({ app }, account) => {
          const { AsyncEntry } = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
          await new AsyncEntry('.sct-sharing', account).deleteCredential()
        }, join(data, 'sharing'))
      } finally {
        await app.close()
      }
    }))
    await rm(root, { recursive: true, force: true })
    expect(cleanup.filter((result) => result.status === 'rejected')).toEqual([])
  }
})

async function addProject(page: Page, root: string, name: string) {
  await mkdir(join(root, name), { recursive: true })
  await page.getByRole('link', { name: 'Projects', exact: true }).click()
  await page.getByRole('button', { name: 'Add a project', exact: true }).click()
  await page.getByLabel('Project name').fill(name)
  await page.getByLabel('Folder path').fill(join(root, name))
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Projects' })).toContainText(name)
}

async function addSecret(page: Page, name: string, value: string) {
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Value', { exact: true }).fill(value)
  await page.getByRole('button', { name: 'Save secret', exact: true }).click()
  await expect(page.getByRole('status')).toContainText(`${name} was saved`)
}

async function chooseFile(app: ElectronApplication, filename: string) {
  await app.evaluate(({ dialog }, selected) => {
    Object.assign(dialog, { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) })
  }, filename)
}
