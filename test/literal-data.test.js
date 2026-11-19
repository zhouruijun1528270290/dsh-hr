import assert from 'node:assert/strict'
import test from 'node:test'
import { LiteralDataError, parseExportedConst, parseLiteral } from '../lib/literal-data.js'

const reasonOf = (fn) => {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof LiteralDataError, `期望 LiteralDataError，实际 ${error?.name}`)
    assert.equal(error.name, 'LiteralDataError')
    return error
  }
  assert.fail('期望抛出 LiteralDataError，实际没有抛错')
}

test('parseLiteral：完整数据语法一次性解析', () => {
  const source = `
    // 行注释
    {
      "双引号": 'single-quoted',
      plain: \`template without interpolation\`,
      nested: { list: [1, -2, 3.5, 1e3, -2.5e-2,], deep: [[{ a: true }]] },
      truthy: true,
      falsy: false,
      empty: null,
      escaped: 'line\\nbreak\\ttab\\u0041\\x42',
      /* 块注释 */
    }
    // 结尾注释
  `
  const value = parseLiteral(source)
  assert.deepEqual(value, {
    双引号: 'single-quoted',
    plain: 'template without interpolation',
    nested: { list: [1, -2, 3.5, 1000, -0.025], deep: [[{ a: true }]] },
    truthy: true,
    falsy: false,
    empty: null,
    escaped: 'line\nbreak\ttabAB',
  })
})

test('parseLiteral：接受无插值模板里的换行与 unicode 码点转义', () => {
  assert.equal(parseLiteral('`第一行\n第二行`'), '第一行\n第二行')
  assert.equal(parseLiteral("'\\u{1F600}'"), '\u{1F600}')
  assert.equal(parseLiteral("`a\\`b`"), 'a`b')
})

test('parseLiteral：拒绝可执行语法', () => {
  const cases = [
    ['foo()', 'unsupported-identifier'],
    ['{ a: bar }', 'unsupported-identifier'],
    ['[undefined]', 'unsupported-identifier'],
    ['import fs from "node:fs"', 'unsupported-identifier'],
    ['require("node:fs")', 'unsupported-identifier'],
    ['`a ${b} b`', 'template-interpolation'],
    ["'x' + 'y'", 'unexpected-token'],
    ['1 + 2', 'unexpected-token'],
    ['[1, ...rest]', 'unsupported-value'],
    ['{ a: /regex/ }', 'unsupported-value'],
    ['{ [key]: 1 }', 'unsupported-key'],
    ['{ method() { return 1 } }', 'expected-colon'],
    ['{ a: 1 b: 2 }', 'expected-comma-or-end'],
    ['{ a: }', 'unsupported-value'],
    ["'unterminated", 'unterminated-string'],
    ['`unterminated', 'unterminated-template'],
    ['/* unterminated', 'unterminated-comment'],
    ["'bad \\q escape'", 'unsupported-escape'],
    ["'legacy \\1 escape'", 'unsupported-escape'],
    ["'\\u12'", 'invalid-escape'],
    ["'\\u{110000}'", 'invalid-escape'],
    ['01', 'invalid-number'],
    ['1e', 'invalid-number'],
    ['', 'unexpected-end'],
    ['{ a: 1 } trailing', 'unexpected-token'],
    [`${'['.repeat(65)}${']'.repeat(65)}`, 'too-deep'],
  ]
  for (const [source, reason] of cases) {
    const error = reasonOf(() => parseLiteral(source))
    assert.equal(error.reason, reason, `源码 ${JSON.stringify(source)} 的原因码应为 ${reason}`)
    assert.equal(typeof error.offset, 'number')
    assert.ok(error.offset >= 0)
  }
})

test('parseLiteral：错误信息不回显源码', () => {
  const error = reasonOf(() => parseLiteral('{ a: process.env.SECRET }'))
  assert.ok(error.message.includes('unsupported-identifier'))
  assert.ok(!error.message.includes('process'))
  assert.ok(!error.message.includes('SECRET'))
})

test('parseLiteral：非字符串输入直接拒绝', () => {
  assert.equal(reasonOf(() => parseLiteral(123)).reason, 'invalid-source')
  assert.equal(reasonOf(() => parseLiteral(null)).reason, 'invalid-source')
})

test('parseExportedConst：真实形态（块注释文件头 + 尾随分号）可解析', () => {
  const source = `/**
 * 本地简历题库
 */
export const RESUME_BANK = [
  // 第一条
  {
    id: 'r-cas-1',
    module: 'cas',
    level: 1,
    checklist: '一',
    q: 'CAS 原理',
    a: \`先讲预期值比较
再讲失败重试\`,
  },
  { id: 'r-go-1', module: 'go', q: 'GMP 调度', a: 'G/M/P' },
];
`
  const value = parseExportedConst(source, 'RESUME_BANK')
  assert.equal(Array.isArray(value), true)
  assert.equal(value.length, 2)
  assert.deepEqual(value[0], {
    id: 'r-cas-1',
    module: 'cas',
    level: 1,
    checklist: '一',
    q: 'CAS 原理',
    a: '先讲预期值比较\n再讲失败重试',
  })
  assert.deepEqual(value[1], { id: 'r-go-1', module: 'go', q: 'GMP 调度', a: 'G/M/P' })
})

test('parseExportedConst：无分号结尾同样接受', () => {
  assert.deepEqual(parseExportedConst('export const RESUME_BANK = [1, 2]'), [1, 2])
})

test('parseExportedConst：拒绝其它语句与绑定', () => {
  assert.equal(
    reasonOf(() => parseExportedConst('export const OTHER = [1]')).reason,
    'unexpected-binding',
  )
  assert.equal(
    reasonOf(() => parseExportedConst("import fs from 'node:fs'\nexport const RESUME_BANK = [1]")).reason,
    'unexpected-token',
  )
  assert.equal(
    reasonOf(() => parseExportedConst('export const RESUME_BANK = []; const extra = 1')).reason,
    'unexpected-token',
  )
  assert.equal(
    reasonOf(() => parseExportedConst('export const RESUME_BANK = [load()]')).reason,
    'unsupported-identifier',
  )
  assert.equal(
    reasonOf(() => parseExportedConst('export const RESUME_BANK = [`${x}`]')).reason,
    'template-interpolation',
  )
  assert.equal(
    reasonOf(() => parseExportedConst('export const RESUME_BANK [1]')).reason,
    'expected-assign',
  )
  assert.equal(
    reasonOf(() => parseExportedConst('export function read() { return 1 }')).reason,
    'unexpected-token',
  )
  assert.equal(
    reasonOf(() => parseExportedConst('export default [1]')).reason,
    'unexpected-token',
  )
  assert.equal(
    reasonOf(() => parseExportedConst('export const 1BAD = [1]')).reason,
    'unexpected-token',
  )
})

test('parseExportedConst：绑定名校验与自定义名', () => {
  assert.equal(reasonOf(() => parseExportedConst('[1]', '')).reason, 'invalid-binding-name')
  assert.deepEqual(parseExportedConst('export const BANKS = [{ a: 1 }]', 'BANKS'), [{ a: 1 }])
  assert.equal(reasonOf(() => parseExportedConst('export const BANKS = [1]', 'OTHER')).reason, 'unexpected-binding')
})
