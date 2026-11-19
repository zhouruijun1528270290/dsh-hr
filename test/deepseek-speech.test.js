import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DeepSeekSpeech,
  DEEPSEEK_ASR_ENDPOINT,
  DEEPSEEK_TTS_ENDPOINT,
  DEEPSEEK_ASR_MAX_BYTES,
} from '../lib/deepseek-speech.js'

const KEY = 'sk-test-deepseek-key-0123456789'

// 44 字节标准头：RIFF/WAVE/fmt /data，16 kHz、单声道、16 bit PCM。
function wave(samples = [0, 800, -800, 400]) {
  const bytes = Buffer.alloc(44 + samples.length * 2)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24)
  bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36)
  bytes.writeUInt32LE(samples.length * 2, 40)
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, 44 + index * 2))
  return bytes
}

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

const audio = (bytes, status = 200, type = 'audio/wav') =>
  new Response(new Uint8Array(bytes), { status, headers: { 'content-type': type } })

const capture = () => {
  const calls = []
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return calls.handler(url, options) }
  return { calls, fetchImpl }
}

const code = (promise) => promise.then(() => 'resolved', (error) => error?.code)

test('capabilities report configuration and the two DeepSeek voices', () => {
  const bare = new DeepSeekSpeech({}, fetch, {})
  assert.deepEqual(bare.capabilities(), { asrConfigured: false, ttsConfigured: false, voices: ['stella', 'tide'] })

  const envFallback = new DeepSeekSpeech({}, fetch, { DEEPSEEK_API_KEY: KEY })
  assert.deepEqual(envFallback.capabilities(), { asrConfigured: true, ttsConfigured: true, voices: ['stella', 'tide'] })

  const split = new DeepSeekSpeech({ deepSeekAsrApiKey: KEY }, fetch, {})
  assert.equal(split.capabilities().asrConfigured, true)
  assert.equal(split.capabilities().ttsConfigured, false)

  const ttsOnly = new DeepSeekSpeech({ deepSeekTtsApiKey: KEY }, fetch, {})
  assert.equal(ttsOnly.capabilities().asrConfigured, false)
  assert.equal(ttsOnly.capabilities().ttsConfigured, true)
})

test('capabilities expose a fresh voice list that callers cannot mutate', () => {
  const speech = new DeepSeekSpeech({}, fetch, {})
  const first = speech.capabilities().voices
  first.push('alloy')
  assert.deepEqual(speech.capabilities().voices, ['stella', 'tide'])
})

test('API key precedence: config wins over HR_* env, which wins over DEEPSEEK_API_KEY', async () => {
  const seen = []
  const fetchImpl = async (url, options) => {
    seen.push(options.headers.authorization)
    return url === DEEPSEEK_ASR_ENDPOINT ? json({ text: 'ok' }) : audio(wave())
  }
  const config = new DeepSeekSpeech({ deepSeekApiKey: 'config-key' }, fetchImpl, { HR_INTERVIEW_DEEPSEEK_API_KEY: 'hr-env-key', DEEPSEEK_API_KEY: 'generic-env-key' })
  await config.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 500 })
  await config.synthesize('你好')
  assert.deepEqual(seen, ['Bearer config-key', 'Bearer config-key'])

  const envFirst = new DeepSeekSpeech({}, fetchImpl, { HR_INTERVIEW_DEEPSEEK_API_KEY: 'hr-env-key', DEEPSEEK_API_KEY: 'generic-env-key' })
  await envFirst.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 500 })
  assert.equal(seen.at(-1), 'Bearer hr-env-key')

  const override = new DeepSeekSpeech({ deepSeekTtsApiKey: 'tts-only-key' }, fetchImpl, { DEEPSEEK_API_KEY: 'generic-env-key' })
  await override.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 500 })
  await override.synthesize('你好')
  assert.deepEqual(seen.slice(-2), ['Bearer generic-env-key', 'Bearer tts-only-key'])
})

test('ASR uploads only the file field of a canonical WAV and parses the transcript', async () => {
  const bytes = wave()
  const { calls, fetchImpl } = capture()
  calls.handler = async () => json({ text: ' 我是候选人 ', request_id: 'req-123', duration_ms: 1500 })

  const speech = new DeepSeekSpeech({ deepSeekApiKey: KEY }, fetchImpl, {})
  const result = await speech.transcribe({ audioBase64: bytes.toString('base64'), mimeType: 'audio/wav', durationMs: 1200 })

  assert.deepEqual(result, { text: '我是候选人', model: 'deepseek-asr', requestId: 'req-123', durationMs: 1500 })
  const call = calls[0]
  assert.equal(call.url, DEEPSEEK_ASR_ENDPOINT)
  assert.equal(call.options.method, 'POST')
  assert.equal(call.options.headers.authorization, `Bearer ${KEY}`)
  assert.equal(Object.keys(call.options.headers).some((key) => key.toLowerCase() === 'content-type'), false)
  assert.ok(call.options.signal instanceof AbortSignal)

  const form = call.options.body
  assert.ok(form instanceof FormData)
  assert.deepEqual([...form.keys()], ['file'])
  const file = form.get('file')
  assert.equal(file.name, 'answer.wav')
  assert.equal(file.type, 'audio/wav')
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(bytes))
})

test('ASR falls back to the supplied duration when the response omits duration_ms', async () => {
  const speech = new DeepSeekSpeech({ deepSeekApiKey: KEY }, async () => json({ text: '收到' }), {})
  const result = await speech.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 3200 })
  assert.equal(result.durationMs, 3200)
  assert.equal(result.requestId, null)
})

test('ASR rejects empty, non-WAV, non-canonical, over-long and oversized audio without fetching', async () => {
  let fetched = 0
  const speech = new DeepSeekSpeech({ deepSeekApiKey: KEY }, async () => { fetched += 1; throw new Error('fetch must not be called') }, {})
  const bytes = wave()

  assert.equal(await code(speech.transcribe({ audioBase64: '', mimeType: 'audio/wav', durationMs: 1000 })), 'hr-interview/deepseek-asr-empty-audio')
  assert.equal(await code(speech.transcribe({ audioBase64: '   ', mimeType: 'audio/wav' })), 'hr-interview/deepseek-asr-empty-audio')
  assert.equal(await code(speech.transcribe({ audioBase64: 'not-base64!!', mimeType: 'audio/wav' })), 'hr-interview/deepseek-asr-invalid-audio')
  assert.equal(await code(speech.transcribe()), 'hr-interview/deepseek-asr-empty-audio')

  // 原始 WebM：mime 与字节都不是 WAV。
  assert.equal(await code(speech.transcribe({ audioBase64: Buffer.from('webm-payload').toString('base64'), mimeType: 'audio/webm', durationMs: 1000 })), 'hr-interview/deepseek-asr-invalid-audio')
  // RIFF/WAVE 但采样率 44.1 kHz。
  const wrongRate = Buffer.from(bytes); wrongRate.writeUInt32LE(44100, 24)
  assert.equal(await code(speech.transcribe({ audioBase64: wrongRate.toString('base64'), mimeType: 'audio/wav', durationMs: 1000 })), 'hr-interview/deepseek-asr-invalid-audio')
  // 声明 16 kHz 但 data 尺寸字段与实际长度不一致。
  const lying = Buffer.from(bytes); lying.writeUInt32LE(lying.readUInt32LE(40) + 16, 40)
  assert.equal(await code(speech.transcribe({ audioBase64: lying.toString('base64'), mimeType: 'audio/wav', durationMs: 1000 })), 'hr-interview/deepseek-asr-invalid-audio')
  // WAV 字节但 mime 是 mp3。
  assert.equal(await code(speech.transcribe({ audioBase64: bytes.toString('base64'), mimeType: 'audio/mpeg', durationMs: 1000 })), 'hr-interview/deepseek-asr-invalid-audio')

  assert.equal(await code(speech.transcribe({ audioBase64: bytes.toString('base64'), mimeType: 'audio/wav', durationMs: 120001 })), 'hr-interview/deepseek-asr-too-long')

  const oversized = Buffer.alloc(DEEPSEEK_ASR_MAX_BYTES + 2)
  assert.equal(await code(speech.transcribe({ audioBase64: oversized.toString('base64'), mimeType: 'audio/wav', durationMs: 1000 })), 'hr-interview/deepseek-asr-too-large')

  assert.equal(fetched, 0)
})

test('missing configuration fails locally for both ASR and TTS without fetching', async () => {
  let fetched = 0
  const speech = new DeepSeekSpeech({}, async () => { fetched += 1; throw new Error('fetch must not be called') }, {})
  assert.equal(await code(speech.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 100 })), 'hr-interview/deepseek-asr-not-configured')
  assert.equal(await code(speech.synthesize('你好')), 'hr-interview/deepseek-tts-not-configured')
  assert.equal(fetched, 0)
})

test('ASR HTTP and empty-transcript failures are bounded, sanitized, and never echo the key', async () => {
  const noisy = new DeepSeekSpeech({ deepSeekApiKey: KEY }, async () => new Response(`denied for ${KEY} ${'x'.repeat(2000)}`, { status: 401 }), {})
  await assert.rejects(
    noisy.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 500 }),
    (error) => {
      assert.equal(error.code, 'hr-interview/deepseek-asr-http')
      assert.equal(error.message.includes(KEY), false)
      assert.ok(error.message.length <= 500)
      assert.match(error.message, /401/)
      return true
    },
  )

  const blank = new DeepSeekSpeech({ deepSeekApiKey: KEY }, async () => json({ text: '   ', request_id: 'req-empty' }), {})
  assert.equal(await code(blank.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 500 })), 'hr-interview/deepseek-asr-empty-text')

  const broken = new DeepSeekSpeech({ deepSeekApiKey: KEY }, async () => new Response('<html>gateway</html>', { status: 200 }), {})
  assert.equal(await code(broken.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 500 })), 'hr-interview/deepseek-asr-response')
})

test('ASR network and timeout failures use dedicated DeepSeek codes', async () => {
  const offline = new DeepSeekSpeech({ deepSeekApiKey: KEY }, async () => { throw new Error('socket hang up') }, {})
  assert.equal(await code(offline.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 500 })), 'hr-interview/deepseek-asr-network')

  const timeout = new DeepSeekSpeech({ deepSeekApiKey: KEY }, async () => { const error = new Error('The operation was aborted due to timeout'); error.name = 'TimeoutError'; throw error }, {})
  await assert.rejects(
    timeout.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 500 }),
    (error) => {
      assert.equal(error.code, 'hr-interview/deepseek-asr-timeout')
      assert.ok(error.message.length <= 500)
      return true
    },
  )
})

test('TTS synthesizes WAV with stella and trusts the RIFF header over content-type', async () => {
  const bytes = wave()
  const { calls, fetchImpl } = capture()
  calls.handler = async () => audio(bytes, 200, 'audio/mpeg')

  const speech = new DeepSeekSpeech({ deepSeekApiKey: KEY }, fetchImpl, {})
  const result = await speech.synthesize('请先做一个自我介绍。')

  assert.deepEqual(result, { audioBase64: bytes.toString('base64'), mimeType: 'audio/wav', model: 'deepseek-tts', voice: 'stella' })
  const call = calls[0]
  assert.equal(call.url, DEEPSEEK_TTS_ENDPOINT)
  assert.equal(call.options.method, 'POST')
  assert.equal(call.options.headers.authorization, `Bearer ${KEY}`)
  assert.equal(call.options.headers['content-type'], 'application/json')
  assert.ok(call.options.signal instanceof AbortSignal)
  assert.deepEqual(JSON.parse(call.options.body), {
    text: '请先做一个自我介绍。', voice_id: 'stella', format: 'wav', filter_markdown: true,
  })
})

test('TTS accepts tide and echoes the requested voice', async () => {
  const bytes = wave([0, 1, 2])
  const bodies = []
  const fetchImpl = async (url, options) => { bodies.push(JSON.parse(options.body)); return audio(bytes) }
  const speech = new DeepSeekSpeech({ deepSeekApiKey: KEY }, fetchImpl, {})
  const result = await speech.synthesize('这个问题我们稍后再聊。', { voice: 'tide' })
  assert.equal(result.voice, 'tide')
  assert.equal(result.mimeType, 'audio/wav')
  assert.equal(bodies[0].voice_id, 'tide')
})

test('TTS rejects empty text, oversized text and unknown voices without fetching', async () => {
  let fetched = 0
  const speech = new DeepSeekSpeech({ deepSeekApiKey: KEY }, async () => { fetched += 1; throw new Error('fetch must not be called') }, {})

  assert.equal(await code(speech.synthesize('')), 'hr-interview/deepseek-tts-empty-text')
  assert.equal(await code(speech.synthesize('   ')), 'hr-interview/deepseek-tts-empty-text')
  assert.equal(await code(speech.synthesize(undefined)), 'hr-interview/deepseek-tts-empty-text')
  assert.equal(await code(speech.synthesize('字'.repeat(10001))), 'hr-interview/deepseek-tts-text-too-long')
  assert.equal(await code(speech.synthesize('字'.repeat(5001))), 'hr-interview/deepseek-tts-text-too-long')
  assert.equal(await code(speech.synthesize('你好', { voice: 'alloy' })), 'hr-interview/deepseek-tts-invalid-voice')
  assert.equal(await code(speech.synthesize('你好', { voice: 'STELLA' })), 'hr-interview/deepseek-tts-invalid-voice')

  assert.equal(fetched, 0)
})

test('TTS rejects empty and non-WAV audio responses', async () => {
  const empty = new DeepSeekSpeech({ deepSeekApiKey: KEY }, async () => audio(Buffer.alloc(0)), {})
  assert.equal(await code(empty.synthesize('你好')), 'hr-interview/deepseek-tts-response')

  const text = new DeepSeekSpeech({ deepSeekApiKey: KEY }, async () => audio(Buffer.from('{"audio":"nope"}'), 200, 'audio/wav'), {})
  assert.equal(await code(text.synthesize('你好')), 'hr-interview/deepseek-tts-response')

  const mislabeled = new DeepSeekSpeech({ deepSeekApiKey: KEY }, async () => audio(Buffer.from('ID3 fake mp3 bytes'), 200, 'audio/wav'), {})
  assert.equal(await code(mislabeled.synthesize('你好')), 'hr-interview/deepseek-tts-response')
})

test('TTS rate-limit and outage responses surface bounded DeepSeek errors', async () => {
  for (const status of [429, 503]) {
    const speech = new DeepSeekSpeech({ deepSeekApiKey: KEY }, async () => new Response(`upstream ${status} ${KEY} ${'y'.repeat(1500)}`, { status }), {})
    await assert.rejects(speech.synthesize('你好'), (error) => {
      assert.equal(error.code, 'hr-interview/deepseek-tts-http')
      assert.equal(error.message.includes(KEY), false)
      assert.ok(error.message.length <= 500)
      assert.match(error.message, new RegExp(String(status)))
      return true
    })
  }
})

test('TTS network failures use a dedicated DeepSeek code', async () => {
  const speech = new DeepSeekSpeech({ deepSeekApiKey: KEY }, async () => { throw new Error('connect ECONNREFUSED') }, {})
  await assert.rejects(speech.synthesize('你好'), (error) => {
    assert.equal(error.code, 'hr-interview/deepseek-tts-network')
    assert.match(error.message, /ECONNREFUSED/)
    assert.ok(error.message.length <= 500)
    return true
  })
})

test('custom timeout is applied to the abort signal of both calls', async () => {
  const signals = []
  const fetchImpl = async (url, options) => {
    signals.push(options.signal)
    return url === DEEPSEEK_ASR_ENDPOINT ? json({ text: 'ok' }) : audio(wave())
  }
  const speech = new DeepSeekSpeech({ deepSeekApiKey: KEY, deepSeekTimeoutMs: 1500 }, fetchImpl, {})
  await speech.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 500 })
  await speech.synthesize('你好')
  assert.equal(signals.length, 2)
  assert.ok(signals.every((signal) => signal instanceof AbortSignal))
})

test('internal timeout remains a timeout even when the mock rejects with AbortError', async () => {
  const fetchImpl = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted by timeout', 'AbortError')), { once: true })
  })
  const speech = new DeepSeekSpeech({ deepSeekApiKey: KEY, deepSeekTimeoutMs: 30 }, fetchImpl, {})
  assert.equal(await code(speech.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 500 })), 'hr-interview/deepseek-asr-timeout')
  assert.equal(await code(speech.synthesize('你好')), 'hr-interview/deepseek-tts-timeout')
})

// 直接按时长造 canonical WAV：32000 字节 = 1 秒（16 kHz / 单声道 / PCM16）。
function waveOfDuration(seconds) {
  const bytes = Buffer.alloc(44 + 32000 * seconds)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24)
  bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36)
  bytes.writeUInt32LE(bytes.length - 44, 40)
  return bytes
}

test('ASR derives real WAV duration and rejects audio over 120 s without a usable durationMs', async () => {
  let fetched = 0
  const speech = new DeepSeekSpeech({ deepSeekApiKey: KEY }, async () => { fetched += 1; return json({ text: '收到' }) }, {})
  const long = waveOfDuration(121).toString('base64')

  assert.equal(await code(speech.transcribe({ audioBase64: long, mimeType: 'audio/wav' })), 'hr-interview/deepseek-asr-too-long')
  assert.equal(await code(speech.transcribe({ audioBase64: long, mimeType: 'audio/wav', durationMs: 0 })), 'hr-interview/deepseek-asr-too-long')
  assert.equal(await code(speech.transcribe({ audioBase64: long, mimeType: 'audio/wav', durationMs: 900 })), 'hr-interview/deepseek-asr-too-long')
  assert.equal(fetched, 0)

  // 正好 120 秒：放行，并以真实时长补上缺失的 duration_ms。
  const edge = await speech.transcribe({ audioBase64: waveOfDuration(120).toString('base64'), mimeType: 'audio/wav', durationMs: 0 })
  assert.equal(edge.durationMs, 120000)
  assert.equal(fetched, 1)

  // 响应缺 duration_ms、自报也无效时回落到真实时长；有效自报仍优先。
  const real = await speech.transcribe({ audioBase64: waveOfDuration(2).toString('base64'), mimeType: 'audio/wav', durationMs: 0 })
  assert.equal(real.durationMs, 2000)
  const reported = await speech.transcribe({ audioBase64: waveOfDuration(2).toString('base64'), mimeType: 'audio/wav', durationMs: 2500 })
  assert.equal(reported.durationMs, 2500)
})

test('an external AbortSignal is merged with the 90 s timeout and handed to fetch', async () => {
  const signals = []
  const fetchImpl = async (url, options) => {
    signals.push(options.signal)
    return url === DEEPSEEK_ASR_ENDPOINT ? json({ text: 'ok' }) : audio(wave())
  }
  const speech = new DeepSeekSpeech({ deepSeekApiKey: KEY }, fetchImpl, {})
  const asr = new AbortController(); const tts = new AbortController()

  await speech.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 500 }, { signal: asr.signal })
  await speech.synthesize('你好', { signal: tts.signal, voice: 'tide' })

  assert.equal(signals.length, 2)
  // 传给 fetch 的是合并后的信号，而不是调用方那一个。
  assert.notEqual(signals[0], asr.signal)
  assert.notEqual(signals[1], tts.signal)
  assert.ok(signals.every((signal) => signal instanceof AbortSignal && signal.aborted === false))

  asr.abort(); tts.abort()
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[1].aborted, true)
})

test('an already aborted external signal fails the request with a dedicated abort code', async () => {
  const fetchImpl = async (url, options) => {
    if (options.signal.aborted) {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      throw error
    }
    return json({ text: 'ok' })
  }
  const speech = new DeepSeekSpeech({ deepSeekApiKey: KEY }, fetchImpl, {})
  const controller = new AbortController(); controller.abort()
  await assert.rejects(
    speech.transcribe({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav', durationMs: 500 }, { signal: controller.signal }),
    (error) => {
      assert.equal(error.code, 'hr-interview/deepseek-asr-aborted')
      assert.ok(error.message.length <= 500)
      return true
    },
  )
})
