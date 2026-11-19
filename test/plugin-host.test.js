import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
import { HR_SERVICE } from '../lib/contract.js'

function hostContext({ llm = false } = {}) {
  const provided = new Map(); const contributions = []
  const typert = { register(value) { contributions.push(value); return () => {} } }
  const available = { typert, ...(llm ? { llm: { stream: async function * () {} } } : {}) }
  const ctx = {
    provide(name, value) { provided.set(name, value) },
    inject(names, callback) {
      if (!names.every((name) => Object.hasOwn(available, name))) return () => {}
      const child = Object.create(ctx)
      Object.assign(child, available)
      return callback(child)
    },
  }
  return { ctx, provided, contributions }
}

test('main panel and RPC register without llm; optional llm attaches when available', async () => {
  const withoutModel = hostContext()
  apply(withoutModel.ctx, { dataDir: join(tmpdir(), 'test-hr-no-model') })
  const plain = withoutModel.provided.get(HR_SERVICE)
  assert.ok(plain, 'typert alone must be enough to provide the HR service')
  assert.equal((await plain.capabilities()).configured, false)
  assert.equal(withoutModel.contributions.length, 1)

  const withModel = hostContext({ llm: true })
  apply(withModel.ctx, { dataDir: join(tmpdir(), 'test-hr-with-model') })
  const attached = withModel.provided.get(HR_SERVICE)
  assert.equal((await attached.capabilities()).configured, true)
  assert.equal((await attached.capabilities()).baseUrl, 'host:deepseek-account')
  assert.equal(withModel.contributions.length, 1)
})
