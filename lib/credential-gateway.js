import { parseApiKey, remoteFailure } from './contract.js'

export const DEEPSEEK_CREDENTIAL = 'DEEPSEEK_API_KEY'
const SOURCES = new Set(['env', 'file', 'project-env', 'user-env'])
const environmentValue = (env) => String(env?.HR_INTERVIEW_DEEPSEEK_API_KEY || env?.DEEPSEEK_API_KEY || '').trim()
const source = (value) => SOURCES.has(value) ? value : null
const shadowed = (error) => /shadowed|read.only|launching environment/i.test(String(error?.message || error || ''))

export class CredentialGateway {
  constructor({ service = null, env = process.env } = {}) { this.service = service; this.env = env }
  setService(service) { this.service = service || null }
  async describe() {
    // 启动环境优先级最高，且会遮蔽同名 stored key；状态必须与 provider 的真实行为一致。
    if (environmentValue(this.env)) return { configured: true, source: 'env', writable: false }
    if (!this.service) return { configured: false, source: null, writable: false }
    try {
      const info = await this.service.describe(DEEPSEEK_CREDENTIAL)
      return {
        configured: Boolean(info?.configured),
        source: info?.configured ? source(info?.source) : null,
        writable: Boolean(info?.writable),
      }
    } catch {
      // describe 抖动不让整页失效；resolve 仍有独立的环境回退。
      return { configured: false, source: null, writable: false }
    }
  }
  async resolve() {
    if (this.service) {
      try {
        const resolved = await this.service.resolve(DEEPSEEK_CREDENTIAL)
        if (typeof resolved?.value === 'string' && resolved.value.trim()) return parseApiKey(resolved.value)
      } catch {
        // stored record 不可用/格式错误时仍允许启动环境回退。
      }
    }
    const fallback = environmentValue(this.env)
    return fallback ? parseApiKey(fallback) : null
  }
  async save(value) {
    const key = parseApiKey(value)
    if (!this.service) throw remoteFailure('hr-interview/credentials-unavailable', '当前 DSH 凭据服务不可用，可继续使用启动环境变量')
    if (environmentValue(this.env)) throw remoteFailure('hr-interview/credential-shadowed', 'DEEPSEEK_API_KEY 已由启动环境变量提供且只读，请先移除该环境变量')
    try { await this.service.set(DEEPSEEK_CREDENTIAL, key) }
    catch (error) {
      if (shadowed(error)) throw remoteFailure('hr-interview/credential-shadowed', 'DEEPSEEK_API_KEY 已由启动环境变量提供且只读，请先移除该环境变量')
      throw remoteFailure('hr-interview/credential-save', `保存 API Key 失败：${String(error?.message || '未知错误').replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***').slice(0, 240)}`)
    }
    return this.describe()
  }
  async clear() {
    if (!this.service) throw remoteFailure('hr-interview/credentials-unavailable', '当前 DSH 凭据服务不可用')
    if (environmentValue(this.env)) throw remoteFailure('hr-interview/credential-shadowed', '启动环境变量只读，请在启动 DSH 的环境中修改')
    try { await this.service.unset(DEEPSEEK_CREDENTIAL) }
    catch (error) {
      if (shadowed(error)) throw remoteFailure('hr-interview/credential-shadowed', '启动环境变量只读，请在启动 DSH 的环境中修改')
      throw remoteFailure('hr-interview/credential-clear', `清除 API Key 失败：${String(error?.message || '未知错误').replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***').slice(0, 240)}`)
    }
    return this.describe()
  }
}
