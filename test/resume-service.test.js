import test from 'node:test'
import assert from 'node:assert/strict'
import { HRInterviewService } from '../lib/service.js'

const service = () => new HRInterviewService({
  store: {
    materials() { throw new Error('parseResume 不应读取材料') },
    saveMaterials() { throw new Error('parseResume 不应保存材料') },
  },
  model: {}, speech: {},
})

test('service parseResume 解码 base64，返回文本且不触碰材料存储', async () => {
  const result = await service().parseResume({
    name: 'synthetic.txt',
    dataBase64: Buffer.from('\ufeff张三\r\nNode.js 与 Agent 项目', 'utf8').toString('base64'),
  })
  assert.equal(result.fileName, 'synthetic.txt')
  assert.equal(result.format, 'txt')
  assert.equal(result.text, '张三\nNode.js 与 Agent 项目')
  assert.equal(result.characters, result.text.length)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.warnings, [])
})

test('service parseResume 保留安全的业务错误码，不落盘原文件', async () => {
  await assert.rejects(
    service().parseResume({ name: 'fake.pdf', dataBase64: Buffer.from('not a pdf').toString('base64') }),
    (error) => error?.code === 'hr-interview/resume-pdf-header-missing' && !String(error.stack).includes('not a pdf'),
  )
})

test('service parseResume 限制并发，释放计数并保留解析器具体错误', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const expected = { fileName: 'gate.txt', format: 'txt', text: 'gate', characters: 4, truncated: false, warnings: [] }
  const instance = new HRInterviewService({
    resumeConcurrency: 1,
    resumeParser: async ({ data }) => { assert.equal(data.toString(), 'gate'); await gate; return expected },
  })
  const input = { name: 'gate.txt', dataBase64: Buffer.from('gate').toString('base64') }
  const first = instance.parseResume(input)
  assert.equal(instance.resumeActive, 1)
  await assert.rejects(instance.parseResume(input), (error) => error.code === 'hr-interview/resume-busy')
  release()
  assert.deepEqual(await first, { ...expected, suggestedRole: '', suggestedRoleSource: '' })
  assert.equal(instance.resumeActive, 0)

  const failure = new HRInterviewService({ resumeParser: async () => { throw Object.assign(new Error('PDF 已加密'), { code: 'hr-interview/resume-pdf-encrypted' }) } })
  await assert.rejects(failure.parseResume(input), (error) => error.code === 'hr-interview/resume-pdf-encrypted')
  assert.equal(failure.resumeActive, 0)

  const unknown = new HRInterviewService({ resumeParser: async () => { throw new Error('parser crashed') } })
  await assert.rejects(unknown.parseResume(input), (error) => error.code === 'hr-interview/resume-parse')
  assert.equal(unknown.resumeActive, 0)
})
