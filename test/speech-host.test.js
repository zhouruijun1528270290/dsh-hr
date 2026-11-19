import test from 'node:test'
import assert from 'node:assert/strict'
import { SpeechGateway } from '../lib/speech-gateway.js'

function wave(samples = [0, 1000, -1000]) {
  const bytes = Buffer.alloc(44 + samples.length * 2)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24)
  bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40)
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, 44 + index * 2))
  return bytes
}
function host(phase = 'ready') {
  const provider = { id: 'sensevoice-local', preparation: { phase } }
  return { snapshot: () => ({ providers: [provider], selection: { providerId: provider.id, language: 'zh' } }) }
}
test('local speech capability and canonical WAV transcription use the selected DSH provider', async () => {
  const speechToText = host(); let resolved = null
  speechToText.resolve = (value) => { resolved = value; return { provider: 'selected', audio: value.audio } }
  speechToText.transcribe = async (spec, signal) => { assert.equal(spec.provider, 'selected'); assert.ok(signal); return { text: ' 本地转写结果 ', audioSeconds: 0.1, inferenceSeconds: 0.1 } }
  const gateway = new SpeechGateway({}, () => { throw new Error('HTTP must not be called') }, { speechToText })
  assert.equal(gateway.capabilities().asrMode, 'host-local'); assert.equal(gateway.capabilities().asrConfigured, true)
  const bytes = wave(); const result = await gateway.transcribe({ audioBase64: bytes.toString('base64'), mimeType: 'audio/wav' })
  assert.equal(result.text, '本地转写结果'); assert.equal(result.model, 'sensevoice-local'); assert.ok(resolved.audio.equals(bytes)); assert.equal(resolved.language, 'zh')
})
test('local speech rejects noncanonical audio and reports an unprepared provider without HTTP leakage', async () => {
  const ready = new SpeechGateway({ speechProvider: 'local' }, fetch, { speechToText: host() })
  await assert.rejects(ready.transcribe({ audioBase64: Buffer.from('webm').toString('base64'), mimeType: 'audio/webm' }), (error) => error.code === 'hr-interview/asr-wave-required')
  const pending = new SpeechGateway({ speechProvider: 'local' }, fetch, { speechToText: host('downloading') })
  assert.equal(pending.capabilities().asrConfigured, false); assert.equal(pending.capabilities().asrPreparation, 'downloading')
  await assert.rejects(pending.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav' }), (error) => error.code === 'hr-interview/asr-preparation')
})
test('explicit DeepSeek routing uses the dedicated endpoints and selected voice', async () => {
  const calls = []
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return url.endsWith('/asr') ? new Response(JSON.stringify({ text: '云端识别', request_id: 'req-host', duration_ms: 1000 })) : new Response(wave(), { headers: { 'content-type': 'audio/wav' } }) }
  const gateway = new SpeechGateway({ deepSeekApiKey: 'sk-test-host-key' }, fetchImpl, {})
  const result = await gateway.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 1000 }, { provider: 'deepseek' })
  const speech = await gateway.synthesize('你好', { provider: 'deepseek', voice: 'tide' })
  assert.equal(result.model, 'deepseek-asr'); assert.equal(speech.voice, 'tide'); assert.deepEqual(calls.map((call) => call.url), ['https://api.deepseek.com/v1/tools/asr', 'https://api.deepseek.com/v1/tools/tts'])
})
test('browser speech preference only affects TTS and leaves ASR on automatic routing', async () => {
  const gateway = new SpeechGateway({ speechProvider: 'browser', deepSeekApiKey: 'sk-browser-pref' }, async () => new Response(JSON.stringify({ text: '自动云端识别', duration_ms: 1000 })), {})
  assert.equal(gateway.capabilities().asrMode, 'deepseek')
  assert.equal(gateway.capabilities().asrConfigured, true)
  const result = await gateway.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 1000 })
  assert.equal(result.text, '自动云端识别')
  await assert.rejects(gateway.synthesize('你好'), (error) => error.code === 'hr-interview/tts-browser-only')
})
test('browser TTS selection never calls a Host HTTP endpoint', async () => {
  const gateway = new SpeechGateway({}, () => { throw new Error('HTTP must not be called') }, {})
  await assert.rejects(gateway.synthesize('你好', { provider: 'browser' }), (error) => error.code === 'hr-interview/tts-browser-only')
})
test('explicit HTTP ASR without a base URL reports unconfigured instead of ready', () => {
  const gateway = new SpeechGateway({ speechProvider: 'http' }, () => { throw new Error('HTTP must not be called') }, {})
  const capabilities = gateway.capabilities()
  assert.equal(capabilities.asrMode, 'http')
  assert.equal(capabilities.asrConfigured, false)
  assert.equal(capabilities.asrStatus, 'unconfigured')
})
test('local transcription failures are converted to bounded remote errors', async () => {
  const speechToText = host(); speechToText.resolve = () => ({}); speechToText.transcribe = async () => { throw new Error('synthetic inference failure') }
  const gateway = new SpeechGateway({}, fetch, { speechToText })
  await assert.rejects(gateway.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav' }), (error) => error.code === 'hr-interview/asr-local')
})
test('generic HTTP ASR and TTS sanitize echoed custom keys, Bearer tokens and oversized bodies', async () => {
  const key = 'hrgw-custom-key-9f3a2b'
  const noisy = `denied ${key} Bearer ${key} sk-live-abcdef123456 ${'z'.repeat(1200)}`
  const audioBody = { audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 1000 }

  const asr = new SpeechGateway({ asrBaseUrl: 'http://asr.local', asrApiKey: key }, async () => new Response(noisy, { status: 401 }), {})
  await assert.rejects(asr.transcribe(audioBody, { provider: 'http' }), (error) => {
    assert.equal(error.code, 'hr-interview/asr-http')
    assert.equal(error.message.includes(key), false)
    assert.equal(error.message.includes('sk-live-abcdef123456'), false)
    assert.match(error.message, /^ASR HTTP 401: /)
    assert.ok(error.message.length <= 500)
    return true
  })

  const offline = new SpeechGateway({ asrBaseUrl: 'http://asr.local', asrApiKey: key }, async () => { throw new Error(`connect failed for ${key}`) }, {})
  await assert.rejects(offline.transcribe(audioBody, { provider: 'http' }), (error) => {
    assert.equal(error.code, 'hr-interview/asr-network')
    assert.equal(error.message.includes(key), false)
    assert.ok(error.message.length <= 500)
    return true
  })

  const tts = new SpeechGateway({ ttsBaseUrl: 'http://tts.local', ttsApiKey: key }, async () => new Response(noisy, { status: 429 }), {})
  await assert.rejects(tts.synthesize('你好', { provider: 'http' }), (error) => {
    assert.equal(error.code, 'hr-interview/tts-http')
    assert.equal(error.message.includes(key), false)
    assert.equal(error.message.includes('Bearer ' + key), false)
    assert.match(error.message, /^TTS HTTP 429: /)
    assert.ok(error.message.length <= 500)
    return true
  })
})
test('the caller signal reaches generic HTTP requests and the local provider', async () => {
  const signals = []
  const fetchImpl = async (url, options) => {
    signals.push(options.signal)
    return url.endsWith('/audio/transcriptions')
      ? new Response(JSON.stringify({ text: '远端识别' }), { headers: { 'content-type': 'application/json' } })
      : new Response(wave(), { headers: { 'content-type': 'audio/mpeg' } })
  }
  const gateway = new SpeechGateway({ asrBaseUrl: 'http://asr.local', ttsBaseUrl: 'http://tts.local' }, fetchImpl, {})
  const asr = new AbortController(); const tts = new AbortController()
  await gateway.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 1000 }, { provider: 'http', signal: asr.signal })
  await gateway.synthesize('你好', { provider: 'http', signal: tts.signal })
  assert.equal(signals.length, 2)
  asr.abort(); tts.abort()
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[1].aborted, true)

  const speechToText = host(); let received = null
  speechToText.resolve = (value) => ({ audio: value.audio })
  speechToText.transcribe = async (spec, signal) => { received = signal; return { text: '本地转写' } }
  const local = new SpeechGateway({}, () => { throw new Error('HTTP must not be called') }, { speechToText })
  const controller = new AbortController()
  const result = await local.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav' }, { signal: controller.signal })
  assert.equal(result.text, '本地转写')
  assert.ok(received instanceof AbortSignal)
  assert.equal(received.aborted, false)
  controller.abort()
  assert.equal(received.aborted, true)
})

test('auto ASR without any provider reports unconfigured before audio upload', async () => {
  const previous = process.env.DEEPSEEK_API_KEY; const previousDedicated = process.env.HR_INTERVIEW_DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY; delete process.env.HR_INTERVIEW_DEEPSEEK_API_KEY
  let calls = 0
  try {
    const gateway = new SpeechGateway({}, async () => { calls += 1; throw new Error('unexpected HTTP') }, {})
    const capabilities = await gateway.currentCapabilities()
    assert.equal(capabilities.asrMode, 'unconfigured'); assert.equal(capabilities.asrStatus, 'unconfigured')
    await assert.rejects(gateway.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 1000 }), (error) => {
      assert.equal(error.code, 'hr-interview/asr-not-configured'); assert.match(error.message, /尚未配置/); return true
    })
    assert.equal(calls, 0)
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous
    if (previousDedicated === undefined) delete process.env.HR_INTERVIEW_DEEPSEEK_API_KEY; else process.env.HR_INTERVIEW_DEEPSEEK_API_KEY = previousDedicated
  }
})
