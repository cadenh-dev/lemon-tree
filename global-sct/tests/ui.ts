import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

// The app starts locked. The first run creates the vault; later runs unlock it.
export async function unlock(page: Page, passphrase: string): Promise<void> {
  const create = page.getByRole('button', { name: 'Create vault', exact: true })
  const unlockButton = page.getByRole('button', { name: 'Unlock', exact: true })
  const creating = await create.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false)
  if (creating) {
    await page.getByLabel('Passphrase', { exact: true }).fill(passphrase)
    await page.getByLabel('Confirm passphrase').fill(passphrase)
    await create.click()
  } else if (await unlockButton.isVisible().catch(() => false)) {
    await page.getByLabel('Passphrase', { exact: true }).fill(passphrase)
    await unlockButton.click()
  }
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible({ timeout: 30_000 })
}
