import { randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
import type { ShareRequestView, ShareSummary } from '../shared/share'

const confirmationLifetime = 2 * 60 * 1000
const queueLimit = 8

interface GateEntry {
  id: string
  summary: ShareSummary
  execute: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  expiresAt: number
}

// One outgoing operation runs after one passphrase confirmation. The closure stays in the main process,
// so a renderer message can release the operation but cannot choose a different recipient or secret set.
export class ShareGate {
  private readonly queue: GateEntry[] = []
  private active: GateEntry | null = null
  private timer: NodeJS.Timeout | undefined
  private confirming = false

  constructor(private readonly verify: (passphrase: unknown) => Promise<void>, private readonly changed: () => void) {}

  run<T>(summary: ShareSummary, execute: () => Promise<T>): Promise<T> {
    if (this.queue.length >= queueLimit) return Promise.reject(new Error('Wait for the current share confirmation to finish.'))
    return new Promise<T>((resolve, reject) => {
      const entry: GateEntry = {
        id: randomUUID(), summary, execute, expiresAt: 0,
        resolve: (value) => resolve(value as T),
        reject
      }
      this.queue.push(entry)
      this.advance()
    })
  }

  current(): ShareRequestView | null {
    if (!this.active) return null
    return { id: this.active.id, expiresAt: this.active.expiresAt, ...structuredClone(this.active.summary) }
  }

  async confirm(input: unknown): Promise<void> {
    const entry = this.active
    if (!entry) throw new Error('No share confirmation is waiting.')
    const request = requireConfirmation(input)
    if (request.id !== entry.id) throw new Error('This share confirmation is no longer active. Start the share again.')
    if (Date.now() >= entry.expiresAt) {
      this.expire()
      throw new Error('This share confirmation expired. Start the share again.')
    }
    if (this.confirming) throw new Error('The passphrase is already being checked.')
    this.confirming = true
    try {
      await this.verify(request.passphrase)
    } finally {
      this.confirming = false
    }
    if (this.active !== entry) throw new Error('This share confirmation is no longer active. Start the share again.')
    this.release()
    // Start the approved operation only after the one-use authorization is gone.
    void Promise.resolve().then(entry.execute).then(entry.resolve, entry.reject).finally(() => {
      this.advance()
    })
  }

  cancel(): void {
    const entry = this.active
    if (!entry) return
    this.release()
    entry.reject(new Error('The share was cancelled.'))
    this.advance()
  }

  clear(): void {
    const entries = [...(this.active ? [this.active] : []), ...this.queue.splice(0)]
    this.release()
    for (const entry of entries) entry.reject(new Error('The vault is locked. Start the share again.'))
  }

  private advance(): void {
    if (this.active || this.queue.length === 0) return
    const entry = this.queue.shift()
    if (!entry) return
    entry.expiresAt = Date.now() + confirmationLifetime
    this.active = entry
    this.timer = setTimeout(() => this.expire(), confirmationLifetime)
    this.changed()
  }

  private expire(): void {
    const entry = this.active
    if (!entry) return
    this.release()
    entry.reject(new Error('This share confirmation expired. Start the share again.'))
    this.advance()
  }

  private release(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.active = null
    this.changed()
  }
}

function requireConfirmation(input: unknown): { id: string; passphrase: string } {
  const parsed = z.strictObject({ id: z.uuidv4(), passphrase: z.string().min(1).max(1024) }).safeParse(input)
  if (!parsed.success) throw new Error('Enter your vault passphrase to confirm the share.')
  return parsed.data
}
