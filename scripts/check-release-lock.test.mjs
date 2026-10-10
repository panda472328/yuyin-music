import test from 'node:test'
import assert from 'node:assert/strict'
import { checkReleaseLock } from './check-release-lock.mjs'

function fixture() {
  const pkg = { version: '1.2.3', dependencies: { example: '^2.0.0' } }
  return { pkg, lock: { version: pkg.version, lockfileVersion: 3, packages: {
    '': structuredClone(pkg),
    'node_modules/example': { version: '2.1.0', resolved: 'https://registry.npmjs.org/example/-/example-2.1.0.tgz', dependencies: { child: '>=1.0.0 <3 || 4.x' } }
  } } }
}

test('valid lock metadata works without any installed dependencies', () => {
  const { pkg, lock } = fixture()
  assert.equal(checkReleaseLock(pkg, lock), 1)
  lock.packages['node_modules/example'].version = '2.1.0-beta.0+build.01'
  assert.equal(checkReleaseLock(pkg, lock), 1)
})

test('invalid exact lock versions identify the affected package before npm ci', () => {
  for (const version of ['01.2.3', '1.02.3', '1.2.03', '1.2', 'v1.2.3', '1.2.3-beta.01']) {
    const { pkg, lock } = fixture()
    lock.packages['node_modules/example'].version = version
    assert.throws(() => checkReleaseLock(pkg, lock), new RegExp('node_modules/example\\.version: invalid SemVer'))
  }
})

test('leading zeros in root and transitive dependency ranges are rejected', () => {
  for (const range of ['^04.0.0', '~1.02', '>= 1.2.03', '1.0.0 || 02.x', '1.0.0 - 02.0.0', '^1.0.0-beta.01']) {
    const { pkg, lock } = fixture()
    lock.packages['node_modules/example'].dependencies.child = range
    assert.throws(() => checkReleaseLock(pkg, lock), /dependency range contains a leading zero/)
    pkg.dependencies.example = range
    assert.throws(() => checkReleaseLock(pkg, lock), /package.json.dependencies.example/)
  }
})

test('official HTTPS registry is required for all locked tarballs', () => {
  for (const resolved of [undefined, 'file:example.tgz', 'http://registry.npmjs.org/example.tgz', 'https://registry.npmmirror.com/example.tgz', 'https://registry.npmjs.org.example.com/example.tgz', 'https://user@registry.npmjs.org/example.tgz', 'https://registry.npmjs.org:8443/example.tgz']) {
    const { pkg, lock } = fixture()
    lock.packages['node_modules/example'].resolved = resolved
    assert.throws(() => checkReleaseLock(pkg, lock), new RegExp('node_modules/example: (missing or invalid resolved URL|resolved URL must use)'))
  }
})

test('missing lock metadata or divergent root versions fail early', () => {
  const { pkg, lock } = fixture()
  assert.throws(() => checkReleaseLock(pkg, { ...lock, lockfileVersion: 2 }), /lockfileVersion 3/)
  assert.throws(() => checkReleaseLock(pkg, { ...lock, version: '1.2.2' }), /versions differ/)
})
