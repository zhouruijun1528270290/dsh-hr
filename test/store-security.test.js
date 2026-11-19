import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InterviewStore } from '../lib/store.js'

test('损坏的材料存储不会把个人绝对路径发送到前端', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hr-store-security-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'materials.json'), '{broken', 'utf8')
  await assert.rejects(new InterviewStore(root).materials(), (error) => {
    assert.equal(error.code, 'hr-interview/corrupt-store')
    assert.equal(error.message, '本地数据文件损坏，请先备份再重置')
    assert.equal(error.message.includes(root), false)
    assert.equal(Object.hasOwn(error, 'details') && Object.hasOwn(error.details, 'cause'), false)
    return true
  })
})
