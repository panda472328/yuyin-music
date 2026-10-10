import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const versionPattern = /^(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*))?(?:[+][0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?$/

function checkVersion(value, location) {
  const match = typeof value === 'string' && value.match(versionPattern)
  if (!match || match[1]?.split('.').some(part => /^0[0-9]+$/.test(part))) {
    throw new Error(`${location}: invalid SemVer ${JSON.stringify(value)}`)
  }
}

function checkDependencyRanges(entry, location) {
  for (const group of dependencyGroups) {
    for (const [name, range] of Object.entries(entry[group] || {})) {
      if (typeof range !== 'string' || !range.trim()) throw new Error(`${location}.${group}.${name}: missing dependency range`)
      // npm ci remains the range grammar authority; catch malformed numeric metadata before downloads.
      const versions = range.matchAll(/(?:^|[^0-9A-Za-z._-])v?([0-9]+|[xX*])(?:[.]([0-9]+|[xX*]))?(?:[.]([0-9]+|[xX*]))?(?:-([0-9A-Za-z.-]+))?/g)
      for (const match of versions) {
        const numbers = [...match.slice(1, 4), ...(match[4]?.split('.') || [])]
        if (numbers.some(part => /^0[0-9]+$/.test(part || ''))) {
          throw new Error(`${location}.${group}.${name}: dependency range contains a leading zero: ${range}`)
        }
      }
    }
  }
}

export function checkReleaseLock(pkg, lock) {
  if (lock.lockfileVersion !== 3 || !lock.packages || Array.isArray(lock.packages)) throw new Error('Expected package-lock.json lockfileVersion 3 with packages metadata')
  checkVersion(pkg.version, 'package.json.version')
  checkDependencyRanges(pkg, 'package.json')
  checkVersion(lock.version, 'package-lock.json.version')
  if (lock.version !== pkg.version || lock.packages['']?.version !== pkg.version) throw new Error('Package and lock root versions differ')
  let count = 0
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${key || 'root'}: invalid package metadata`)
    checkVersion(entry.version, `${key || 'root'}.version`)
    checkDependencyRanges(entry, key || 'root')
    if (!key) continue
    let resolved
    try { resolved = new URL(entry.resolved) } catch { throw new Error(`${key}: missing or invalid resolved URL`) }
    if (resolved.protocol !== 'https:' || resolved.hostname !== 'registry.npmjs.org' || resolved.port || resolved.username || resolved.password) {
      throw new Error(`${key}: resolved URL must use https://registry.npmjs.org`)
    }
    count++
  }
  return count
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  console.log(`Release lock metadata verified: ${checkReleaseLock(pkg, lock)} packages, official npm registry only`)
}
