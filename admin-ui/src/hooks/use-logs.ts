import { useQuery } from '@tanstack/react-query'
import { listRequestLogs } from '@/api/credentials'

/**
 * 拉取请求日志。
 *
 * @param limit 最多返回的条数（不传由后端环形缓冲上限决定）
 * @param refetchInterval 自动刷新间隔（ms），传 0 关闭
 */
export function useRequestLogs(limit = 200, refetchInterval = 5000) {
  return useQuery({
    queryKey: ['request-logs', limit],
    queryFn: () => listRequestLogs({ limit }),
    refetchInterval: refetchInterval > 0 ? refetchInterval : false,
  })
}
