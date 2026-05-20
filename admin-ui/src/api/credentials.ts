import axios from 'axios'
import { storage } from '@/lib/storage'
import type {
  CredentialsStatusResponse,
  BalanceResponse,
  SuccessResponse,
  SetDisabledRequest,
  SetPriorityRequest,
  AddCredentialRequest,
  AddCredentialResponse,
  RequestLogEntry,
  ConsoleLogEntry,
  LoadBalancingMode,
} from '@/types/api'

// 创建 axios 实例
const api = axios.create({
  baseURL: '/api/admin',
  headers: {
    'Content-Type': 'application/json',
  },
})

// 请求拦截器添加 API Key
api.interceptors.request.use((config) => {
  const apiKey = storage.getApiKey()
  if (apiKey) {
    config.headers['x-api-key'] = apiKey
  }
  return config
})

// 获取所有凭据状态
export async function getCredentials(): Promise<CredentialsStatusResponse> {
  const { data } = await api.get<CredentialsStatusResponse>('/credentials')
  return data
}

// 设置凭据禁用状态
export async function setCredentialDisabled(
  id: number,
  disabled: boolean
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(
    `/credentials/${id}/disabled`,
    { disabled } as SetDisabledRequest
  )
  return data
}

// 设置凭据优先级
export async function setCredentialPriority(
  id: number,
  priority: number
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(
    `/credentials/${id}/priority`,
    { priority } as SetPriorityRequest
  )
  return data
}

// 重置失败计数
export async function resetCredentialFailure(
  id: number
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(`/credentials/${id}/reset`)
  return data
}

// 强制刷新 Token
export async function forceRefreshToken(
  id: number
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(`/credentials/${id}/refresh`)
  return data
}

// 获取凭据余额
export async function getCredentialBalance(id: number): Promise<BalanceResponse> {
  const { data } = await api.get<BalanceResponse>(`/credentials/${id}/balance`)
  return data
}

// 添加新凭据
export async function addCredential(
  req: AddCredentialRequest
): Promise<AddCredentialResponse> {
  const { data } = await api.post<AddCredentialResponse>('/credentials', req)
  return data
}

// 删除凭据
export async function deleteCredential(id: number): Promise<SuccessResponse> {
  const { data } = await api.delete<SuccessResponse>(`/credentials/${id}`)
  return data
}

// 获取负载均衡模式
export async function getLoadBalancingMode(): Promise<{ mode: LoadBalancingMode }> {
  const { data } = await api.get<{ mode: LoadBalancingMode }>('/config/load-balancing')
  return data
}

// 设置负载均衡模式
export async function setLoadBalancingMode(
  mode: LoadBalancingMode
): Promise<{ mode: LoadBalancingMode }> {
  const { data } = await api.put<{ mode: LoadBalancingMode }>('/config/load-balancing', { mode })
  return data
}

// 拉取请求日志（环形缓冲，倒序，最新在前）
export async function listRequestLogs(params?: {
  limit?: number
  since?: number
}): Promise<RequestLogEntry[]> {
  const { data } = await api.get<RequestLogEntry[]>('/requests', { params })
  return data
}

// 拉取控制台日志历史快照（倒序，最新在前）
export async function listConsoleRecent(limit = 300): Promise<ConsoleLogEntry[]> {
  const { data } = await api.get<ConsoleLogEntry[]>('/console-recent', {
    params: { limit },
  })
  return data
}

// 清空请求日志环形缓冲（后端层面，不影响新进来的请求）
export async function clearRequestLogs(): Promise<SuccessResponse> {
  const { data } = await api.delete<SuccessResponse>('/requests')
  return data
}

// 清空控制台日志环形缓冲（不影响已建立的 SSE 流）
export async function clearConsoleLogs(): Promise<SuccessResponse> {
  const { data } = await api.delete<SuccessResponse>('/console-recent')
  return data
}

/**
 * SSE 订阅控制台日志。fetch+ReadableStream 实现而非 EventSource，
 * 因为 EventSource 不支持自定义 header（要带 x-api-key 鉴权）。
 *
 * 调用方传 AbortSignal 控制断开。每条事件解析后回调 onEntry。
 */
export async function streamConsoleLogs(opts: {
  onEntry: (entry: ConsoleLogEntry) => void
  onOpen?: () => void
  signal: AbortSignal
}): Promise<void> {
  const apiKey = storage.getApiKey()
  if (!apiKey) throw new Error('未登录')
  const res = await fetch('/api/admin/console-stream', {
    headers: {
      'x-api-key': apiKey,
      Accept: 'text/event-stream',
    },
    signal: opts.signal,
  })
  if (!res.ok || !res.body) {
    throw new Error(`SSE 连接失败: HTTP ${res.status}`)
  }
  opts.onOpen?.()

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        try {
          const entry = JSON.parse(data) as ConsoleLogEntry
          opts.onEntry(entry)
        } catch {
          // 忽略解析失败（比如 axum 偶尔发的 keep-alive comment）
        }
      }
    }
  }
}
