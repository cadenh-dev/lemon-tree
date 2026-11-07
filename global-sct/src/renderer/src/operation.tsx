import { useState } from 'react'
import type { Run } from './types'

type Status = { kind: 'idle' } | { kind: 'working'; text: string } | { kind: 'done'; text: string } | { kind: 'error'; text: string }

// Runs one request at a time and reports its status. Error text comes from the main process and never contains a secret value.
export function useOperation() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const run: Run = async (working, operation) => {
    setStatus({ kind: 'working', text: working })
    try {
      setStatus({ kind: 'done', text: await operation() })
      return true
    } catch (cause) {
      setStatus({ kind: 'error', text: errorText(cause, 'The operation failed.') })
      return false
    }
  }

  return { status, busy: status.kind === 'working', run, clear: () => setStatus({ kind: 'idle' }) }
}

export function StatusLine({ status }: { status: Status }) {
  if (status.kind === 'error') return <p className="error" role="alert">{status.text}</p>
  return <p className="status" role="status">{status.kind === 'idle' ? '' : status.text}</p>
}

export function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}
