import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: { build: { externalizeDeps: { exclude: ['@modelcontextprotocol/server', 'zod'], include: ['agtop', 'koffi'] } } },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          webrtc: resolve('src/preload/webrtc.ts')
        }
      }
    }
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          webrtc: resolve('src/renderer/webrtc.html')
        }
      }
    }
  }
})
