import test from 'node:test'
import assert from 'node:assert/strict'
import { CredentialGateway } from '../lib/credential-gateway.js'
import { DeepSeekSpeech } from '../lib/deepseek-speech.js'
import { SpeechGateway } from '../lib/speech-gateway.js'
import { parseApiKey } from '../lib/contract.js'

function canonicalWav(seconds = 0.1) {
  const samples = Math.max(1, Math.floor(16000 * seconds)); const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40)
  for (let index = 0; index < samples; index += 1) bytes.writeInt16LE(index % 2 ? 1000 : -1000, 44 + index * 2)
  return bytes
}

function credentialService({ source = 'file', readOnly = false } = {}) {
  let stored = null
  return {
    async resolve(key) { assert.equal(key, 'DEEPSEEK_API_KEY'); return stored ? { value: stored, source } : undefined },
    async describe(key) { assert.equal(key, 'DEEPSEEK_API_KEY'); return { configured: Boolean(stored), source: stored ? source : undefined, writable: !readOnly } },
    async set(key, value) { assert.equal(key, 'DEEPSEEK_API_KEY'); if (readOnly) throw new Error('read-only by the launching environment; set would be shadowed'); stored = value },
    async unset(key) { assert.equal(key, 'DEEPSEEK_API_KEY'); if (readOnly) throw new Error('read-only by the launching environment; unset would be shadowed'); stored = null },
    get value() { return stored }, set value(value) { stored = value },
  }
}

function fetchFor(headers, { fail = false } = {}) {
  return async (url, options) => {
    headers.push(options.headers.authorization)
    if (fail) return new Response(`invalid key ${options.headers.authorization}`, { status: 401 })
    if (url.endsWith('/asr')) return new Response(JSON.stringify({ request_id: 'stored-asr', text: '识别成功', duration_ms: 100 }), { status: 200 })
    return new Response(canonicalWav(), { status: 200, headers: { 'content-type': 'audio/wav' } })
  }
}

test('credential status uses real DSH file fields and validates save/clear input', async () => {
  const service = credentialService(); const gateway = new CredentialGateway({ service, env: {} })
  assert.deepEqual(await gateway.describe(), { configured: false, source: null, writable: true })
  assert.throws(() => parseApiKey(''), /8–512/); assert.throws(() => parseApiKey('has whitespace'), /空白/)
  assert.deepEqual(await gateway.save('  sk-stored-12345678  '), { configured: true, source: 'file', writable: true })
  assert.equal(service.value, 'sk-stored-12345678')
  assert.equal(await gateway.resolve(), 'sk-stored-12345678')
  assert.equal((await gateway.clear()).configured, false); assert.equal(service.value, null)
})

test('newly saved key is used per request without rebuilding the adapter, then rotates immediately', async () => {
  const service = credentialService(); const gateway = new CredentialGateway({ service, env: {} }); const headers = []
  const adapter = new DeepSeekSpeech({}, fetchFor(headers), {}, { credentials: gateway })
  assert.equal(adapter.capabilities().asrConfigured, false)
  await gateway.save('sk-first-12345678')
  assert.equal((await adapter.credentialStatus()).configured, true)
  assert.equal(adapter.capabilities().ttsConfigured, true)
  await adapter.synthesize('你好')
  service.value = 'sk-second-12345678'
  const result = await adapter.transcribe({ audioBase64: canonicalWav().toString('base64'), mimeType: 'audio/wav', durationMs: 100 })
  assert.equal(result.text, '识别成功')
  assert.deepEqual(headers, ['Bearer sk-first-12345678', 'Bearer sk-second-12345678'])
})

test('explicit configuration wins over stored credential and stored failures never echo a saved secret', async () => {
  const service = credentialService(); service.value = 'sk-stored-abcdefgh'; const gateway = new CredentialGateway({ service, env: {} })
  const headers = []
  const adapter = new DeepSeekSpeech({ deepSeekApiKey: 'sk-config-abcdefgh' }, fetchFor(headers), {}, { credentials: gateway })
  await adapter.synthesize('你好'); assert.deepEqual(headers, ['Bearer sk-config-abcdefgh'])
  const failing = new DeepSeekSpeech({}, fetchFor([], { fail: true }), {}, { credentials: gateway })
  await assert.rejects(failing.synthesize('你好'), (error) => {
    assert.equal(error.code, 'hr-interview/deepseek-tts-http')
    assert.equal(error.message.includes('sk-stored-abcdefgh'), false)
    assert.equal(error.message.includes('[redacted]'), true)
    return true
  })
})

test('environment remains a fallback and saving is unavailable without credential service', async () => {
  const gateway = new CredentialGateway({ service: null, env: { DEEPSEEK_API_KEY: 'sk-environment-12345678' } })
  assert.equal(await gateway.resolve(), 'sk-environment-12345678')
  assert.deepEqual(await gateway.describe(), { configured: true, source: 'env', writable: false })
  await assert.rejects(gateway.save('sk-new-12345678'), /启动环境变量/)
  const speech = new SpeechGateway({}, fetch, { credentials: null })
  await assert.rejects(speech.saveApiKey('sk-new-12345678'), /凭据服务/)
})

test('SpeechGateway exposes save, clear and fresh capabilities through one credential gateway', async () => {
  const service = credentialService(); const gateway = new CredentialGateway({ service, env: {} }); const headers = []
  const speech = new SpeechGateway({}, fetchFor(headers), { credentials: gateway })
  assert.equal((await speech.currentCapabilities()).deepSeekAsrConfigured, false)
  const saved = await speech.saveApiKey('sk-persistent-test')
  assert.deepEqual(saved, { configured: true, source: 'file', writable: true })
  const recognized = await speech.transcribe({ audioBase64: canonicalWav().toString('base64'), mimeType: 'audio/wav', durationMs: 100 })
  assert.equal(recognized.text, '识别成功'); assert.deepEqual(headers, ['Bearer sk-persistent-test'])
  const capabilities = await speech.currentCapabilities()
  assert.equal(capabilities.deepSeekAsrConfigured, true); assert.equal(capabilities.deepSeekTtsConfigured, true)
  assert.deepEqual(capabilities.deepSeekCredential, { configured: true, source: 'file', writable: true })
  await speech.clearApiKey(); assert.equal((await speech.currentCapabilities()).deepSeekAsrConfigured, false)
})

test('launch environment shadows stored writes and provider shadow errors become stable Chinese failures', async () => {
  const service = credentialService(); service.value = 'sk-stored-abcdefgh'
  const gateway = new CredentialGateway({ service, env: { DEEPSEEK_API_KEY: 'sk-environment-12345678' } })
  await assert.rejects(gateway.save('sk-new-12345678'), (error) => error.code === 'hr-interview/credential-shadowed')
  await assert.rejects(gateway.clear(), (error) => error.code === 'hr-interview/credential-shadowed')
  assert.equal(service.value, 'sk-stored-abcdefgh')
  const providerReadOnly = new CredentialGateway({ service: credentialService({ readOnly: true }), env: {} })
  await assert.rejects(providerReadOnly.save('sk-new-12345678'), (error) => error.code === 'hr-interview/credential-shadowed')
})

test('file, project-env and user-env sources stay distinct and remain writable', async () => {
  for (const source of ['file', 'project-env', 'user-env']) {
    const service = credentialService({ source }); service.value = `sk-${source}-abcdefgh`
    const gateway = new CredentialGateway({ service, env: {} })
    assert.deepEqual(await gateway.describe(), { configured: true, source, writable: true })
    assert.equal((await gateway.clear()).configured, false)
  }
})

test('credential provider failures fall back without breaking environment recognition', async () => {
  const service = credentialService()
  service.resolve = async () => { throw new Error('temporary credential failure') }
  service.describe = async () => { throw new Error('temporary credential failure') }
  const gateway = new CredentialGateway({ service, env: {} })
  assert.equal(await gateway.resolve(), null)
  assert.deepEqual(await gateway.describe(), { configured: false, source: null, writable: false })
  const fallback = new CredentialGateway({ service, env: { DEEPSEEK_API_KEY: 'sk-env-fallback-12345678' } })
  assert.equal(await fallback.resolve(), 'sk-env-fallback-12345678')
  assert.equal((await fallback.describe()).source, 'env')
})
