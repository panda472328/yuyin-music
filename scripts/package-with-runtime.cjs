// Use electron-builder's built-in filesystem collector when the local npm runtime is unavailable.
// Application configuration and dependencies stay unchanged.
const collectors = require('app-builder-lib/out/node-module-collector')
const original = collectors.getCollectorByPackageManager
collectors.getCollectorByPackageManager = (_manager, ...args) => original(collectors.PM.TRAVERSAL, ...args)
const { build, Platform } = require('electron-builder')
const prepackaged = process.argv.includes('--prepackaged') ? require('node:path').resolve('release/win-unpacked') : undefined
const target = process.argv.includes('--dir') ? 'dir' : process.argv.includes('--installer') ? 'nsis' : 'portable'
build({ targets: Platform.WINDOWS.createTarget([target]), ...(prepackaged ? { prepackaged } : {}) }).catch(error => {
  console.error(error)
  process.exitCode = 1
})
