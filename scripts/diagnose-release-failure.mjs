import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repository = 'panda472328/yuyin-music'
const workflowPath = '.github/workflows/release.yml'
const publishStep = 'Publish one installer, then advance stable channel'
const stableTag = /^pc-v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/

export function sanitizeDiagnostic(value, secrets = []) {
  let detail = String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  for (const secret of secrets) if (secret) detail = detail.replaceAll(secret, '[REDACTED]')
  return detail
    .replace(/^.*\b(?:proxy-)?authorization\b.*$/gim, '[REDACTED authentication header]')
    .replace(/^.*\b(?:GH_TOKEN|GITHUB_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|PASSWORD)\b\s*[:=].*$/gim, '[REDACTED credential]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)\b/g, '[REDACTED]')
    // Signed download URLs may carry credentials in the path as well as the query.
    .replace(/https?:\/\/[^\s<>"']+/gi, '[REDACTED URL]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

export function extractPublishFailure(log, secrets = []) {
  // gh prefixes each log line with the job and step name. Never emit another step's log.
  const lines = String(log).split(/\r?\n/).flatMap(line => {
    const fields = line.split('\t')
    if (fields[0] !== 'release' || fields[1] !== publishStep || fields.length < 3) return []
    return fields.slice(2).join('\t').replace(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z\s*/, '')
  })
  const clean = sanitizeDiagnostic(lines.join('\n'), secrets)
  const messages = [...new Set(clean.split(/\r?\n/).filter(line =>
    /(?:\b(?:Error|SyntaxError|TypeError|RangeError):|GitHub 操作失败|\bHTTP [45]\d\d\b|\bgh:|##\[error\]|Process completed with exit code)/.test(line)
  ))]
  if (!messages.length) throw new Error('The final Publish step had no recognizable error; raw logs were withheld.')
  return messages.slice(0, 8).map(line => line.trim().slice(0, 600)).join('\n').slice(0, 1800)
}

function safeAsset(asset, expectedUrl, expectedFilename) {
  const downloadUrl = typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : ''
  const prefix = 'https://github.com/' + repository + '/releases/download/untagged-'
  const parts = downloadUrl.startsWith(prefix) ? downloadUrl.slice(prefix.length).split('/') : []
  return {
    name: asset?.name === expectedFilename ? expectedFilename : '[unexpected name]',
    size: Number.isSafeInteger(asset?.size) ? asset.size : null,
    state: ['uploaded', 'new', 'open'].includes(asset?.state) ? asset.state : '[invalid]',
    digest: typeof asset?.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(asset.digest) ? asset.digest : '[invalid]',
    download_url_matches: downloadUrl === expectedUrl,
    temporary_url_matches: parts.length === 2 && /^[A-Za-z0-9_-]+$/.test(parts[0]) && parts[1] === expectedFilename,
  }
}

export function summarizeRelease(release, { tag, version }) {
  const filename = 'Yuyin-' + version + '-Setup.exe'
  const expectedUrl = 'https://github.com/' + repository + '/releases/download/' + tag + '/' + filename
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const summary = {
    id: Number.isSafeInteger(release?.id) ? release.id : null,
    tag_name: release?.tag_name === tag || /^untagged-[A-Za-z0-9_-]+$/.test(release?.tag_name ?? '') ? release.tag_name : '[unexpected]',
    draft: typeof release?.draft === 'boolean' ? release.draft : null,
    prerelease: typeof release?.prerelease === 'boolean' ? release.prerelease : null,
    created_at: /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(release?.created_at ?? '') ? release.created_at : '[missing]',
    assets: assets.slice(0, 2).map(asset => safeAsset(asset, expectedUrl, filename)),
    asset_count: assets.length,
  }
  summary.creation_readback_ok = summary.draft === true && summary.prerelease === false && summary.asset_count === 0
  summary.creation_readback_reasons = []
  if (summary.draft !== true) summary.creation_readback_reasons.push('draft must be true')
  if (summary.prerelease !== false) summary.creation_readback_reasons.push('prerelease must be false')
  if (summary.asset_count !== 0) summary.creation_readback_reasons.push('assets.length=' + summary.asset_count + ' (expected 0 while creating draft)')
  summary.recovery_reasons = []
  if (summary.id === null || summary.id < 1) summary.recovery_reasons.push('Release ID must be a positive integer')
  if (release?.tag_name !== tag) summary.recovery_reasons.push('Release tag differs from current PC tag')
  if (release?.prerelease !== false) summary.recovery_reasons.push('prerelease must be false')
  if (summary.draft === null) summary.recovery_reasons.push('draft must be boolean')
  if (!Array.isArray(release?.assets) || assets.length !== 1) summary.recovery_reasons.push('Existing Release must contain exactly one installer')
  if (assets.length === 1) {
    const asset = assets[0]
    const safe = summary.assets[0]
    if (!Number.isSafeInteger(asset?.id) || asset.id < 1) summary.recovery_reasons.push('Installer ID must be a positive integer')
    if (asset?.name !== filename) summary.recovery_reasons.push('Installer name differs from the versioned Setup.exe')
    if (asset?.state !== 'uploaded') summary.recovery_reasons.push('Installer state must be uploaded')
    if (!Number.isSafeInteger(asset?.size) || asset.size < 2 || asset.size > 500000000) summary.recovery_reasons.push('Installer size is invalid or exceeds the PC limit')
    if (!/^sha256:[a-f0-9]{64}$/.test(asset?.digest ?? '')) summary.recovery_reasons.push('Installer SHA-256 digest is missing or invalid')
    if (!safe.download_url_matches && !(summary.draft && safe.temporary_url_matches)) summary.recovery_reasons.push('Installer download URL does not match current or allowed draft URL')
  }
  summary.recovery_metadata_ok = summary.recovery_reasons.length === 0
  return summary
}

export function inspectCurrentRelease(api, { tag, version }) {
  let tagged
  let matchingDraft
  let complete = false
  for (let page = 1; page <= 100; page++) {
    const releases = api('releases?per_page=100&page=' + page)
    if (!Array.isArray(releases)) throw new Error('Invalid release list response.')
    for (const release of releases) {
      if (release?.tag_name === tag) {
        if (tagged) throw new Error('Multiple Releases use the current tag.')
        tagged = release
      }
      if (release?.draft === true && release?.name === '余音 PC ' + version) {
        if (matchingDraft) throw new Error('Multiple exact-title PC drafts found; metadata diagnosis stopped.')
        matchingDraft = release
      }
    }
    if (releases.length < 100) { complete = true; break }
  }
  if (!complete) throw new Error('Release metadata pagination limit exceeded.')
  const selected = tagged ?? matchingDraft
  if (!selected) return { found: false, current_tag_found: false, tag, title: '余音 PC ' + version, reason: 'No current-tag Release or exact-title PC draft found.' }
  if (!Number.isSafeInteger(selected.id) || selected.id < 1) throw new Error('Release metadata has invalid ID.')
  const detail = api('releases/' + selected.id)
  if (!detail || detail.id !== selected.id || (tagged ? detail.tag_name !== tag :
    detail.draft !== true || detail.name !== '余音 PC ' + version)) throw new Error('Release metadata changed before detail read.')
  const summary = summarizeRelease(detail, { tag, version })
  return { found: true, current_tag_found: Boolean(tagged), source: tagged ? 'tag' : 'exact-title-draft', ...summary }
}

export function selectFailedTagRun(runs, tag, commit) {
  if (!Array.isArray(runs)) throw new Error('Invalid workflow run response.')
  const selected = runs.filter(run => run.event === 'push' && run.head_branch === tag &&
    run.head_sha === commit && run.path === workflowPath && run.head_repository?.full_name === repository &&
    run.status === 'completed' && run.conclusion === 'failure')
    .sort((a, b) => b.run_number - a.run_number || b.id - a.id)[0]
  if (selected && (!Number.isSafeInteger(selected.id) || selected.id < 1 ||
    !Number.isSafeInteger(selected.run_number) || selected.run_number < 1 ||
    !Number.isSafeInteger(selected.run_attempt) || selected.run_attempt < 1)) {
    throw new Error('Invalid failed workflow run identity.')
  }
  return selected
}

function execute(file, args, options) {
  return execFileSync(file, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
}

export function diagnoseFailedPublication({ root = process.cwd(), env = process.env, command = execute } = {}) {
  // This helper has no local authentication fallback and has no mutation command.
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== repository ||
    !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) || env.GITHUB_REF !== 'refs/heads/main' ||
    !env.GH_TOKEN || !env.GITHUB_STEP_SUMMARY) throw new Error('Diagnostic requires the main Actions job and its ephemeral GITHUB_TOKEN.')
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const tag = `pc-v${packageJson.version}`
  if (packageJson.name !== 'yuyin-music' || !stableTag.test(tag) || env.REQUESTED_TAG && env.REQUESTED_TAG !== tag) {
    throw new Error('Diagnostic may inspect only the current package stable PC tag.')
  }
  const options = { cwd: root, env }
  const commit = command('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], options).trim()
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) throw new Error('Invalid current tag commit.')
  const gh = args => command(process.platform === 'win32' ? 'gh.exe' : 'gh', args, options)
  const api = route => JSON.parse(gh(['api', '--method', 'GET', `repos/${repository}/${route}`]))
  const releaseMetadata = inspectCurrentRelease(api, { tag, version: packageJson.version })
  const response = api(`actions/workflows/release.yml/runs?event=push&branch=${tag}&status=failure&per_page=100`)
  const candidate = selectFailedTagRun(response.workflow_runs, tag, commit)
  if (!candidate) return { tag, commit, releaseMetadata, message: 'No failed tag publication exists for this source; no logs were read.' }
  const run = api(`actions/runs/${candidate.id}`)
  if (selectFailedTagRun([run], tag, commit)?.id !== candidate.id ||
    run.run_number !== candidate.run_number || run.run_attempt !== candidate.run_attempt) {
    throw new Error('Failed run identity changed before reading logs.')
  }
  const jobs = api(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`).jobs
  const releaseJobs = Array.isArray(jobs) ? jobs.filter(job => job.name === 'release') : []
  const steps = releaseJobs.length === 1 && Array.isArray(releaseJobs[0].steps) ? releaseJobs[0].steps : []
  const failed = steps.filter(step => step.conclusion === 'failure')
  if (failed.length !== 1 || failed[0].name !== publishStep) throw new Error('Only a failure in the final Publish step may be diagnosed.')
  const log = gh(['run', 'view', String(run.id), '--repo', repository, '--attempt', String(run.run_attempt), '--log-failed'])
  return { tag, commit, releaseMetadata, runId: run.id, attempt: run.run_attempt,
    url: `https://github.com/${repository}/actions/runs/${run.id}`,
    message: extractPublishFailure(log, [env.GH_TOKEN, env.GITHUB_TOKEN]) }
}

function annotation(value) {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

export function reportDiagnostic(result, summary) {
  const identity = result.runId ? `${result.tag}, run ${result.runId}, attempt ${result.attempt}` : result.tag
  console.log(`::warning title=Read-only publication diagnosis::${annotation(`${identity}: ${result.message}`)}`)
  const message = result.message.replace(/`/g, '\u02cb')
  if (result.releaseMetadata) {
    const metadata = JSON.stringify(result.releaseMetadata)
    console.log(`::warning title=Read-only Release metadata::${annotation(metadata)}`)
    fs.appendFileSync(summary, `### Read-only Release metadata and recovery checks\n\n\`\`\`json\n${JSON.stringify(result.releaseMetadata, null, 2)}\n\`\`\`\n\nOnly allowlisted fields and URL-match booleans are shown. Release body, author and URL text are withheld.\n\n`)
  }
  fs.appendFileSync(summary, `### Read-only publication diagnosis\n\n${identity}\n\n${result.url ? `[Original failed run](${result.url})\n\n` : ''}\`\`\`text\n${message}\n\`\`\`\n\nOnly the current tagged source and final Publish error were inspected. Tokens, authentication headers and all logged URLs were removed. No logs were uploaded and no Release was changed.\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('This diagnostic does not accept run, repository or credential overrides.')
    reportDiagnostic(diagnoseFailedPublication(), process.env.GITHUB_STEP_SUMMARY)
  } catch (error) {
    const detail = sanitizeDiagnostic(error.stderr ?? error.message, [process.env.GH_TOKEN, process.env.GITHUB_TOKEN]).trim().slice(0, 1200)
    console.log(`::error title=Publication diagnosis stopped::${annotation(detail || 'No diagnostic details were returned.')}`)
    process.exitCode = 1
  }
}
