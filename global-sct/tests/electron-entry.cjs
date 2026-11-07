const { app, session } = require('electron')

app.setPath('userData', process.argv.splice(2, 1)[0])
// UI tests never connect to the live relay.
process.env.SCT_RELAY ??= 'off'
const relayOrigin = process.env.SCT_RELAY === 'off' ? null : new URL(process.env.SCT_RELAY).origin
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => callback({ cancel: !relayOrigin || new URL(details.url).origin !== relayOrigin })
  )
  require('../out/main/index.js')
})
