import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { diagnoseFailedPublication, extractPublishFailure, reportDiagnostic, sanitizeDiagnostic, selectFailedTagRun } from './diagnose-release-failure.mjs'

const repository = 'panda472328/yuyin-music'
const publishStep = 'Publish one installer, then advance stable channel'
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
    url: 'https://github.com/' + repository + '/actions/runs/' + run.id,
    message: 'Error: GitHub 操作失败：release upload（退出码：1）。gh: HTTP 403: Resource not accessible by integration\n##[error]Process completed with exit code 1.' })
  assert.equal(f.calls.length, 5)
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
  assert.equal(f.calls.length, 2)
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
