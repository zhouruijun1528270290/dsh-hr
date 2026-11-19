import { remoteFailure } from './contract.js'

// DeepSeek 专用 ASR/TTS 端点：与传统 OpenAI-compatible /audio/* 不共用。
export const DEEPSEEK_ASR_ENDPOINT = 'https://api.deepseek.com/v1/tools/asr'
export const DEEPSEEK_TTS_ENDPOINT = 'https://api.deepseek.com/v1/tools/tts'
export const DEEPSEEK_VOICES = Object.freeze(['stella', 'tide'])

export const DEEPSEEK_ASR_MAX_DURATION_MS = 120000
export const DEEPSEEK_ASR_MAX_BYTES = 8 * 1024 * 1024
export const DEEPSEEK_TTS_MAX_CHARACTERS = 10000
export const DEEPSEEK_TTS_MAX_BYTES = 64 * 1024
export const DEEPSEEK_DEFAULT_TIMEOUT_MS = 90000

const MAX_MESSAGE_LENGTH = 500
const WAV_MIME_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'])
const BASE64_PATTERN = /^[A-Za-z0-9+/=]+$/

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const billedCharacters = (value) => Array.from(value).reduce((total, char) => total + (/[\u3400-\u9fff\uf900-\ufaff]/.test(char) ? 2 : 1), 0)

function positiveInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

// canonical 16 kHz / mono / PCM16 WAV：头、尺寸字段与真实长度必须完全一致。
export function isCanonicalWav(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 46) return false
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') return false
  if (bytes.toString('ascii', 8, 12) !== 'WAVE') return false
  if (bytes.toString('ascii', 12, 16) !== 'fmt ') return false
  if (bytes.toString('ascii', 36, 40) !== 'data') return false
  if (bytes.readUInt32LE(16) !== 16) return false
  if (bytes.readUInt16LE(20) !== 1) return false
  if (bytes.readUInt16LE(22) !== 1) return false
  if (bytes.readUInt32LE(24) !== 16000) return false
  if (bytes.readUInt32LE(28) !== 32000) return false
  if (bytes.readUInt16LE(32) !== 2) return false
  if (bytes.readUInt16LE(34) !== 16) return false
  if (bytes.readUInt32LE(4) !== bytes.length - 8) return false
  const dataSize = bytes.readUInt32LE(40)
  return dataSize === bytes.length - 44 && dataSize % 2 === 0
}

function isRiffWave(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 12
    && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
}

// 统一清洗远端文本：移除密钥 / Bearer / sk-*，压缩空白，截断到固定上限。
// 导出供 SpeechGateway 的通用 HTTP 通道复用，避免每层各写一份。
export function bounded(message, secrets = []) {
  let out = String(message ?? '').replace(/\s+/g, ' ').trim()
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]')
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [redacted]')
  out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-[redacted]')
  return out.length > MAX_MESSAGE_LENGTH ? out.slice(0, MAX_MESSAGE_LENGTH) : out
}

export class DeepSeekSpeech {
  constructor(config = {}, fetchImpl = fetch, env = process.env, { credentials = null } = {}) {
    this.config = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
    this.fetch = typeof fetchImpl === 'function' ? fetchImpl : fetch
    this.env = env && typeof env === 'object' ? env : {}
    this.credentials = credentials
    this.credentialInfo = null
    const base = text(this.config.deepSeekApiKey)
      || text(this.env.HR_INTERVIEW_DEEPSEEK_API_KEY)
      || text(this.env.DEEPSEEK_API_KEY)
    this.asrKey = text(this.config.deepSeekAsrApiKey) || base
    this.ttsKey = text(this.config.deepSeekTtsApiKey) || base
    this.secrets = [this.asrKey, this.ttsKey].filter(Boolean)
    this.timeoutMs = positiveInteger(this.config.deepSeekTimeoutMs) || DEEPSEEK_DEFAULT_TIMEOUT_MS
  }

  capabilities() {
    const stored = Boolean(this.credentialInfo?.configured)
    return { asrConfigured: Boolean(this.asrKey || stored), ttsConfigured: Boolean(this.ttsKey || stored), voices: [...DEEPSEEK_VOICES] }
  }

  async credentialStatus() {
    if (this.credentials && typeof this.credentials.describe === 'function') {
      try { this.credentialInfo = await this.credentials.describe() } catch (error) {
        this.credentialInfo = { configured: false, source: null, writable: false, statusError: bounded(error?.message || error, this.secrets) }
      }
    } else {
      const fromEnvironment = Boolean(text(this.env.HR_INTERVIEW_DEEPSEEK_API_KEY) || text(this.env.DEEPSEEK_API_KEY))
      const configured = Boolean(this.asrKey || this.ttsKey)
      this.credentialInfo = { configured, source: configured && fromEnvironment ? 'env' : null, writable: false }
    }
    return { ...this.credentialInfo }
  }

  async resolveKey(kind) {
    const configured = kind === 'asr'
      ? text(this.config.deepSeekAsrApiKey) || text(this.config.deepSeekApiKey)
      : text(this.config.deepSeekTtsApiKey) || text(this.config.deepSeekApiKey)
    let key = configured
    if (!key && this.credentials && typeof this.credentials.resolve === 'function') key = await this.credentials.resolve()
    if (!key) key = text(this.env.HR_INTERVIEW_DEEPSEEK_API_KEY) || text(this.env.DEEPSEEK_API_KEY)
    key = text(key)
    if (key && !this.secrets.includes(key)) this.secrets.push(key)
    return key
  }

  fail(code, message, details = {}) {
    return remoteFailure(code, bounded(message, this.secrets), details)
  }

  transport(kind, error, signal, external) {
    const cancelled = external?.aborted === true
    const timedOut = !cancelled && (error?.name === 'TimeoutError' || error?.name === 'AbortError' || signal?.aborted === true)
    const label = kind === 'asr' ? 'ASR' : 'TTS'
    return this.fail(
      `hr-interview/deepseek-${kind}-${cancelled ? 'aborted' : timedOut ? 'timeout' : 'network'}`,
      `DeepSeek ${label} request ${cancelled ? 'was cancelled' : 'failed'}: ${error?.message || 'unknown error'}`,
    )
  }

  readAudio(audio) {
    const payload = audio && typeof audio === 'object' && !Array.isArray(audio) ? audio : {}
    const encoded = typeof payload.audioBase64 === 'string' ? payload.audioBase64.replace(/\s+/g, '') : ''
    if (!encoded) throw this.fail('hr-interview/deepseek-asr-empty-audio', 'Decoded audio is empty')
    if (!BASE64_PATTERN.test(encoded)) throw this.fail('hr-interview/deepseek-asr-invalid-audio', 'Audio must be base64 encoded')
    const bytes = Buffer.from(encoded, 'base64')
    if (!bytes.length) throw this.fail('hr-interview/deepseek-asr-empty-audio', 'Decoded audio is empty')
    const reported = Number(payload.durationMs)
    // 自报时长只有为正数才算有效；缺失或 0 一律交给真实时长兜底。
    const reportedDurationMs = Number.isFinite(reported) && reported > 0 ? Math.round(reported) : 0
    if (reportedDurationMs > DEEPSEEK_ASR_MAX_DURATION_MS) {
      throw this.fail('hr-interview/deepseek-asr-too-long', `Audio duration must not exceed ${DEEPSEEK_ASR_MAX_DURATION_MS} ms`)
    }
    if (bytes.length > DEEPSEEK_ASR_MAX_BYTES) {
      throw this.fail('hr-interview/deepseek-asr-too-large', `Audio must not exceed ${DEEPSEEK_ASR_MAX_BYTES} bytes`)
    }
    const mimeType = typeof payload.mimeType === 'string' ? payload.mimeType.split(';', 1)[0].trim().toLowerCase() : ''
    if (!WAV_MIME_TYPES.has(mimeType) || !isCanonicalWav(bytes)) {
      throw this.fail('hr-interview/deepseek-asr-invalid-audio', 'DeepSeek ASR requires canonical 16 kHz mono PCM16 WAV audio')
    }
    // canonical WAV 已校验通过：32000 字节 = 1 秒 16 kHz/单声道/PCM16，data 字节即真实时长。
    const realDurationMs = Math.round(((bytes.length - 44) / 32000) * 1000)
    const durationMs = Math.max(reportedDurationMs, realDurationMs)
    // 自报为 0 或缺失时，真实时长同样要过 120s 闸门。
    if (durationMs > DEEPSEEK_ASR_MAX_DURATION_MS) {
      throw this.fail('hr-interview/deepseek-asr-too-long', `Audio duration must not exceed ${DEEPSEEK_ASR_MAX_DURATION_MS} ms`)
    }
    return { bytes, durationMs, realDurationMs, reportedDurationMs }
  }

  // 90s 内置超时与调用方外部 AbortSignal 合并：任一触发都终止传输。
  requestSignal(options) {
    const external = options && typeof options === 'object' ? options.signal : undefined
    const timeout = AbortSignal.timeout(this.timeoutMs)
    return external && typeof external === 'object' && typeof external.aborted === 'boolean'
      ? AbortSignal.any([timeout, external])
      : timeout
  }

  async transcribe(audio, options = {}) {
    const apiKey = await this.resolveKey('asr')
    if (!apiKey) throw this.fail('hr-interview/deepseek-asr-not-configured', '请在插件设置中保存 DeepSeek API Key，或配置环境变量')
    const { bytes, durationMs } = this.readAudio(audio)
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'answer.wav')
    const signal = this.requestSignal(options)
    let response
    try {
      response = await this.fetch(DEEPSEEK_ASR_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal,
      })
    } catch (error) { throw this.transport('asr', error, signal, options?.signal) }
    if (!response || typeof response.ok !== 'boolean') throw this.fail('hr-interview/deepseek-asr-response', 'DeepSeek ASR returned an invalid response')
    let body = ''
    try { body = await response.text() } catch (error) {
      throw this.fail('hr-interview/deepseek-asr-response', `DeepSeek ASR body could not be read: ${error?.message || 'unknown error'}`)
    }
    if (!response.ok) throw this.fail('hr-interview/deepseek-asr-http', `DeepSeek ASR HTTP ${response.status}: ${body}`, { status: response.status })
    let payload
    try { payload = JSON.parse(body) } catch { throw this.fail('hr-interview/deepseek-asr-response', 'DeepSeek ASR response is not JSON') }
    const transcript = typeof payload?.text === 'string' ? payload.text.trim() : ''
    if (!transcript) throw this.fail('hr-interview/deepseek-asr-empty-text', 'DeepSeek ASR returned an empty transcript')
    const reportedResponse = Number(payload?.duration_ms)
    // 响应未给出有效 duration_ms 时：优先有效自报，否则用 canonical WAV 的真实时长。
    const resolvedDurationMs = Number.isFinite(reportedResponse) && reportedResponse > 0 ? Math.round(reportedResponse) : durationMs
    return {
      text: transcript,
      model: 'deepseek-asr',
      requestId: typeof payload?.request_id === 'string' && payload.request_id.trim() ? payload.request_id.trim() : null,
      durationMs: resolvedDurationMs,
    }
  }

  async synthesize(text, options = {}) {
    const { voice = 'stella' } = options && typeof options === 'object' ? options : {}
    const apiKey = await this.resolveKey('tts')
    if (!apiKey) throw this.fail('hr-interview/deepseek-tts-not-configured', '请在插件设置中保存 DeepSeek API Key，或配置环境变量')
    const input = typeof text === 'string' ? text : ''
    if (!input.trim()) throw this.fail('hr-interview/deepseek-tts-empty-text', 'Text to synthesize is empty')
    if (billedCharacters(input) > DEEPSEEK_TTS_MAX_CHARACTERS) throw this.fail('hr-interview/deepseek-tts-text-too-long', `Text must not exceed ${DEEPSEEK_TTS_MAX_CHARACTERS} billed characters`)
    if (Buffer.byteLength(input, 'utf8') > DEEPSEEK_TTS_MAX_BYTES) throw this.fail('hr-interview/deepseek-tts-text-too-large', `Text must not exceed ${DEEPSEEK_TTS_MAX_BYTES} UTF-8 bytes`)
    if (!DEEPSEEK_VOICES.includes(voice)) throw this.fail('hr-interview/deepseek-tts-invalid-voice', `Unsupported voice; expected one of ${DEEPSEEK_VOICES.join(', ')}`)
    const signal = this.requestSignal(options)
    let response
    try {
      response = await this.fetch(DEEPSEEK_TTS_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: input, voice_id: voice, format: 'wav', filter_markdown: true }),
        signal,
      })
    } catch (error) { throw this.transport('tts', error, signal, options?.signal) }
    if (!response || typeof response.ok !== 'boolean') throw this.fail('hr-interview/deepseek-tts-response', 'DeepSeek TTS returned an invalid response')
    if (!response.ok) {
      let detail = ''
      try { detail = await response.text() } catch { detail = '' }
      throw this.fail('hr-interview/deepseek-tts-http', `DeepSeek TTS HTTP ${response.status}: ${detail}`, { status: response.status })
    }
    let bytes
    try { bytes = Buffer.from(await response.arrayBuffer()) } catch (error) {
      throw this.fail('hr-interview/deepseek-tts-response', `DeepSeek TTS audio could not be read: ${error?.message || 'unknown error'}`)
    }
    if (!bytes.length) throw this.fail('hr-interview/deepseek-tts-response', 'DeepSeek TTS returned empty audio')
    if (!isRiffWave(bytes)) throw this.fail('hr-interview/deepseek-tts-response', 'DeepSeek TTS returned audio that is not a RIFF/WAVE file')
    return { audioBase64: bytes.toString('base64'), mimeType: 'audio/wav', model: 'deepseek-tts', voice }
  }
}

export default DeepSeekSpeech
