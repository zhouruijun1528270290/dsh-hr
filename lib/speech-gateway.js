import { remoteFailure } from './contract.js'
import { DeepSeekSpeech, bounded } from './deepseek-speech.js'

const env = (key, fallback = '') => String(process.env[key] || fallback).trim()
function settings(kind, config = {}) {
  const prefix = kind === 'asr' ? 'ASR' : 'TTS'
  const baseUrl = String(config[`${kind}BaseUrl`] || env(`HR_INTERVIEW_${prefix}_BASE_URL`)).replace(/\/+$/, '')
  return {
    baseUrl, apiKey: String(config[`${kind}ApiKey`] || env(`HR_INTERVIEW_${prefix}_API_KEY`)),
    model: String(config[`${kind}Model`] || env(`HR_INTERVIEW_${prefix}_MODEL`, kind === 'asr' ? 'whisper-1' : 'tts-1')),
    voice: String(config.ttsVoice || env('HR_INTERVIEW_TTS_VOICE', 'alloy')),
    timeoutMs: Number(config[`${kind}TimeoutMs`] || env(`HR_INTERVIEW_${prefix}_TIMEOUT_MS`, '90000')),
    configured: Boolean(baseUrl),
  }
}
function canonicalWave(bytes) {
  return bytes.length >= 46 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE' && bytes.toString('ascii', 12, 16) === 'fmt ' && bytes.toString('ascii', 36, 40) === 'data'
    && bytes.readUInt32LE(16) === 16 && bytes.readUInt16LE(20) === 1 && bytes.readUInt16LE(22) === 1 && bytes.readUInt32LE(24) === 16000
    && bytes.readUInt32LE(28) === 32000 && bytes.readUInt16LE(32) === 2 && bytes.readUInt16LE(34) === 16
    && bytes.readUInt32LE(4) === bytes.length - 8 && bytes.readUInt32LE(40) === bytes.length - 44 && (bytes.length - 44) % 2 === 0
}
function preferredProvider(config) {
  const value = String(config.speechProvider || env('HR_INTERVIEW_SPEECH_PROVIDER', 'auto'))
  return ['auto', 'deepseek', 'local', 'browser', 'http'].includes(value) ? value : 'auto'
}
// 与 DeepSeek 通道同一套清洗规则：去掉配置密钥 / Bearer / sk-*，压缩空白，最长 500。
const sanitize = (message, ...secrets) => bounded(
  message,
  secrets.filter((secret) => typeof secret === 'string' && secret.length >= 4),
)
// 通用 HTTP 与本地转写共用：超时信号与调用方外部 AbortSignal 合并。
function mergeSignal(timeoutMs, external) {
  const ms = Number(timeoutMs)
  const timeout = AbortSignal.timeout(Number.isFinite(ms) && ms > 0 ? ms : 90000)
  return external && typeof external === 'object' && typeof external.aborted === 'boolean'
    ? AbortSignal.any([timeout, external])
    : timeout
}
export class SpeechGateway {
  constructor(config = {}, fetchImpl = fetch, { speechToText = null, credentials = null } = {}) {
    this.config = config; this.fetch = fetchImpl; this.speechToText = speechToText
    this.deepseek = new DeepSeekSpeech(config, fetchImpl, process.env, { credentials })
  }
  setSpeechToText(service) { this.speechToText = service || null }
  credentialStatus() { return this.deepseek.credentialStatus() }
  async currentCapabilities() {
    const deepSeekCredential = await this.credentialStatus()
    return { ...this.capabilities(), deepSeekCredential }
  }
  async saveApiKey(value) {
    if (!this.deepseek.credentials) throw remoteFailure('hr-interview/credentials-unavailable', '当前 DSH 凭据服务未提供保存能力，可继续使用环境变量')
    const status = await this.deepseek.credentials.save(value); await this.credentialStatus(); return status
  }
  async clearApiKey() {
    if (!this.deepseek.credentials) throw remoteFailure('hr-interview/credentials-unavailable', '当前 DSH 凭据服务未提供清除能力')
    const status = await this.deepseek.credentials.clear(); await this.credentialStatus(); return status
  }
  hostSnapshot() {
    try { return this.speechToText?.snapshot() || null } catch { return null }
  }
  hostProvider() {
    const snapshot = this.hostSnapshot(); if (!snapshot || !Array.isArray(snapshot.providers)) return null
    return snapshot.providers.find((provider) => provider.id === snapshot.selection?.providerId) || null
  }
  capabilities() {
    const asr = settings('asr', this.config); const tts = settings('tts', this.config)
    const deep = this.deepseek.capabilities(); const host = this.hostProvider(); const hostReady = host?.preparation?.phase === 'ready'
    const preferred = preferredProvider(this.config)
    const autoAsr = hostReady ? 'host-local' : asr.configured ? 'http' : deep.asrConfigured ? 'deepseek' : 'unconfigured'
    const autoTts = tts.configured ? 'http' : deep.ttsConfigured ? 'deepseek' : 'unconfigured'
    const asrMode = preferred === 'deepseek' ? 'deepseek' : preferred === 'local' ? 'host-local' : preferred === 'http' ? 'http' : autoAsr
    const ttsMode = ['browser', 'local'].includes(preferred) ? 'browser' : preferred === 'deepseek' ? 'deepseek' : preferred === 'http' ? 'http' : autoTts
    const voice = String(this.config.deepSeekTtsVoice || env('HR_INTERVIEW_DEEPSEEK_TTS_VOICE', 'stella'))
    return {
      asrConfigured: asrMode === 'deepseek' ? deep.asrConfigured : asrMode === 'host-local' ? hostReady : asrMode === 'http' ? asr.configured : false,
      asrMode, asrPreparation: host?.preparation?.phase || null,
      asrStatus: asrMode === 'deepseek' && !deep.asrConfigured ? 'missing-key' : asrMode === 'host-local' && !hostReady ? 'unprepared' : asrMode === 'http' && !asr.configured ? 'unconfigured' : asrMode === 'unconfigured' ? 'unconfigured' : 'ready',
      asrModel: asrMode === 'host-local' ? host?.id || null : asrMode === 'deepseek' ? 'deepseek-asr' : asr.model,
      ttsConfigured: ttsMode === 'deepseek' ? deep.ttsConfigured : ttsMode === 'http' ? tts.configured : false,
      ttsMode, ttsModel: ttsMode === 'deepseek' ? 'deepseek-tts' : tts.model,
      deepSeekAsrConfigured: deep.asrConfigured, deepSeekTtsConfigured: deep.ttsConfigured,
      localAsrReady: hostReady, httpAsrConfigured: asr.configured, httpTtsConfigured: tts.configured,
      deepSeekVoices: ['stella', 'tide'], ttsVoice: ['stella', 'tide'].includes(voice) ? voice : 'stella',
    }
  }
  headers(apiKey, json = false) { const out = json ? { 'content-type': 'application/json' } : {}; if (apiKey) out.authorization = `Bearer ${apiKey}`; return out }
  async transcribe(audio, options = {}) {
    await this.credentialStatus()
    const cfg = settings('asr', this.config); const host = this.hostProvider(); const hostReady = host?.preparation?.phase === 'ready'
    const external = options && typeof options === 'object' ? options.signal : undefined
    const requested = options && typeof options === 'object' && typeof options.provider === 'string' ? options.provider : 'auto'
    const configuredPreference = requested === 'auto' ? preferredProvider(this.config) : requested
    const preferred = configuredPreference === 'browser' ? 'auto' : configuredPreference
    const deep = this.deepseek.capabilities()
    const selected = preferred === 'auto' ? (hostReady ? 'local' : cfg.configured ? 'http' : deep.asrConfigured ? 'deepseek' : 'unconfigured') : preferred
    const bytes = Buffer.from(audio.audioBase64, 'base64')
    if (!bytes.length) throw remoteFailure('hr-interview/invalid-audio', 'Decoded audio is empty')
    if (selected === 'unconfigured') throw remoteFailure('hr-interview/asr-not-configured', '尚未配置语音识别，请保存 DeepSeek API Key、准备本地识别或选择通用 HTTP')
    if (selected === 'deepseek') return this.deepseek.transcribe(audio, { signal: external })
    if (selected === 'local') {
      if (!host) throw remoteFailure('hr-interview/asr-not-configured', 'Enable the official local speech provider or choose another ASR provider')
      if (!hostReady) throw remoteFailure('hr-interview/asr-preparation', 'Prepare the local speech provider in DSH voice settings, or choose another ASR provider')
      if (!canonicalWave(bytes)) throw remoteFailure('hr-interview/asr-wave-required', 'Local ASR requires canonical 16 kHz mono PCM16 WAV audio')
      try {
        const spec = this.speechToText.resolve({ audio: bytes, language: 'zh' })
        const result = await this.speechToText.transcribe(spec, mergeSignal(cfg.timeoutMs, external))
        if (!String(result?.text || '').trim()) throw new Error('empty transcript')
        return { text: String(result.text).trim(), model: host.id }
      } catch (error) { throw remoteFailure('hr-interview/asr-local', sanitize(`Local ASR failed: ${error?.message || 'unknown error'}`, cfg.apiKey)) }
    }
    if (selected !== 'http') throw remoteFailure('hr-interview/asr-not-configured', `ASR provider ${selected} is unavailable`)
    if (!cfg.configured) throw remoteFailure('hr-interview/asr-not-configured', 'Set HR_INTERVIEW_ASR_BASE_URL or choose another ASR provider')
    const mime = typeof audio?.mimeType === 'string' ? audio.mimeType : ''
    const extension = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('mpeg') ? 'mp3' : mime.includes('mp4') ? 'm4a' : 'wav'
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: mime || 'application/octet-stream' }), `answer.${extension}`)
    form.append('model', cfg.model); form.append('language', 'zh'); form.append('response_format', 'json')
    let response
    try { response = await this.fetch(`${cfg.baseUrl}/audio/transcriptions`, { method: 'POST', headers: this.headers(cfg.apiKey), body: form, signal: mergeSignal(cfg.timeoutMs, external) }) }
    catch (error) { throw remoteFailure('hr-interview/asr-network', sanitize(`ASR request failed: ${error?.message || 'unknown error'}`, cfg.apiKey)) }
    let body = ''
    try { body = await response.text() } catch (error) {
      throw remoteFailure('hr-interview/asr-response', sanitize(`ASR body could not be read: ${error?.message || 'unknown error'}`, cfg.apiKey))
    }
    if (!response.ok) throw remoteFailure('hr-interview/asr-http', sanitize(`ASR HTTP ${response.status}: ${body}`, cfg.apiKey), { status: response.status })
    let payload
    try { payload = JSON.parse(body) } catch { throw remoteFailure('hr-interview/asr-response', 'ASR response is not JSON') }
    const transcript = typeof payload?.text === 'string' ? payload.text.trim() : ''
    if (!transcript) throw remoteFailure('hr-interview/asr-response', 'ASR response has no transcript')
    return { text: transcript, model: cfg.model }
  }
  async synthesize(text, options = {}) {
    const cfg = settings('tts', this.config)
    await this.credentialStatus()
    const external = options && typeof options === 'object' ? options.signal : undefined
    const requested = options && typeof options === 'object' && typeof options.provider === 'string' ? options.provider : 'auto'
    const voice = options && typeof options === 'object' && options.voice !== undefined ? options.voice : 'stella'
    const preferred = requested === 'auto' ? preferredProvider(this.config) : requested
    const selected = preferred === 'auto' ? (cfg.configured ? 'http' : this.deepseek.capabilities().ttsConfigured ? 'deepseek' : 'browser') : preferred === 'local' ? 'browser' : preferred
    if (selected === 'deepseek') return this.deepseek.synthesize(text, { voice, signal: external })
    if (selected === 'browser') throw remoteFailure('hr-interview/tts-browser-only', 'Use browser speech synthesis for this provider')
    if (selected !== 'http' || !cfg.configured) throw remoteFailure('hr-interview/tts-not-configured', 'Set HR_INTERVIEW_TTS_BASE_URL or choose another TTS provider')
    let response
    try { response = await this.fetch(`${cfg.baseUrl}/audio/speech`, { method: 'POST', headers: this.headers(cfg.apiKey, true), body: JSON.stringify({ model: cfg.model, voice: cfg.voice, input: String(text).slice(0, 4000), response_format: 'mp3' }), signal: mergeSignal(cfg.timeoutMs, external) }) }
    catch (error) { throw remoteFailure('hr-interview/tts-network', sanitize(`TTS request failed: ${error?.message || 'unknown error'}`, cfg.apiKey)) }
    if (!response.ok) {
      let detail = ''
      try { detail = await response.text() } catch { detail = '' }
      throw remoteFailure('hr-interview/tts-http', sanitize(`TTS HTTP ${response.status}: ${detail}`, cfg.apiKey), { status: response.status })
    }
    let bytes
    try { bytes = Buffer.from(await response.arrayBuffer()) } catch (error) {
      throw remoteFailure('hr-interview/tts-response', sanitize(`TTS audio could not be read: ${error?.message || 'unknown error'}`, cfg.apiKey))
    }
    if (!bytes.length) throw remoteFailure('hr-interview/tts-response', 'TTS returned empty audio')
    return { audioBase64: bytes.toString('base64'), mimeType: response.headers.get('content-type') || 'audio/mpeg' }
  }
}
