const { chromium } = require('playwright')
const fs = require('node:fs')
;(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 256, height: 256 } })
    await page.setContent('<style>html,body{margin:0;background:transparent;width:256px;height:256px}</style>' + fs.readFileSync('public/icon.svg', 'utf8'))
    const png = await page.screenshot({ omitBackground: true })
    const header = Buffer.alloc(22); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18)
    fs.mkdirSync('build', { recursive: true }); fs.writeFileSync('build/icon.ico', Buffer.concat([header, png])); fs.writeFileSync('public/icon.png', png)
    console.log('Generated 256px app icon')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exit(1) })
