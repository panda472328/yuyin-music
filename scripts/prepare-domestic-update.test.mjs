import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { assertDomesticAdvance, decodeDomesticContents, domesticArtifactUrl, domesticManifestUrl, prepareDomesticManifest, validateDomesticManifest } from './prepare-domestic-update.mjs'

const payload = Buffer.from('MZ controlled fixture; never installed')
const sha256 = createHash('sha256').update(payload).digest('hex')
const githubManifest = { schemaVersion: 1, platform: 'windows', version: '0.5.1', artifact: { url: 'https://github.com/panda472328/yuyin-music/releases/download/pc-v0.5.1/Yuyin-0.5.1-Setup.exe', sha256, size: payload.length }, releaseNotesUrl: 'https://github.com/panda472328/yuyin-music/releases/tag/pc-v0.5.1', notes: '受控说明', publishedAt: '2026-10-12T00:00:00.000Z' }
const release = { id: 12345, tag_name: 'pc-v0.5.1', prerelease: false }
const attachments = [{ id: 67890, name: 'Yuyin-0.5.1-Setup.exe', size: payload.length }]
const fixture = { githubManifest, release, attachments, fetcher: async (url, options) => {
  assert.equal(url, domesticArtifactUrl(12345, 67890)); assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit')
  assert.equal('Authorization' in options.headers, false)
  return new Response(payload, { headers: { 'content-length': String(payload.length) } })
} }

test('fixed Contents API decodes only the exact bounded domestic JSON file without following embedded URLs', () => {
  const bytes = Buffer.from(JSON.stringify(githubManifest))
  const wrapper = { type: 'file', encoding: 'base64', path: 'updates/domestic.json', name: 'domestic.json', size: bytes.length, content: bytes.toString('base64'), download_url: 'https://untrusted.example/file' }
  assert.equal(domesticManifestUrl, 'https://gitee.com/api/v5/repos/openmusic/openmusic/contents/updates/domestic.json?ref=main')
  assert.deepEqual(decodeDomesticContents(wrapper), githubManifest)
  assert.deepEqual(decodeDomesticContents({ ...wrapper, content: wrapper.content.slice(0, 20) + '\r\n' + wrapper.content.slice(20) }), githubManifest)
  assert.equal(decodeDomesticContents([], true), null)
  assert.equal(decodeDomesticContents(null, true), null)
  for (const value of [[], [wrapper], null, githubManifest, { ...wrapper, type: 'dir' }, { ...wrapper, encoding: 'utf8' },
    { ...wrapper, path: 'updates/stable.json' }, { ...wrapper, name: 'stable.json' }, { ...wrapper, size: 0 }, { ...wrapper, size: 65537 },
    { ...wrapper, size: 1 }, { ...wrapper, content: 'a===' }, { ...wrapper, content: 'A'.repeat(131073) },
    { ...wrapper, size: 1, content: '/w==' }, { ...wrapper, size: 1, content: 'Zh==' }]) assert.throws(() => decodeDomesticContents(value))
})

test('candidate is generated only after byte-for-byte equivalence with immutable GitHub release', async () => {
  const candidate = await prepareDomesticManifest(fixture)
  assert.equal(candidate.schemaVersion, 2); assert.equal(candidate.provider, 'gitee')
  assert.equal(candidate.artifact.sha256, sha256); assert.equal(candidate.artifact.size, payload.length)
  assert.equal(candidate.artifact.url, domesticArtifactUrl(12345, 67890)); validateDomesticManifest(candidate)
})

test('wrong tags, preview releases, absent/duplicate/wrong attachments stop before download', async () => {
  for (const overrides of [{ release: { ...release, tag_name: 'pc-v0.5.0' } }, { release: { ...release, prerelease: true } },
    { attachments: [] }, { attachments: [...attachments, ...attachments] }, { attachments: [{ ...attachments[0], size: 1 }] },
    { attachments: [{ ...attachments[0], name: 'evil.exe' }] }, { attachments: [{ ...attachments[0], id: -1 }] }]) {
    await assert.rejects(prepareDomesticManifest({ ...fixture, ...overrides, fetcher: async () => { assert.fail('unexpected download') } }))
  }
})

test('unproven CDN redirects, HTML, partial bytes and digest mismatches cannot advance a channel', async () => {
  for (const response of [new Response(null, { status: 302, headers: { location: 'https://unknown.example/download' } }),
    new Response('login required', { status: 403 }), new Response(payload.subarray(0, 3)), new Response(Buffer.alloc(payload.length)),
    new Response(payload, { headers: { 'content-length': '999' } }), new Response(payload, { headers: { 'content-encoding': 'gzip' } })]) {
    await assert.rejects(prepareDomesticManifest({ ...fixture, fetcher: async () => response }))
  }
})

test('domestic channels refuse version rollback, same version replacement, token URLs and repository changes', async () => {
  const candidate = await prepareDomesticManifest(fixture)
  assertDomesticAdvance(candidate, candidate)
  const previous = { ...candidate, version: '0.5.0', source: { ...candidate.source, filename: 'Yuyin-0.5.0-Setup.exe' }, releaseNotesUrl: candidate.releaseNotesUrl.replace('0.5.1', '0.5.0') }
  assertDomesticAdvance(previous, candidate)
  assert.throws(() => assertDomesticAdvance(candidate, previous))
  assert.throws(() => assertDomesticAdvance(candidate, { ...candidate, artifact: { ...candidate.artifact, sha256: 'b'.repeat(64) } }))
  for (const url of [candidate.artifact.url + '?access_token=secret', candidate.artifact.url.replace('openmusic/openmusic', 'evil/repo')])
    assert.throws(() => validateDomesticManifest({ ...candidate, artifact: { ...candidate.artifact, url } }))
})
