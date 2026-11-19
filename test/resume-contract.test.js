import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RESUME_FILE_BYTES, MAX_RESUME_BASE64_LENGTH, parseResumeUpload, HR_DESCRIPTORS } from '../lib/contract.js'
import { HRInterviewService } from '../lib/service.js'

const upload = (name, text) => ({ name, mimeType: 'text/plain', dataBase64: Buffer.from(text).toString('base64') })

test('resume upload contract validates real decoded size and normalized file name', () => {
  const parsed = parseResumeUpload(upload('C:\\fake\\简历.TXT', '姓名：测试\n项目：Agent'))
  assert.equal(parsed.name, '简历.TXT')
  assert.equal(parsed.size, Buffer.byteLength('姓名：测试\n项目：Agent'))
  assert.equal(parsed.mimeType, 'text/plain')
  assert.ok(HR_DESCRIPTORS.some((item) => item.method === 'parseResume'))
})

test('resume upload contract rejects unsupported, empty, malformed and oversized files', () => {
  assert.throws(() => parseResumeUpload(upload('resume.exe', 'x')), (error) => error.code === 'hr-interview/resume-format')
  assert.throws(() => parseResumeUpload({ name: 'resume.txt', dataBase64: '' }), (error) => error.code === 'hr-interview/resume-invalid-data')
  assert.throws(() => parseResumeUpload({ name: 'resume.txt', dataBase64: 'abc' }), (error) => error.code === 'hr-interview/resume-invalid-data')
  const oversized = Buffer.alloc(MAX_RESUME_FILE_BYTES + 1).toString('base64')
  assert.equal(MAX_RESUME_BASE64_LENGTH, Math.ceil(MAX_RESUME_FILE_BYTES / 3) * 4)
  assert.equal(oversized.length, MAX_RESUME_BASE64_LENGTH, '8 MiB + 1 恰好与上限等长，仍须按解码字节数拒绝')
  assert.throws(() => parseResumeUpload({ name: 'resume.txt', dataBase64: oversized }), (error) => error.code === 'hr-interview/resume-too-large')
  const longerEncoding = Buffer.alloc(MAX_RESUME_FILE_BYTES + 3).toString('base64')
  assert.ok(longerEncoding.length > MAX_RESUME_BASE64_LENGTH)
  assert.throws(() => parseResumeUpload({ name: 'resume.txt', dataBase64: longerEncoding }), (error) => error.code === 'hr-interview/resume-too-large')
  assert.throws(() => parseResumeUpload(upload('res\u202Eume.txt', 'x')), (error) => error.code === 'hr-interview/resume-format')
})

test('service parses text resume without creating a session or saving the original file', async () => {
  const service = new HRInterviewService({})
  const result = await service.parseResume(parseResumeUpload(upload('resume.md', '# 测试候选人\n\n- 负责 Agent 工作流')))
  assert.equal(result.format, 'md')
  assert.match(result.text, /测试候选人/)
  assert.match(result.text, /Agent 工作流/)
  assert.equal(result.fileName, 'resume.md')
  assert.equal(result.truncated, false)
})
