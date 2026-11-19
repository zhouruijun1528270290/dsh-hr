import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseMaterials, parseResumeUpload, parseStartOptions, suggestTargetRole } from '../lib/contract.js'
import { HRInterviewService } from '../lib/service.js'
import { InterviewStore } from '../lib/store.js'

const upload = (name, text) => parseResumeUpload({ name, mimeType: 'text/plain', dataBase64: Buffer.from(text).toString('base64') })

test('materials codec accepts partial drafts while preserving field limits', () => {
  const resume = 'x'.repeat(4325)
  assert.deepEqual(parseMaterials({ role: '', resume, jd: '', projectNotes: '' }), { role: '', resume, jd: '', projectNotes: '' })
  assert.deepEqual(parseMaterials({}), { role: '', resume: '', jd: '', projectNotes: '' })
  assert.throws(() => parseMaterials({ role: '', resume: '', jd: 'x'.repeat(30001), projectNotes: '' }), (error) => error.code === 'hr-interview/invalid-text')
})

test('target role suggestion prefers explicit intent and removes status tails', () => {
  const result = suggestTargetRole({
    fileName: '张三-前端工程师.pdf',
    text: '张三\n求职意向：AI 应用开发工程师 / 大模型应用后端 | 已离职，可即时到岗\n项目：Agent',
  })
  assert.deepEqual(result, { role: 'AI 应用开发工程师', source: 'intent' })
  assert.deepEqual(suggestTargetRole({ fileName: '张三-AI应用开发工程师.pdf', text: '姓名：张三' }), { role: 'AI应用开发工程师', source: 'filename' })
  assert.deepEqual(suggestTargetRole({ fileName: '张三-后端开发实习生.docx', text: '' }), { role: '后端开发实习生', source: 'filename' })
})

test('target role suggestion handles intent aliases and spaced filename names', () => {
  assert.deepEqual(suggestTargetRole({ fileName: '张三 AI应用开发工程师.pdf', text: '' }), { role: 'AI应用开发工程师', source: 'filename' })
  assert.deepEqual(suggestTargetRole({ fileName: '张三 后端工程师.pdf', text: '' }), { role: '后端工程师', source: 'filename' })
  assert.deepEqual(suggestTargetRole({ fileName: '后端 开发工程师.pdf', text: '' }), { role: '后端 开发工程师', source: 'filename' })
  assert.deepEqual(suggestTargetRole({ fileName: 'resume.pdf', text: '期望职位：后端开发工程师' }), { role: '后端开发工程师', source: 'intent' })
  assert.deepEqual(suggestTargetRole({ fileName: 'resume.pdf', text: '应聘意向：AI 应用开发工程师' }), { role: 'AI 应用开发工程师', source: 'intent' })
})

test('target role suggestion stays empty for generic or ambiguous input', () => {
  for (const fileName of ['简历.pdf', '简历最终版-v3.pdf', '张三-2026.pdf']) {
    assert.deepEqual(suggestTargetRole({ fileName, text: '' }), { role: '', source: '' })
  }
  assert.deepEqual(suggestTargetRole({ fileName: 'resume.pdf', text: '求职意向：已离职，可即时到岗' }), { role: '', source: '' })
  assert.deepEqual(suggestTargetRole({ fileName: 'resume.pdf', text: '求职意向：北京' }), { role: '', source: '' })
})

test('parseResume exposes structured role suggestions through the Host service', async () => {
  const service = new HRInterviewService({})
  const fromFile = await service.parseResume(upload('张三-AI应用开发工程师.txt', '姓名：张三\n项目：Agent'))
  assert.equal(fromFile.suggestedRole, 'AI应用开发工程师')
  assert.equal(fromFile.suggestedRoleSource, 'filename')
  const fromIntent = await service.parseResume(upload('张三-前端工程师.txt', '求职意向：AI 应用开发工程师 / 大模型应用后端 | 已离职'))
  assert.equal(fromIntent.suggestedRole, 'AI 应用开发工程师')
  assert.equal(fromIntent.suggestedRoleSource, 'intent')
})

test('start still rejects an incomplete draft before creating a session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hr-materials-draft-'))
  try {
    const store = new InterviewStore(root)
    await store.init()
    await store.saveMaterials(parseMaterials({ role: 'AI 应用开发工程师', resume: '已有简历', jd: '', projectNotes: '' }))
    const service = new HRInterviewService({ store, model: {}, speech: {} })
    await assert.rejects(service.start(parseStartOptions({ durationMinutes: 15, inputMode: 'text' })), (error) => error.code === 'hr-interview/materials-required')
    assert.deepEqual(await store.list(), [])
    assert.equal((await store.materials()).resume, '已有简历')
    assert.equal((await store.materials()).jd, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
