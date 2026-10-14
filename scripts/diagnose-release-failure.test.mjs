import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { diagnoseFailedPublication, extractPublishFailure, extractStepFailure, inspectCurrentRelease, reportDiagnostic, sanitizeDiagnostic, selectFailedTagRun, summarizeRelease } from './diagnose-release-failure.mjs'

const repository = 'panda472328/yuyin-music'
const publishStep = 'Publish one installer, then advance stable channel'
const installerStep = 'Verify native installer guards without installing on the runner'
const tag = 'pc-v0.4.14'
const commit = '023bec8ae0e7c3ccb4d5ca9667245313e8ef54e2'
const run = { id: 38109329998, run_number: 51, run_attempt: 1, event: 'push', head_branch: tag, head_sha: commit,
  path: '.github/workflows/release.yml', head_repository: { full_name: repository }, status: 'completed', conclusion: 'failure' }
const logLine = message => 'release\t' + publishStep + '\t2026-10-11T07:02:14.001Z ' + message

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyin-release-diagnostic-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('yuyin-release-diagnostic-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'yuyin-music', version: '0.4.14' }))
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: repository, GH_TOKEN: 'controlled-ephemeral-token', GITHUB_STEP_SUMMARY: path.join(root, 'summary.md') }
  const calls = []
  const state = { runs: [run], run, jobs: [{ name: 'release', steps: [{ name: publishStep, conclusion: 'failure' }] }],
    releases: [{ id: 987, tag_name: tag, draft: true, prerelease: false, created_at: '2026-10-11T07:00:00Z', name: '余音 PC 0.4.14', assets: [] }],
    log: [logLine('Error: GitHub 操作失败：release upload（退出码：1）。gh: HTTP 403: Resource not accessible by integration'),
      logLine('##[error]Process completed with exit code 1.')].join('\n') }
  function command(executable, args, options) {
    calls.push({ executable, args })
    assert.equal(options.env, env)
    assert.equal(options.cwd, root)
    if (executable === 'git') {
      assert.deepEqual(args, ['rev-parse', '--verify', 'refs/tags/' + tag + '^{commit}'])
      return commit + '\n'
    }
    assert.ok(['gh', 'gh.exe'].includes(executable))
    if (args[0] === 'api') {
      assert.deepEqual(args.slice(0, 3), ['api', '--method', 'GET'])
      const route = args[3]
      if (route === 'repos/' + repository + '/releases?per_page=100&page=1') return JSON.stringify(state.releases)
      if (route === 'repos/' + repository + '/releases/987') return JSON.stringify(state.detail ?? state.releases[0])
      if (route === 'repos/' + repository + '/actions/workflows/release.yml/runs?event=push&branch=' + tag + '&status=failure&per_page=100') {
        return JSON.stringify({ total_count: state.runs.length, workflow_runs: state.runs })
      }
      if (route === 'repos/' + repository + '/actions/runs/' + run.id) return JSON.stringify(state.run)
      if (route === 'repos/' + repository + '/actions/runs/' + run.id + '/attempts/1/jobs?per_page=100') return JSON.stringify({ jobs: state.jobs })
      throw new Error('Unexpected API read.')
    }
    assert.deepEqual(args, ['run', 'view', String(run.id), '--repo', repository, '--attempt', '1', '--log-failed'])
    return state.log
  }
  return { root, env, calls, state, diagnose: () => diagnoseFailedPublication({ root, env, command }) }
}

test('diagnostic reads only current tag and final Publish failed logs using read-only commands', t => {
  const f = fixture(t)
  assert.deepEqual(f.diagnose(), { tag, commit, runId: run.id, attempt: 1,
    releaseMetadata: { found: true, current_tag_found: true, source: 'tag', ...summarizeRelease(f.state.releases[0], { tag, version: '0.4.14' }) },
    url: 'https://github.com/' + repository + '/actions/runs/' + run.id,
    message: 'Error: GitHub 操作失败：release upload（退出码：1）。gh: HTTP 403: Resource not accessible by integration\n##[error]Process completed with exit code 1.' })
  assert.equal(f.calls.length, 7)
  assert.equal(f.calls.some(({ args }) => args.some(value => ['POST', 'PUT', 'PATCH', 'DELETE', 'download', 'upload', 'create', 'edit'].includes(value))), false)
})

test('diagnostic has no local authentication fallback or arbitrary tag override', t => {
  for (const override of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'other/repo' }, { GH_TOKEN: '' },
    { GITHUB_REF: 'refs/tags/pc-v0.4.14' }, { GITHUB_EVENT_NAME: 'pull_request' }, { REQUESTED_TAG: 'pc-v0.4.12' }]) {
    const f = fixture(t)
    Object.assign(f.env, override)
    assert.throws(f.diagnose, /Diagnostic|diagnostic/)
    assert.equal(f.calls.length, 0)
  }
})

test('installer diagnosis retains assertion details while withholding other steps and secrets', t => {
  const f = fixture(t)
  f.state.jobs[0].steps[0].name = installerStep
  const line = message => 'release\t' + installerStep + '\t2026-10-13T09:58:00.000Z ' + message
  f.state.log = [line('not ok 1 - controlled shortcut migration'),
    line('  error: Expected values to be strictly equal'), line('  actual: 2'), line('  expected: 0'),
    line('  operator: strictEqual'), line('Error: GH_TOKEN=controlled-ephemeral-token'),
    logLine('Error: unrelated publication error'), line('Error: https://host.invalid/file?signature=controlled-secret')].join('\n')
  const result = f.diagnose()
  assert.match(result.message, /controlled shortcut migration/)
  assert.match(result.message, /actual: 2/)
  assert.match(result.message, /expected: 0/)
  assert.equal(result.message.includes('controlled-ephemeral-token'), false)
  assert.equal(result.message.includes('controlled-secret'), false)
  assert.equal(result.message.includes('unrelated publication error'), false)
  assert.equal(f.calls.some(({ args }) => args.some(value => ['POST', 'PUT', 'PATCH', 'DELETE', 'download', 'upload', 'create', 'edit'].includes(value))), false)
  assert.throws(() => extractStepFailure(f.state.log, 'Install locked dependencies'), /Only/)
})

test('run selection rejects other commits, repositories, events and non-failed executions', () => {
  for (const change of [{ head_sha: 'a'.repeat(40) }, { head_branch: 'pc-v0.4.12' }, { event: 'workflow_dispatch' },
    { head_repository: { full_name: 'other/repo' } }, { conclusion: 'success' }, { status: 'in_progress' },
    { path: '.github/workflows/other.yml' }]) {
    assert.equal(selectFailedTagRun([{ ...run, ...change }], tag, commit), undefined)
  }
  assert.equal(selectFailedTagRun([{ ...run, id: 1, run_number: 50 }, run], tag, commit).id, run.id)
  assert.throws(() => selectFailedTagRun([{ ...run, id: '38109329998' }], tag, commit), /Invalid/)
})

test('identity changes and failures in other steps stop before reading logs', t => {
  for (const change of ['identity', 'step', 'multiple', 'jobs']) {
    const f = fixture(t)
    if (change === 'identity') f.state.run = { ...run, run_attempt: 2 }
    if (change === 'step') f.state.jobs[0].steps[0].name = 'Install locked dependencies'
    if (change === 'multiple') f.state.jobs[0].steps.push({ name: 'Build installer', conclusion: 'failure' })
    if (change === 'jobs') f.state.jobs.push(f.state.jobs[0])
    assert.throws(f.diagnose, /identity|final Publish/)
    assert.equal(f.calls.some(({ args }) => args.includes('--log-failed')), false)
  }
})

test('no matching tag failure avoids reading any logs', t => {
  const f = fixture(t)
  f.state.runs = [{ ...run, head_sha: 'a'.repeat(40) }]
  assert.match(f.diagnose().message, /No failed tag publication/)
  assert.equal(f.calls.length, 4)
})

test('only Publish errors survive extraction; environment and other jobs are withheld', () => {
  const log = [logLine('Run node scripts/release.mjs --publish'),
    'release\tInstall locked dependencies\t2026-10-11T07:00:00.000Z Error: unrelated private payload',
    'other-job\t' + publishStep + '\t2026-10-11T07:00:00.000Z Error: unrelated job',
    logLine('    GH_TOKEN: controlled-ephemeral-token'), logLine('Error: HTTP 502: Bad Gateway'),
    logLine('    at gh (private-path.js:1:1)')].join('\n')
  assert.equal(extractPublishFailure(log), 'Error: HTTP 502: Bad Gateway')
  assert.throws(() => extractPublishFailure(logLine('Run no recognizable error')), /withheld/)
})

test('diagnostic removes credentials, auth headers, ANSI, signed queries and fragments', () => {
  const secrets = ['controlled-ephemeral-token', 'controlled-env-secret', 'ghp_controlledToken', 'github_pat_controlledToken',
    'controlled-signature', 'controlled-fragment', 'controlled-user', 'controlled-password', 'controlled-bearer']
  const log = [
    logLine('Error: controlled-ephemeral-token controlled-env-secret ghp_controlledToken github_pat_controlledToken'),
    logLine('Error: Authorization: Bearer controlled-bearer'),
    logLine('Error: proxy-authorization: basic controlled-header'),
    logLine('Error: GH_TOKEN=controlled-ephemeral-token'),
    logLine('\u001b[31mError: HTTP 403: https://controlled-user:controlled-password@release-assets.githubusercontent.com/file?sig=controlled-signature#controlled-fragment\u001b[0m'),
  ].join('\n')
  const output = extractPublishFailure(log, secrets.slice(0, 2))
  for (const secret of secrets) assert.equal(output.includes(secret), false, secret)
  assert.match(output, /\[REDACTED URL\]/)
  assert.equal(output.includes('release-assets.githubusercontent.com'), false)
  assert.equal(output.includes('\u001b'), false)
  assert.match(sanitizeDiagnostic('Error: Bearer controlled-bearer'), /Bearer \[REDACTED\]/)
})

test('diagnostic output is bounded and Actions annotation injection is escaped', t => {
  const f = fixture(t)
  const message = extractPublishFailure(Array.from({ length: 20 }, (_, index) => logLine('Error: ' + index + ' ' + 'x'.repeat(2000))).join('\n'))
  assert.ok(message.length <= 1800)
  const outputs = []
  const original = console.log
  console.log = value => outputs.push(value)
  try { reportDiagnostic({ tag, message: 'Error: failure%\n::error::injected' }, f.env.GITHUB_STEP_SUMMARY) }
  finally { console.log = original }
  assert.equal(outputs.length, 1)
  assert.match(outputs[0], /failure%25%0A::error::injected/)
  assert.equal(outputs[0].includes('\n'), false)
  assert.match(fs.readFileSync(f.env.GITHUB_STEP_SUMMARY, 'utf8'), /No logs were uploaded and no Release was changed/)
})

test('workflow diagnostics use actions read permission and precede recovery', () => {
  const workflow = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../.github/workflows/release.yml'), 'utf8')
  const diagnostic = workflow.slice(workflow.indexOf('  diagnose-failed-publication:'), workflow.indexOf('  recover-existing-release:'))
  assert.match(diagnostic, /contents: read/)
  assert.match(diagnostic, /actions: read/)
  assert.match(diagnostic, /GH_TOKEN: \$\{\{ github\.token \}\}/)
  assert.match(diagnostic, /node scripts\/diagnose-release-failure\.mjs/)
  assert.equal(diagnostic.includes('upload-artifact'), false)
  const recovery = workflow.slice(workflow.indexOf('  recover-existing-release:'), workflow.indexOf('  advance-existing-release:'))
  assert.match(recovery, /needs: diagnose-failed-publication/)
  assert.match(recovery, /always\(\)/)
})

test('release metadata explains empty-draft recovery failure using only allowlisted fields', t => {
  const f = fixture(t)
  f.state.releases[0].body = 'private-body-sentinel'
  f.state.releases[0].author = { login: 'private-author-sentinel' }
  const metadata = f.diagnose().releaseMetadata
  assert.equal(metadata.creation_readback_ok, true)
  assert.equal(metadata.recovery_metadata_ok, false)
  assert.deepEqual(metadata.recovery_reasons, ['Existing Release must contain exactly one installer'])
  const serialized = JSON.stringify(metadata)
  assert.equal(serialized.includes('private-body-sentinel'), false)
  assert.equal(serialized.includes('private-author-sentinel'), false)
})

test('missing current-tag release inspects only the exact-title PC draft', t => {
  const f = fixture(t)
  f.state.releases = [
    { id: 123, tag_name: 'untagged-other', draft: true, name: '余音 PC 0.4.12', body: 'unrelated-body-sentinel', assets: [] },
    { ...f.state.releases[0], tag_name: 'untagged-controlled-draft' },
  ]
  f.state.detail = f.state.releases[1]
  const metadata = f.diagnose().releaseMetadata
  assert.equal(metadata.source, 'exact-title-draft')
  assert.equal(metadata.current_tag_found, false)
  assert.equal(metadata.tag_name, 'untagged-controlled-draft')
  assert.ok(metadata.recovery_reasons.includes('Release tag differs from current PC tag'))
  assert.equal(JSON.stringify(metadata).includes('unrelated-body-sentinel'), false)
  assert.equal(f.calls.some(({ args }) => args.includes('repos/' + repository + '/releases/123')), false)
})

test('metadata checks installer name, state, size, digest and URL without emitting URL text', () => {
  const release = { id: 1, tag_name: tag, draft: true, prerelease: false, assets: [{ id: 2,
    name: 'private-name-sentinel', state: 'new', size: 1, digest: 'private-digest-sentinel',
    browser_download_url: 'https://private-host-sentinel/file?private-signature-sentinel' }] }
  const metadata = summarizeRelease(release, { tag, version: '0.4.14' })
  assert.equal(metadata.creation_readback_ok, false)
  assert.equal(metadata.recovery_metadata_ok, false)
  assert.equal(metadata.recovery_reasons.length, 5)
  for (const sentinel of ['private-name-sentinel', 'private-digest-sentinel', 'private-host-sentinel', 'private-signature-sentinel']) {
    assert.equal(JSON.stringify(metadata).includes(sentinel), false)
  }
  release.assets[0] = { id: 2, name: 'Yuyin-0.4.14-Setup.exe', state: 'uploaded', size: 150000000,
    digest: 'sha256:' + 'a'.repeat(64),
    browser_download_url: 'https://github.com/' + repository + '/releases/download/untagged-controlled/Yuyin-0.4.14-Setup.exe' }
  const valid = summarizeRelease(release, { tag, version: '0.4.14' })
  assert.equal(valid.recovery_metadata_ok, true)
  assert.equal(valid.assets[0].temporary_url_matches, true)
  assert.equal(valid.assets[0].download_url_matches, false)
})

test('metadata diagnosis refuses changed identities and ignores other draft titles', () => {
  const routes = []
  const api = route => {
    routes.push(route)
    return [{ id: 1, draft: true, name: '余音 PC 0.4.12', tag_name: 'untagged-other', assets: [] }]
  }
  assert.equal(inspectCurrentRelease(api, { tag, version: '0.4.14' }).found, false)
  assert.deepEqual(routes, ['releases?per_page=100&page=1'])
  assert.throws(() => inspectCurrentRelease(route => route.startsWith('releases?')
    ? [{ id: 1, draft: true, name: '余音 PC 0.4.14', tag_name: 'untagged-a', assets: [] }]
    : { id: 1, draft: true, name: '余音 PC 0.4.12', assets: [] }, { tag, version: '0.4.14' }), /changed/)
})
