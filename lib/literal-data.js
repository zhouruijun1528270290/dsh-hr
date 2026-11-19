/**
 * literal-data.js — 受限 JS 字面量解析器（只认数据，不执行任何代码）
 *
 * 用途：读取 msy 的 `resume-bank.mjs`，但**绝不** import / require / eval 它。
 * 只接受以下语法：
 *   · 对象 `{}`（键为标识符或单双引号字符串）、数组 `[]`
 *   · 字符串：单引号、双引号、无插值的反引号
 *   · 数字（十进制，可带小数与指数，可带负号）、true / false / null
 *   · `//`、`/* *\/` 注释、数组/对象尾随逗号、任意空白
 *
 * 明确拒绝（都会抛 LiteralDataError）：
 *   函数调用 `f()`、`import` / `require`、模板插值 `${...}`、任何运算与比较、
 *   标识符值（`undefined`、`process`、`NaN`…）、展开 `...`、正则字面量、
 *   计算键 `[k]:`、方法简写 `f() {}`、自增自减、赋值、多条语句。
 *
 * 错误信息只带原因码与偏移量，不回显源码片段，便于上层做脱敏。
 */

const MAX_DEPTH = 64

/** 解析失败；reason 是稳定原因码（可安全外传），offset 是字符偏移。 */
export class LiteralDataError extends Error {
  constructor(reason, offset = 0) {
    super(`不允许的字面量语法：${reason}（偏移 ${offset}）`)
    this.name = 'LiteralDataError'
    this.reason = reason
    this.offset = offset
  }
}

const IDENT_START = /[A-Za-z_$]/
const IDENT_PART = /[A-Za-z0-9_$]/
const WHITESPACE = /[\s\uFEFF\u00a0]/
const HEX = /[0-9a-fA-F]/
const KEYWORDS = new Map([['true', true], ['false', false], ['null', null]])
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/
const SIMPLE_ESCAPES = new Map([
  ['n', '\n'], ['r', '\r'], ['t', '\t'], ['b', '\b'], ['f', '\f'], ['v', '\v'],
  ['0', '\0'], ['\\', '\\'], ['/', '/'], ['$', '$'], ['`', '`'],
  ["'", "'"], ['"', '"'],
])

class Reader {
  constructor(source) {
    this.source = source
    this.index = 0
    this.depth = 0
  }

  fail(reason) {
    throw new LiteralDataError(reason, this.index)
  }

  get current() {
    return this.source[this.index]
  }

  /** 跳过空白与注释；未闭合的块注释直接失败。 */
  skipTrivia() {
    for (;;) {
      const char = this.current
      if (char === undefined) return
      if (WHITESPACE.test(char)) { this.index += 1; continue }
      if (char === '/' && this.source[this.index + 1] === '/') {
        const next = this.source.indexOf('\n', this.index + 2)
        this.index = next === -1 ? this.source.length : next + 1
        continue
      }
      if (char === '/' && this.source[this.index + 1] === '*') {
        const end = this.source.indexOf('*/', this.index + 2)
        if (end === -1) this.fail('unterminated-comment')
        this.index = end + 2
        continue
      }
      return
    }
  }

  readWord() {
    if (!IDENT_START.test(this.current ?? '')) this.fail('unexpected-token')
    const start = this.index
    while (this.index < this.source.length && IDENT_PART.test(this.source[this.index])) this.index += 1
    return this.source.slice(start, this.index)
  }

  expectWord(word) {
    this.skipTrivia()
    const start = this.index
    const actual = this.readWord()
    if (actual !== word) throw new LiteralDataError('unexpected-token', start)
  }

  enter() {
    this.depth += 1
    if (this.depth > MAX_DEPTH) this.fail('too-deep')
  }

  leave() {
    this.depth -= 1
  }

  parseValue() {
    this.skipTrivia()
    const char = this.current
    if (char === undefined) this.fail('unexpected-end')
    if (char === '{') return this.parseObject()
    if (char === '[') return this.parseArray()
    if (char === '"' || char === "'") return this.parseString(char)
    if (char === '`') return this.parseTemplate()
    if (char === '-' || (char >= '0' && char <= '9')) return this.parseNumber()
    if (IDENT_START.test(char)) return this.parseKeyword()
    return this.fail('unsupported-value')
  }

  parseKeyword() {
    const start = this.index
    const word = this.readWord()
    if (!KEYWORDS.has(word)) throw new LiteralDataError('unsupported-identifier', start)
    return KEYWORDS.get(word)
  }

  parseNumber() {
    this.skipTrivia()
    const rest = this.source.slice(this.index)
    const match = NUMBER.exec(rest)
    if (!match) this.fail('invalid-number')
    const next = this.source[this.index + match[0].length]
    if (next !== undefined && IDENT_PART.test(next)) this.fail('invalid-number')
    this.index += match[0].length
    const value = Number(match[0])
    if (!Number.isFinite(value)) this.fail('invalid-number')
    return value
  }

  parseObject() {
    this.enter()
    this.index += 1
    const out = {}
    for (;;) {
      this.skipTrivia()
      const char = this.current
      if (char === undefined) this.fail('unterminated-object')
      if (char === '}') { this.index += 1; this.leave(); return out }
      let key
      if (char === '"' || char === "'") key = this.parseString(char)
      else if (IDENT_START.test(char)) key = this.readWord()
      else this.fail('unsupported-key')
      this.skipTrivia()
      if (this.current !== ':') this.fail('expected-colon')
      this.index += 1
      out[key] = this.parseValue()
      this.skipTrivia()
      const separator = this.current
      if (separator === ',') { this.index += 1; continue }
      if (separator === '}') { this.index += 1; this.leave(); return out }
      this.fail('expected-comma-or-end')
    }
  }

  parseArray() {
    this.enter()
    this.index += 1
    const out = []
    for (;;) {
      this.skipTrivia()
      const char = this.current
      if (char === undefined) this.fail('unterminated-array')
      if (char === ']') { this.index += 1; this.leave(); return out }
      out.push(this.parseValue())
      this.skipTrivia()
      const separator = this.current
      if (separator === ',') { this.index += 1; continue }
      if (separator === ']') { this.index += 1; this.leave(); return out }
      this.fail('expected-comma-or-end')
    }
  }

  /** 转义序列；只认 JS 字符串里合法的字符转义。 */
  readEscape() {
    this.index += 1 // 反斜杠
    const char = this.current
    if (char === undefined) this.fail('unterminated-string')
    if (char === '\n') { this.index += 1; return '' } // 续行
    if (char === '\r') {
      this.index += 1
      if (this.current === '\n') this.index += 1
      return ''
    }
    if (char === 'u') {
      this.index += 1
      if (this.current === '{') {
        const end = this.source.indexOf('}', this.index)
        if (end === -1) this.fail('invalid-escape')
        const digits = this.source.slice(this.index + 1, end)
        if (!/^[0-9a-fA-F]{1,6}$/.test(digits)) this.fail('invalid-escape')
        const code = Number.parseInt(digits, 16)
        if (code > 0x10ffff) this.fail('invalid-escape')
        this.index = end + 1
        return String.fromCodePoint(code)
      }
      return this.readHex(4)
    }
    if (char === 'x') {
      this.index += 1
      return this.readHex(2)
    }
    if (char === '1' || char === '2' || char === '3' || char === '4'
      || char === '5' || char === '6' || char === '7' || char === '8' || char === '9') {
      this.fail('unsupported-escape')
    }
    if (!SIMPLE_ESCAPES.has(char)) this.fail('unsupported-escape')
    this.index += 1
    return SIMPLE_ESCAPES.get(char)
  }

  readHex(length) {
    const digits = this.source.slice(this.index, this.index + length)
    if (digits.length !== length || ![...digits].every((char) => HEX.test(char))) this.fail('invalid-escape')
    this.index += length
    return String.fromCharCode(Number.parseInt(digits, 16))
  }

  parseString(quote) {
    const start = this.index
    this.index += 1
    let out = ''
    for (;;) {
      const char = this.source[this.index]
      if (char === undefined) throw new LiteralDataError('unterminated-string', start)
      if (char === '\\') { out += this.readEscape(); continue }
      if (char === '\n' || char === '\r') throw new LiteralDataError('unterminated-string', start)
      this.index += 1
      if (char === quote) return out
      out += char
    }
  }

  /** 反引号模板：允许换行与普通转义，但出现 `${` 即视为可执行语法。 */
  parseTemplate() {
    const start = this.index
    this.index += 1
    let out = ''
    for (;;) {
      const char = this.source[this.index]
      if (char === undefined) throw new LiteralDataError('unterminated-template', start)
      if (char === '\\') { out += this.readEscape(); continue }
      if (char === '$' && this.source[this.index + 1] === '{') {
        throw new LiteralDataError('template-interpolation', this.index)
      }
      this.index += 1
      if (char === '`') return out
      out += char
    }
  }
}

/** 解析单个字面量表达式；结尾只允许空白与注释。 */
export function parseLiteral(source) {
  if (typeof source !== 'string') throw new LiteralDataError('invalid-source', 0)
  const reader = new Reader(source)
  const value = reader.parseValue()
  reader.skipTrivia()
  if (reader.index < source.length) throw new LiteralDataError('unexpected-token', reader.index)
  return value
}

/**
 * 精确提取 `export const <name> = <字面量>`；出现任何其它语句一律拒绝。
 * 文件前后允许注释与空白（真实 resume-bank.mjs 的文件头就是块注释）。
 */
export function parseExportedConst(source, name = 'RESUME_BANK') {
  if (typeof source !== 'string') throw new LiteralDataError('invalid-source', 0)
  if (typeof name !== 'string' || !IDENT_START.test(name) || ![...name].every((char) => IDENT_PART.test(char))) {
    throw new LiteralDataError('invalid-binding-name', 0)
  }
  const reader = new Reader(source)
  reader.expectWord('export')
  reader.expectWord('const')
  reader.skipTrivia()
  const bindingStart = reader.index
  const binding = reader.readWord()
  if (binding !== name) throw new LiteralDataError('unexpected-binding', bindingStart)
  reader.skipTrivia()
  if (reader.current !== '=') reader.fail('expected-assign')
  reader.index += 1
  const value = reader.parseValue()
  reader.skipTrivia()
  // 只允许一个可选的语句结束分号（真实文件写作 `];`），其后必须直接结束。
  if (reader.current === ';') {
    reader.index += 1
    reader.skipTrivia()
  }
  if (reader.index < source.length) throw new LiteralDataError('unexpected-token', reader.index)
  return value
}
