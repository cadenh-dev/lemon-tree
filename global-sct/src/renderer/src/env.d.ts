import type { SctAPI } from '../../shared/api'

declare global {
  interface Window {
    sct: SctAPI
  }
}
