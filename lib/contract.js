export const HR_SERVICE = 'hrInterview'
export const HR_LOCAL_CAMERA_PATH = '/hr-local-camera/frame'
export const SESSION_ID_PATTERN = /^hr-[a-z0-9-]{8,80}$/
export const PREPARATION_ID_PATTERN = /^prep-[a-z0-9-]{8,80}$/
export const MAX_TEXT_LENGTH = 24000
export const MAX_AUDIO_BASE64_LENGTH = 24 * 1024 * 1024
export const MAX_RESUME_FILE_BYTES = 8 * 1024 * 1024
export const MAX_RESUME_BASE64_LENGTH = Math.ceil(MAX_RESUME_FILE_BYTES / 3) * 4

export const HR_QUESTION_TOPIC_LABELS = Object.freeze({
  'agent-core': 'Agent 基础',
  'mcp-tools': 'MCP 与工具调用',
  rag: 'RAG 检索',
  memory: '记忆与上下文',
  reliability: '评估与可靠性',
  'project-general': '项目深挖',
  behavioral: '行为面试',
  fundamentals: '技术基础',
})

export const remoteFailure = (code, message, details = {}) =>
  Object.assign(new Error(message), { code, details, isDSHRemoteError: true, name: 'RemoteError' })

export function parseSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw remoteFailure('hr-interview/invalid-session-id', 'Expected a valid hr-* session id')
  }
  return value
}

export function parsePreparationId(value) {
  if (typeof value !== 'string' || !PREPARATION_ID_PATTERN.test(value)) {
    throw remoteFailure('hr-interview/invalid-preparation-id', 'Expected a valid prep-* preparation id')
  }
  return value
}

export function parseText(value, { allowEmpty = false, maxLength = MAX_TEXT_LENGTH } = {}) {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw remoteFailure('hr-interview/invalid-text', `Expected text of at most ${maxLength} characters`)
  }
  const text = value.trim()
  if (!allowEmpty && !text) throw remoteFailure('hr-interview/empty-answer', 'Answer text is empty')
  return text
}

export function parseMaterials(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw remoteFailure('hr-interview/invalid-materials', 'Materials must be an object')
  const out = {}
  const limits = { role: 200, resume: 60000, jd: 30000, projectNotes: 60000 }
  for (const key of Object.keys(limits)) out[key] = parseText(value[key] || '', { allowEmpty: true, maxLength: limits[key] })
  return out
}

const ROLE_INTENT = /^[\t ]*(?:求职意向|求职目标|目标岗位|应聘岗位|意向岗位|应聘职位|求职职位|期望职位|目标职位|意向职位|应聘意向)[\t ]*[:：][\t ]*([^\r\n]{1,120})$/m
const ROLE_SUFFIX = /(?:工程师|开发|架构师|算法|研究员|经理|主管|专家|分析师|设计师|运营|产品经理|测试|后端|前端|全栈|实习生|DS)$/i
const ROLE_REJECT = /简历|resume|cv|求职|意向|暂无|面议|不限|待定|离职|在职|到岗|期望薪资|副本|最终|修改|v\d|\d{4}/i
const cleanRole = (value, requireSuffix = true) => {
  const first = String(value || '').split(/[|｜/／、，,；;·]/, 1)[0]
    .replace(/[\(（\[【][^\)）\]】]{0,20}[\)）\]】]\s*$/, '')
    .replace(/\s+(?:已离职|离职|在职|可到岗|随时到岗|期望薪资|面议).*$/, '')
    .trim().replace(/^[\s"'“”‘’\-—_]+|[\s"'“”‘’\-—_]+$/g, '')
  if (first.length < 2 || first.length > 40 || ROLE_REJECT.test(first)) return ''
  if (!/[\u3400-\u9fff].*[\u3400-\u9fff]/u.test(first)) return ''
  if (requireSuffix && !ROLE_SUFFIX.test(first)) return ''
  return first
}

// 只接受明确标签或岗位后缀；没有高置信结果时留空，交给用户填写。
export function suggestTargetRole({ fileName = '', text = '' } = {}) {
  const intent = String(text || '').slice(0, 1200).match(ROLE_INTENT)
  const fromIntent = intent ? cleanRole(intent[1]) : ''
  if (fromIntent) return { role: fromIntent, source: 'intent' }
  const base = String(fileName || '').split(/[\\/]/).pop().replace(/\.(?:pdf|docx|txt|md)$/i, '')
  const segments = base.split(/[-_—–]+/).map((part) => part.trim()).filter(Boolean)
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    let candidate = segments[index]
    const spacedName = candidate.match(/^[\u3400-\u9fff]{2,4}\s+(.+)$/)
    if (spacedName && spacedName[1].length >= 4 && !/^(?:后端|前端|全栈|高级|资深|中级|初级|算法|数据|软件|产品|测试|运维|开发)/.test(candidate)) {
      candidate = spacedName[1]
    }
    const role = cleanRole(candidate)
    if (role) return { role, source: 'filename' }
  }
  return { role: '', source: '' }
}

export function parseResumeUpload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw remoteFailure('hr-interview/resume-invalid', '简历文件参数无效')
  const fileName = typeof value.name === 'string' ? value.name.trim().split(/[\\/]/).pop() : ''
  if (!fileName || fileName.length > 160 || /[\u0000-\u001f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(fileName) || !/\.(pdf|docx|txt|md)$/i.test(fileName)) {
    throw remoteFailure('hr-interview/resume-format', '仅支持 PDF、DOCX、TXT、MD 文件')
  }
  const dataBase64 = value.dataBase64
  if (typeof dataBase64 !== 'string' || !dataBase64 || dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
    throw remoteFailure('hr-interview/resume-invalid-data', '简历文件编码无效')
  }
  if (dataBase64.length > MAX_RESUME_BASE64_LENGTH) throw remoteFailure('hr-interview/resume-too-large', '简历文件不能超过 8 MiB')
  const padding = dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0
  const size = dataBase64.length / 4 * 3 - padding
  if (!Number.isSafeInteger(size) || size <= 0) throw remoteFailure('hr-interview/resume-empty', '简历文件为空')
  if (size > MAX_RESUME_FILE_BYTES) throw remoteFailure('hr-interview/resume-too-large', '简历文件不能超过 8 MiB')
  const mimeType = typeof value.mimeType === 'string' ? value.mimeType.split(';', 1)[0].trim().toLowerCase().slice(0, 160) : ''
  return { name: fileName, mimeType, dataBase64, size }
}

export function parsePreparationOptions(value) {
  const input = value === undefined ? {} : value
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw remoteFailure('hr-interview/invalid-preparation-options', 'Preparation options must be an object')
  const durationMinutes = Number(input.durationMinutes || 30)
  if (![15, 30].includes(durationMinutes)) throw remoteFailure('hr-interview/invalid-duration', 'Duration must be 15 or 30 minutes')
  return { durationMinutes, refresh: input.refresh === true, ...(input.changeDirections === true ? { changeDirections: true } : {}) }
}

export function parseSourceSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw remoteFailure('hr-interview/invalid-source-settings', '题库设置必须是对象')
  const msyDir = typeof value.msyDir === 'string' ? value.msyDir.trim() : ''
  if (msyDir.length > 1024 || /[\u0000-\u001f]/.test(msyDir)) throw remoteFailure('hr-interview/invalid-source-dir', '本地题库目录无效')
  return { msyDir }
}

export function parseStartOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw remoteFailure('hr-interview/invalid-options', 'Start options must be an object')
  const durationMinutes = Number(value.durationMinutes || 30)
  if (![15, 30].includes(durationMinutes)) throw remoteFailure('hr-interview/invalid-duration', 'Duration must be 15 or 30 minutes')
  const mode = value.mode === 'drill' ? 'drill' : 'mock'
  const inputMode = value.inputMode === 'text' ? 'text' : 'voice'
  const persona = value.mode === 'pressure' ? 'pressure' : ['pressure', 'professional', 'gentle'].includes(value.persona) ? value.persona : 'professional'
  const parentSessionId = value.parentSessionId ? parseSessionId(value.parentSessionId) : null
  const preparationId = value.preparationId ? parsePreparationId(value.preparationId) : null
  const targetKnowledgePointId = typeof value.targetKnowledgePointId === 'string' ? value.targetKnowledgePointId.slice(0, 120) : null
  const asrProvider = ['auto', 'deepseek', 'local', 'http'].includes(value.asrProvider) ? value.asrProvider : 'auto'
  const ttsProvider = ['auto', 'deepseek', 'browser', 'http'].includes(value.ttsProvider) ? value.ttsProvider : 'auto'
  const voice = parseVoice(value.voice || 'stella')
  return { durationMinutes, mode, inputMode, persona, parentSessionId, preparationId, targetKnowledgePointId, asrProvider, ttsProvider, voice }
}

export function isPressureInterview(session) {
  return session?.mode !== 'drill' && (session?.persona === 'pressure' || session?.mode === 'pressure')
}

export function parseVoice(value) {
  if (!['stella', 'tide'].includes(value)) throw remoteFailure('hr-interview/invalid-voice', 'Voice must be stella or tide')
  return value
}

export function parseApiKey(value) {
  const key = typeof value === 'string' ? value.trim() : ''
  if (key.length < 8 || key.length > 512 || /\s/.test(key)) {
    throw remoteFailure('hr-interview/invalid-api-key', 'API Key 应为 8–512 个不含空白的字符')
  }
  return key
}

export function parseAudio(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw remoteFailure('hr-interview/invalid-audio', 'Audio payload must be an object')
  if (typeof value.audioBase64 !== 'string' || value.audioBase64.length < 16 || value.audioBase64.length > MAX_AUDIO_BASE64_LENGTH || !/^[A-Za-z0-9+/=\r\n]+$/.test(value.audioBase64)) {
    throw remoteFailure('hr-interview/invalid-audio', 'Audio must be bounded base64 data')
  }
  const normalizedMime = typeof value.mimeType === 'string' ? value.mimeType.split(';', 1)[0].trim().toLowerCase() : ''
  if (!/^audio\/(wav|x-wav|webm|ogg|mpeg|mp4)$/.test(normalizedMime)) throw remoteFailure('hr-interview/invalid-audio-mime', 'Unsupported audio MIME type')
  const audioBase64 = value.audioBase64.replace(/\s/g, '')
  if (Math.floor(audioBase64.length * 3 / 4) > 18 * 1024 * 1024) throw remoteFailure('hr-interview/audio-too-large', 'Decoded audio exceeds 18 MiB')
  const durationMs = Number(value.durationMs)
  if (!Number.isFinite(durationMs)) throw remoteFailure('hr-interview/invalid-duration', 'Audio duration is invalid')
  if (durationMs < 100) throw remoteFailure('hr-interview/invalid-duration', '录音太短，请按住说话至少 0.1 秒')
  if (durationMs > 15 * 60 * 1000) throw remoteFailure('hr-interview/invalid-duration', 'Audio duration exceeds the supported request limit')
  return { audioBase64, mimeType: normalizedMime, durationMs }
}

export function parseDeliveryMeta(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const number = (key, max = 3600000) => Number.isFinite(Number(source[key])) ? Math.max(0, Math.min(max, Number(source[key]))) : 0
  return {
    responseLatencyMs: number('responseLatencyMs'), answerDurationMs: number('answerDurationMs'),
    restartCount: number('restartCount', 100), interruptedCount: number('interruptedCount', 100),
    usedFallback: Boolean(source.usedFallback), questionPresentedAt: typeof source.questionPresentedAt === 'string' ? source.questionPresentedAt : null,
    asrModel: typeof source.asrModel === 'string' ? source.asrModel.slice(0, 120) : null,
    asrRequestId: typeof source.asrRequestId === 'string' ? source.asrRequestId.slice(0, 160) : null,
    asrDurationMs: number('asrDurationMs', 120000),
  }
}

export function parseAction(value) {
  if (!['pause', 'resume', 'skip', 'finish', 'end', 'retry', 'cancel'].includes(value)) throw remoteFailure('hr-interview/invalid-action', 'Unknown interview control action')
  return value
}

export const bindRemote = (service, key = HR_SERVICE) => {
  Object.defineProperty(service, 'typertRemote', { value: Object.freeze({ service, serviceKey: key, namespace: key }), enumerable: false })
  return service
}

const codec = (name, parse) => ({ mode: 'strict', typeSymbol: `dsh-hr-interview#${name}`, create: () => ({ parse }) })
const jsonResult = codec('JsonResult', (value) => value)
const anyJson = codec('JsonValue', (value) => value)
const sessionId = codec('SessionId', parseSessionId)
const text = codec('Text', (value) => parseText(value))
const materials = codec('Materials', parseMaterials)
const resumeUpload = codec('ResumeUpload', parseResumeUpload)
const options = codec('StartOptions', parseStartOptions)
const preparationOptions = codec('PreparationOptions', parsePreparationOptions)
const sourceSettings = codec('SourceSettings', parseSourceSettings)
const audio = codec('Audio', parseAudio)
const delivery = codec('DeliveryMeta', parseDeliveryMeta)
const action = codec('Action', parseAction)
const voice = codec('Voice', parseVoice)
const apiKey = codec('ApiKey', parseApiKey)
const cameraToken = codec('LocalCameraToken', (value) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw remoteFailure('hr-interview/invalid-camera-token', '本机预览凭据无效')
  return value
})
const ttsProvider = codec('TtsProvider', (value) => parseStartOptions({ ttsProvider: value }).ttsProvider)
const namedParameter = (wire, parameterCodec = anyJson) => ({ name: wire, wire, source: 'json', codec: parameterCodec })
function method(name, parameters = []) {
  return { id: `dsh-hr-interview#${HR_SERVICE}/${name}`, service: HR_SERVICE, namespace: HR_SERVICE, method: name, invocation: { kind: 'direct' }, result: jsonResult, parameters }
}

export const HR_DESCRIPTORS = Object.freeze([
  method('capabilities'), method('credentialStatus'), method('saveApiKey', [namedParameter('value', apiKey)]), method('clearApiKey'),
  method('materials'), method('saveMaterials', [namedParameter('value', materials)]), method('parseResume', [namedParameter('value', resumeUpload)]),
  method('sourceSettings'), method('saveSourceSettings', [namedParameter('value', sourceSettings)]), method('detectMsySource'),
  method('prepareInterview', [namedParameter('value', preparationOptions)]), method('latestPreparation', [namedParameter('value', preparationOptions)]),
  method('start', [namedParameter('value', options)]), method('get', [namedParameter('sessionId', sessionId)]), method('list'),
  method('submitText', [namedParameter('sessionId', sessionId), namedParameter('text', text), namedParameter('deliveryMeta', delivery)]),
  method('submitAudio', [namedParameter('sessionId', sessionId), namedParameter('audio', audio), namedParameter('deliveryMeta', delivery)]),
  method('transcribe', [namedParameter('sessionId', sessionId), namedParameter('audio', audio)]),
  method('previewVoice', [namedParameter('voice', voice), namedParameter('provider', ttsProvider)]),
  method('testAsr', [namedParameter('audio', audio)]),
  method('control', [namedParameter('sessionId', sessionId), namedParameter('action', action)]),
  method('evaluate', [namedParameter('sessionId', sessionId)]),
  method('speak', [namedParameter('sessionId', sessionId), namedParameter('turnId')]),
  method('knowledge'), method('createDrill', [namedParameter('sessionId', sessionId), namedParameter('questionId')]),
  method('openWindowsCamera', [namedParameter('sessionId', sessionId)]),
  method('startLocalCamera', [namedParameter('sessionId', sessionId)]),
  method('stopLocalCamera', [namedParameter('sessionId', sessionId), namedParameter('token', cameraToken)]),
])
export const HR_HOST_CONTRIBUTION = Object.freeze({ package: 'dsh-hr-interview', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: HR_DESCRIPTORS })
export const HR_CLIENT_REMOTE = Object.freeze({ package: 'dsh-hr-interview', descriptors: HR_DESCRIPTORS })
