import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { InterviewStore } from '../lib/store.js'
import { HRInterviewService } from '../lib/service.js'
import { HR_DESCRIPTORS } from '../lib/contract.js'
import { ModelGateway } from '../lib/model-gateway.js'
import { deliveryMetrics, normalizeEvaluation, applyKnowledge } from '../lib/evaluation.js'

const dimensions = ['relevance', 'accuracy', 'evidence', 'structure', 'expression', 'consistency', 'presence'].map((key) => ({ key, score: 70, evidenceTurnIds: [], diagnosis: `${key} diagnosis`, improvement: `${key} improvement` }))
class MockModel {
  capabilities() { return { configured: true, model: 'mock' } }
  async next({ turns, session }) {
    const last = turns.at(-1)
    if (!last) return { action: 'next_question', question: '请介绍你最有代表性的 Agent 项目。', knowledgePointId: 'kp-agent' }
    if (session.mainQuestionCount === 1 && session.followupCount === 0 && last.kind === 'answer') return { action: 'followup', question: '你个人负责哪一部分？具体数据是什么？', knowledgePointId: 'kp-agent' }
    return { action: 'next_question', question: `第 ${session.mainQuestionCount + 1} 题：请说明一次技术权衡。`, knowledgePointId: `kp-${session.mainQuestionCount + 1}` }
  }
  async evaluate() { return { summary: '证据不足，需要量化个人贡献。', priorities: ['补充个人贡献', '量化结果'], dimensions, knowledgePoints: [{ id: 'kp-agent', title: 'Agent 项目拆解', mastery: 4, evidenceRefs: ['material:resume'] }], questionReviews: [{ questionId: 'q-1', issues: ['贡献边界模糊'], rewrite: '我负责检索模块，离线评测提升来自……', drill: '用 90 秒讲清职责边界' }] } }
}
class MockSpeech {
  capabilities() { return { asrConfigured: true, ttsConfigured: true } }
  async transcribe(audio) { assert.ok(audio.audioBase64.length > 8); return { text: '我负责检索与评测，准确率达到 85%。', model: 'mock-asr' } }
  async synthesize(text) { return { audioBase64: Buffer.from(`audio:${text}`).toString('base64'), mimeType: 'audio/mpeg' } }
}
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hr-interview-test-'))
  const store = new InterviewStore(root); await store.init(); await store.saveMaterials({ role: 'Agent 工程师', resume: '做过 Agent 项目', jd: '需要 RAG 与评测', projectNotes: '' })
  const service = new HRInterviewService({ store, model: new MockModel(), speech: new MockSpeech(), ...options })
  return { root, store, service }
}
const within = async (promise) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('operation timed out')), 1500))])
const until = async (predicate, timeoutMs = 1000) => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition was not reached in time')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
const signalType = (value) => Object.prototype.toString.call(value)
test('text interview supports followup, pause, skip, finish, evidence review and 48h review scheduling', async () => {
  const { root, service } = await fixture()
  try {
    let bundle = await within(service.start({ mode: 'standard', persona: 'professional', durationMinutes: 30, inputMode: 'text' }))
    const id = bundle.session.sessionId
    assert.equal(bundle.session.status, 'waiting_for_answer'); assert.equal(bundle.session.mainQuestionCount, 1)
    bundle = await within(service.submitText(id, '我负责 Agent 检索与工具调用。', { answerDurationMs: 20000, responseLatencyMs: 3000 }))
    assert.equal(bundle.turns.at(-1).kind, 'followup'); assert.equal(bundle.session.followupCount, 1)
    bundle = await within(service.control(id, 'pause')); assert.equal(bundle.session.status, 'paused')
    bundle = await within(service.control(id, 'resume')); assert.equal(bundle.session.status, 'waiting_for_answer')
    bundle = await within(service.submitText(id, '我个人完成检索模块，离线准确率从 72% 到 85%。', { answerDurationMs: 18000 }))
    assert.equal(bundle.session.mainQuestionCount, 2)
    bundle = await within(service.control(id, 'skip')); assert.equal(bundle.session.mainQuestionCount, 3)
    bundle = await within(service.control(id, 'finish'))
    assert.equal(bundle.session.status, 'completed'); assert.equal(bundle.evaluation.overallScore, 70)
    assert.equal(bundle.evaluation.questionReviews[0].rewrite.includes('离线评测'), true)
    const knowledge = await service.knowledge(); assert.equal(knowledge[0].mastery, 4); assert.ok(Date.parse(knowledge[0].nextReviewAt) > Date.now() + 47 * 3600000)
    const stored = await readFile(join(root, 'sessions', id, 'turns.json'), 'utf8'); assert.equal(stored.includes('audioBase64'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('voice answer uses ASR, records delivery metrics, keeps audio transient and synthesizes HR voice', async () => {
  const { root, service } = await fixture()
  try {
    let bundle = await service.start({ mode: 'pressure', persona: 'strict', durationMinutes: 30, inputMode: 'voice' }); const id = bundle.session.sessionId
    bundle = await service.submitAudio(id, { audioBase64: Buffer.from('synthetic wav').toString('base64'), mimeType: 'audio/wav' }, { answerDurationMs: 10000 })
    const answer = bundle.turns.find((turn) => turn.speaker === 'candidate')
    assert.equal(answer.asrMeta.audioRetained, false); assert.equal(answer.deliveryMeta.transcriptCharCount > 10, true); assert.equal(answer.deliveryMeta.charsPerSecond > 0, true)
    const hrTurn = bundle.turns.find((turn) => turn.speaker === 'hr')
    const speech = await service.speak(id, hrTurn.id); assert.equal(Buffer.from(speech.audioBase64, 'base64').toString(), `audio:${hrTurn.text}`)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('model interruption preserves answer and retry continues without duplicate answer', async () => {
  const { root, service, store } = await fixture(); let fail = true
  service.model.next = async (context) => { if (fail && context.turns.some((turn) => turn.speaker === 'candidate')) throw new Error('synthetic network failure'); return new MockModel().next(context) }
  try {
    const started = await service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'text' }); const id = started.session.sessionId
    await assert.rejects(service.submitText(id, '这是一个真实回答'), /synthetic network failure/)
    let saved = await store.get(id); assert.equal(saved.session.status, 'error'); assert.equal(saved.turns.filter((turn) => turn.speaker === 'candidate').length, 1)
    fail = false; saved = await service.control(id, 'retry'); assert.equal(saved.session.status, 'waiting_for_answer'); assert.equal(saved.turns.filter((turn) => turn.speaker === 'candidate').length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('evaluation only accepts existing turn evidence and drill does not overwrite mastery truth', async () => {
  const { root, service, store } = await fixture()
  try {
    let bundle = await service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'text' }); const id = bundle.session.sessionId
    await service.submitText(id, '测试回答'); bundle = await service.control(id, 'finish')
    const raw = { dimensions, knowledgePoints: [{ id: 'kp-other', title: '回炉点', mastery: 2 }] }
    const evaluation = normalizeEvaluation(raw, bundle.session, [{ id: 't-real', speaker: 'candidate' }]); assert.deepEqual(evaluation.dimensions[0].evidenceTurnIds, [])
    const before = await store.knowledge(); const drill = await service.createDrill(id, 'kp-agent'); await service.submitText(drill.session.sessionId, '专项回答'); await service.control(drill.session.sessionId, 'finish')
    assert.deepEqual(await store.knowledge(), before); assert.equal(evaluation.knowledgePoints[0].originSessionId, id)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('delivery metrics are explicit and no empty speed division', () => {
  const metrics = deliveryMetrics('嗯，然后就是我负责。', { answerDurationMs: 0, restartCount: 1, usedFallback: true })
  assert.equal(metrics.charsPerSecond, 0); assert.equal(metrics.fillerWordCount >= 2, true); assert.equal(metrics.usedFallback, true)
})
test('voice skip does not count as text fallback and empty finish has a clean exit', async () => {
  const { root, service } = await fixture()
  try {
    let bundle = await service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'voice' }); const id = bundle.session.sessionId
    bundle = await service.control(id, 'skip'); assert.equal(bundle.session.oralAcceptanceEligible, true)
    bundle = await service.control(id, 'finish'); assert.equal(bundle.session.status, 'completed'); assert.equal(bundle.session.evaluationStatus, 'no_content')
    const empty = await service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'text' })
    bundle = await service.control(empty.session.sessionId, 'finish'); assert.equal(bundle.session.status, 'completed'); assert.equal(bundle.session.evaluationStatus, 'no_content'); assert.equal(bundle.evaluation, null)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('direct end saves the interview and defers evaluation until explicitly requested', async (t) => {
  const { root, service, store } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  let evaluations = 0
  const model = new MockModel()
  service.model.evaluate = async () => { evaluations += 1; return model.evaluate() }
  const settings = { mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'text' }
  const opened = await service.start(settings)
  const id = opened.session.sessionId
  const answered = await service.submitText(id, '我负责检索工具的调用和离线评测。')
  const ended = await service.control(id, 'end')
  assert.equal(ended.session.status, 'completed')
  assert.equal(ended.session.evaluationStatus, 'not_requested')
  assert.ok(ended.session.endedAt)
  assert.equal(ended.evaluation, null)
  assert.deepEqual(ended.turns.slice(0, -1), answered.turns)
  assert.equal(ended.turns.at(-1).kind, 'wrap_up')
  assert.doesNotMatch(ended.turns.at(-1).text, /复盘/)
  assert.equal((await store.list()).find((entry) => entry.sessionId === id).evaluationStatus, 'not_requested')
  assert.deepEqual(await store.knowledge(), [])
  assert.deepEqual((await service.control(id, 'end')).turns, ended.turns)
  const empty = await service.start(settings)
  assert.equal((await service.control(empty.session.sessionId, 'end')).session.evaluationStatus, 'not_requested')
  assert.equal(evaluations, 0)
  const reviewed = await service.evaluate(id)
  assert.equal(reviewed.session.evaluationStatus, 'ready')
  assert.ok(reviewed.evaluation)
  assert.deepEqual(reviewed.turns, ended.turns)
  assert.equal(evaluations, 1)
})

test('interrupted generating and processing states can be retried after reopen', async () => {
  const { root, service, store } = await fixture()
  try {
    const started = await service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'text' }); const id = started.session.sessionId
    let bundle = await store.get(id)
    await store.saveSession({ ...bundle.session, status: 'generating_question' }, bundle.turns)
    bundle = await service.control(id, 'retry'); assert.equal(bundle.session.status, 'waiting_for_answer')
    await store.saveSession({ ...bundle.session, status: 'processing_answer' }, bundle.turns)
    bundle = await service.control(id, 'retry'); assert.equal(bundle.session.status, 'waiting_for_answer')
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('materials are required and unevaluated dimensions do not depress the score', async () => {
  const { root, service, store } = await fixture()
  try {
    await store.saveMaterials({ role: '', resume: '', jd: '', projectNotes: '' })
    await assert.rejects(service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'text' }), /简历和岗位 JD/)
    const session = { sessionId: 'hr-test', oralAcceptanceEligible: true }
    const evaluation = normalizeEvaluation({ dimensions: [{ key: 'evidence', score: 80 }] }, session, [])
    assert.equal(evaluation.overallScore, 80); assert.equal(evaluation.dimensions.find((item) => item.key === 'accuracy').evaluated, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('typed descriptors match every public Host method', async () => {
  const { root, service } = await fixture()
  try {
    for (const descriptor of HR_DESCRIPTORS) {
      assert.equal(typeof service[descriptor.method], 'function', descriptor.method)
      for (const parameter of descriptor.parameters) assert.equal(typeof parameter.codec.create().parse, 'function', `${descriptor.method}.${parameter.name}`)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Windows 相机 RPC 只为正在进行的桌面面试请求固定启动动作', async (t) => {
  let attempts = 0
  const { root, service, store } = await fixture({
    windowsCameraLauncher: async (...args) => {
      assert.deepEqual(args, [])
      if (++attempts > 1) throw new Error('C:/Windows/private')
    },
  })
  t.after(() => rm(root, { recursive: true, force: true }))
  const { session, turns } = await service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'text' })
  const id = session.sessionId
  assert.equal((await service.capabilities()).windowsCamera, true)
  assert.deepEqual(await service.openWindowsCamera(id), { requested: true })
  await assert.rejects(service.openWindowsCamera(id), (error) => error.code === 'hr-interview/windows-camera-launch' && !error.message.includes('private'))
  await service.control(id, 'pause')
  await assert.rejects(service.openWindowsCamera(id), { code: 'hr-interview/windows-camera-inactive' })
  await store.saveSession({ ...session, status: 'completed' }, turns)
  await assert.rejects(service.openWindowsCamera(id), { code: 'hr-interview/windows-camera-inactive' })
  assert.equal(attempts, 2)
  const web = new HRInterviewService({ store, model: new MockModel(), speech: new MockSpeech() })
  assert.equal((await web.capabilities()).windowsCamera, false)
  await assert.rejects(web.openWindowsCamera(id), { code: 'hr-interview/windows-camera-unavailable' })
})

test('本机摄像头预览与面试生命周期绑定，暂停、继续和结束分别处理', async (t) => {
  const events = []
  const token = '9a'.repeat(32)
  const localCamera = {
    available: () => true,
    start(id) { events.push(['start', id]); return { token } },
    stop(id) { events.push(['stop', id]) },
  }
  const { root, service } = await fixture({ localCamera })
  t.after(() => rm(root, { recursive: true, force: true }))
  const { session } = await service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'text' })
  const id = session.sessionId
  assert.equal((await service.capabilities()).localCamera, true)
  assert.deepEqual(await service.startLocalCamera(id), { token })
  await service.control(id, 'pause')
  await assert.rejects(service.startLocalCamera(id), { code: 'hr-interview/local-camera-inactive' })
  await service.control(id, 'resume')
  assert.deepEqual(events, [['start', id], ['stop', id]])
  await service.startLocalCamera(id)
  await service.finish(id)
  await assert.rejects(service.startLocalCamera(id), { code: 'hr-interview/local-camera-inactive' })
  assert.deepEqual(events, [['start', id], ['stop', id], ['start', id], ['stop', id]])
})
test('evaluating and review_pending can recover, while active interviews cannot be evaluated', async () => {
  const { root, service, store } = await fixture()
  try {
    let bundle = await service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'text' }); const id = bundle.session.sessionId
    await assert.rejects(service.evaluate(id), /Finish the interview/)
    bundle = await service.submitText(id, '可复盘的回答')
    await store.saveSession({ ...bundle.session, status: 'evaluating', evaluationStatus: 'pending' }, bundle.turns)
    bundle = await service.evaluate(id); assert.equal(bundle.session.status, 'completed'); assert.equal(bundle.session.evaluationStatus, 'ready')
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('evaluation failure enters review_pending and retry preserves the completed transcript', async () => {
  const { root, service, store } = await fixture()
  try {
    let bundle = await service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'text' }); const id = bundle.session.sessionId
    bundle = await service.submitText(id, '回答内容不会因复盘失败丢失')
    service.model.evaluate = async () => { throw new Error('synthetic evaluation failure') }
    await assert.rejects(service.control(id, 'finish'), /synthetic evaluation failure/)
    bundle = await store.get(id); assert.equal(bundle.session.status, 'review_pending'); assert.ok(bundle.turns.some((turn) => turn.kind === 'answer'))
    service.model.evaluate = new MockModel().evaluate
    bundle = await service.evaluate(id); assert.equal(bundle.session.status, 'completed'); assert.equal(bundle.evaluation.overallScore, 70)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('DeepSeek transcription waits for confirmation and preserves ASR metadata without storing audio', async () => {
  const { root, service, store } = await fixture()
  try {
    service.speech.transcribe = async () => ({ text: '我负责检索模块，准确率提升到 85%。', model: 'deepseek-asr', requestId: 'req-confirm', durationMs: 3200 })
    const started = await service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'voice', asrProvider: 'deepseek', ttsProvider: 'deepseek', voice: 'stella' }); const id = started.session.sessionId
    const transcript = await service.transcribe(id, { audioBase64: Buffer.from('synthetic wav').toString('base64'), mimeType: 'audio/wav' })
    assert.equal(transcript.requestId, 'req-confirm'); assert.equal(transcript.durationMs, 3200)
    let saved = await store.get(id); assert.equal(saved.session.status, 'waiting_for_answer'); assert.equal(saved.turns.some((turn) => turn.speaker === 'candidate'), false)
    saved = await service.submitText(id, transcript.text, { asrModel: transcript.model, asrRequestId: transcript.requestId, asrDurationMs: transcript.durationMs, answerDurationMs: 3200 })
    const answer = saved.turns.find((turn) => turn.speaker === 'candidate'); assert.equal(answer.asrMeta.requestId, 'req-confirm'); assert.equal(answer.asrMeta.audioRetained, false); assert.equal(saved.session.oralAcceptanceEligible, true)
    const stored = await readFile(join(root, 'sessions', id, 'turns.json'), 'utf8'); assert.equal(stored.includes('audioBase64'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('TTS cache coalesces concurrent and repeated playback, and evicts failures', async () => {
  const { root, service } = await fixture()
  try {
    const started = await service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'voice', ttsProvider: 'deepseek', voice: 'tide' }); const id = started.session.sessionId; const turnId = started.turns[0].id
    let calls = 0; let fail = true
    service.speech.synthesize = async (text, options) => { calls += 1; assert.equal(options.voice, 'tide'); await new Promise((resolve) => setTimeout(resolve, 5)); if (fail) throw new Error('synthetic TTS failure'); return { audioBase64: Buffer.from(`audio:${text}`).toString('base64'), mimeType: 'audio/wav' } }
    await assert.rejects(Promise.all([service.speak(id, turnId), service.speak(id, turnId)]), /synthetic TTS failure/); assert.equal(calls, 1)
    fail = false
    const [first, second] = await Promise.all([service.speak(id, turnId), service.speak(id, turnId)]); assert.equal(calls, 2); assert.equal(first.audioBase64, second.audioBase64)
    await service.speak(id, turnId); assert.equal(calls, 2, 'resolved playback must reuse the cached synthesis')
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('pause during start generation aborts the request before waiting for the lock and keeps no stale snapshot', async () => {
  const { root, service, store } = await fixture()
  try {
    let release; const gate = new Promise((resolve) => { release = resolve })
    let sessionId = null; let options = null
    service.model.next = async (context, modelOptions = {}) => { sessionId = context.session.sessionId; options = modelOptions; await gate; return { action: 'next_question', question: '迟到的题目不应落地' } }
    const starting = service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'text' })
    await until(() => Boolean(sessionId))
    const pausing = service.control(sessionId, 'pause')
    await until(() => options?.signal?.aborted === true)
    release()
    const [started, paused] = await Promise.all([starting, pausing])
    assert.equal(started.turns.length, 0, 'aborted generation must not append a question')
    assert.equal(started.session.currentQuestionId, null)
    assert.equal(paused.session.status, 'paused')
    assert.equal(paused.session.resumeStatus, 'generating_question')
    assert.equal(paused.turns.length, 0)
    const stored = await store.get(sessionId)
    assert.equal(stored.session.status, 'paused'); assert.equal(stored.turns.length, 0)
    service.model.next = async () => ({ action: 'next_question', question: '恢复后重新生成的题目' })
    const resumed = await service.control(sessionId, 'resume')
    assert.equal(resumed.session.status, 'waiting_for_answer')
    assert.equal(resumed.turns.at(-1)?.text, '恢复后重新生成的题目')
    assert.equal(service.requests.size, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('pause is idempotent and never rewrites resumeStatus to paused', async () => {
  const { root, service } = await fixture()
  try {
    const started = await service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'text' })
    const id = started.session.sessionId
    let bundle = await service.control(id, 'pause')
    assert.equal(bundle.session.status, 'paused'); assert.equal(bundle.session.resumeStatus, 'waiting_for_answer')
    bundle = await service.control(id, 'pause')
    assert.equal(bundle.session.status, 'paused'); assert.equal(bundle.session.resumeStatus, 'waiting_for_answer')
    bundle = await service.control(id, 'resume')
    assert.equal(bundle.session.status, 'waiting_for_answer'); assert.equal(bundle.session.resumeStatus, null)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('cancel aborts the in-flight request and returns the untouched bundle', async () => {
  const { root, service, store } = await fixture()
  try {
    let release; const gate = new Promise((resolve) => { release = resolve })
    let sessionId = null; let signal = null
    service.model.next = async (context, modelOptions = {}) => { sessionId = context.session.sessionId; signal = modelOptions.signal; await gate; return { action: 'next_question', question: '取消后不应落地' } }
    const starting = service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'text' })
    await until(() => Boolean(sessionId))
    const cancelling = service.control(sessionId, 'cancel')
    await until(() => signal?.aborted === true)
    release()
    const [, bundle] = await Promise.all([starting, cancelling])
    assert.equal(bundle.session.status, 'generating_question')
    assert.equal(bundle.turns.length, 0)
    assert.equal((await store.get(sessionId)).turns.length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('response latency falls back to askedAt unless a positive explicit value is given', async () => {
  const { root, service } = await fixture()
  try {
    const started = await service.start({ mode: 'standard', persona: 'professional', durationMinutes: 30, inputMode: 'text' })
    const id = started.session.sessionId
    await new Promise((resolve) => setTimeout(resolve, 20))
    let bundle = await service.submitText(id, '第一段回答，没有传延迟')
    const first = bundle.turns.filter((turn) => turn.speaker === 'candidate').at(-1)
    assert.equal(first.deliveryMeta.responseLatencyMs > 0, true)
    await new Promise((resolve) => setTimeout(resolve, 5))
    bundle = await service.submitText(id, '第二段回答，延迟显式为 0', { responseLatencyMs: 0 })
    const second = bundle.turns.filter((turn) => turn.speaker === 'candidate').at(-1)
    assert.equal(second.deliveryMeta.responseLatencyMs > 0, true)
    bundle = await service.submitText(id, '第三段回答，延迟显式 3000ms', { responseLatencyMs: 3000 })
    const third = bundle.turns.filter((turn) => turn.speaker === 'candidate').at(-1)
    assert.equal(third.deliveryMeta.responseLatencyMs, 3000)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('speech cache uses sha256 keys with entry and byte ceilings', async () => {
  const { root, service } = await fixture({ speechCache: { maxEntries: 2, maxBytes: 48 } })
  try {
    const started = await service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'voice', ttsProvider: 'deepseek', voice: 'tide' })
    const id = started.session.sessionId; const turn = started.turns[0]
    let calls = 0
    service.speech.synthesize = async (text, options) => { calls += 1; assert.equal(options.voice, 'tide'); return { audioBase64: Buffer.from(`audio:${text}`).toString('base64'), mimeType: 'audio/wav' } }
    const key = service.speechKey(id, 'deepseek', 'tide', turn.text)
    assert.equal(key.startsWith(`${id}:`), true)
    assert.equal(/^hr-[a-z0-9-]+:[a-f0-9]{64}$/.test(key), true, 'cache key must be a session prefix plus sha256 of provider/voice/text')
    await service.speak(id, turn.id); assert.equal(calls, 1)
    assert.equal(service.speechCache.size, 0, 'a payload above the byte ceiling is returned once but not retained')
    await service.speak(id, turn.id); assert.equal(calls, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('finish clears only that session speech cache and keeps the documented limits', async () => {
  const { root, service } = await fixture()
  try {
    assert.equal(service.cacheLimits.maxEntries, 128)
    assert.equal(service.cacheLimits.maxBytes, 32 * 1024 * 1024)
    const started = await service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'voice', ttsProvider: 'deepseek', voice: 'tide' })
    const id = started.session.sessionId; const turn = started.turns[0]
    let calls = 0
    service.speech.synthesize = async (text) => { calls += 1; return { audioBase64: Buffer.from(`audio:${text}`).toString('base64'), mimeType: 'audio/wav' } }
    await service.speak(id, turn.id); assert.equal(calls, 1); assert.equal(service.speechCache.size, 1)
    await service.control(id, 'finish')
    assert.equal(service.speechCache.size, 0)
    await service.speak(id, turn.id); assert.equal(calls, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('service threads abort signals into generation and evaluation model calls', async () => {
  const { root, service } = await fixture()
  try {
    let generationOptions = null; let evaluationOptions = null
    service.model.next = async (context, options = {}) => { generationOptions = options; return new MockModel().next(context) }
    service.model.evaluate = async (context, options = {}) => { evaluationOptions = options; return new MockModel().evaluate() }
    let bundle = await service.start({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'text' })
    const id = bundle.session.sessionId
    assert.equal(signalType(generationOptions?.signal), '[object AbortSignal]')
    assert.equal(generationOptions.signal.aborted, false)
    bundle = await service.submitText(id, '用于复盘信号测试的回答')
    bundle = await service.control(id, 'finish')
    assert.equal(signalType(evaluationOptions?.signal), '[object AbortSignal]')
    assert.equal(bundle.session.status, 'completed')
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('stateless DeepSeek ASR diagnostic returns text without creating a session', async () => {
  const { root, service } = await fixture()
  try {
    let provider = null
    service.speech.transcribe = async (audio, options) => { provider = options.provider; assert.ok(audio.audioBase64); return { text: '诊断识别成功', model: 'deepseek-asr' } }
    const before = await service.list()
    const result = await service.testAsr({ audioBase64: Buffer.from('diagnostic').toString('base64'), mimeType: 'audio/wav', durationMs: 100 })
    const after = await service.list()
    assert.equal(result.text, '诊断识别成功'); assert.equal(provider, 'deepseek')
    assert.equal(after.sessions.length, before.sessions.length)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Host model combines the external signal and never retries over HTTP after abort', async () => {
  const controller = new AbortController()
  const streamed = []
  const llm = {
    stream(options) {
      streamed.push(options)
      return (async function* () {
        await new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }) })
      })()
    },
  }
  let fetches = 0
  const gateway = new ModelGateway({ modelApiKey: 'test-key', modelBaseUrl: 'https://model.invalid/v1' }, async () => { fetches += 1; throw new Error('HTTP must not be reached after abort') }, { llm })
  const pending = gateway.complete('system', 'user', { signal: controller.signal })
  await until(() => streamed.length === 1)
  assert.equal(signalType(streamed[0].signal), '[object AbortSignal]')
  controller.abort()
  await assert.rejects(pending, (error) => error.code === 'hr-interview/aborted' && error.aborted === true)
  assert.equal(fetches, 0)
})

