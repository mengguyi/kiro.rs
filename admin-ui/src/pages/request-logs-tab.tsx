import { useMemo, useState } from 'react'
import { Pause, Play, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { useRequestLogs } from '@/hooks/use-logs'

const PATH_FILTERS: { label: string; value: string }[] = [
  { label: '全部', value: '' },
  { label: '/v1/messages', value: '/v1/messages' },
  { label: '/cc/v1/messages', value: '/cc/v1/messages' },
  { label: '/v1/models', value: '/v1/models' },
  { label: 'count_tokens', value: 'count_tokens' },
]

const STATUS_FILTERS: { label: string; value: string }[] = [
  { label: '全部', value: '' },
  { label: '2xx', value: '2' },
  { label: '4xx', value: '4' },
  { label: '5xx', value: '5' },
]

function statusBadgeVariant(status: number): 'success' | 'destructive' | 'secondary' | 'default' {
  if (status >= 500) return 'destructive'
  if (status >= 400) return 'secondary'
  if (status >= 200 && status < 300) return 'success'
  return 'default'
}

function formatTime(timeMs: number): string {
  const d = new Date(timeMs)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${d
    .getMilliseconds()
    .toString()
    .padStart(3, '0')}`
}

function formatDate(timeMs: number): string {
  const d = new Date(timeMs)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatTime(timeMs)}`
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function RequestLogsTab() {
  const [pathFilter, setPathFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [reqIdSearch, setReqIdSearch] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)

  const { data, isLoading, error, refetch, dataUpdatedAt } = useRequestLogs(
    500,
    autoRefresh ? 5000 : 0
  )

  const filtered = useMemo(() => {
    const entries = data ?? []
    return entries.filter((e) => {
      if (pathFilter && !e.path.includes(pathFilter)) return false
      if (statusFilter && !e.status.toString().startsWith(statusFilter)) return false
      if (reqIdSearch && !e.reqId.includes(reqIdSearch.trim())) return false
      return true
    })
  }, [data, pathFilter, statusFilter, reqIdSearch])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-muted-foreground">
          最近 500 条业务请求（环形缓冲、内存级、重启清零）
          {dataUpdatedAt > 0 && ` · 上次拉取 ${formatTime(dataUpdatedAt)}`}
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAutoRefresh((v) => !v)}
            title={autoRefresh ? '暂停 5s 自动刷新' : '开启 5s 自动刷新'}
          >
            {autoRefresh ? (
              <>
                <Pause className="h-4 w-4 mr-2" />
                暂停
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-2" />
                继续
              </>
            )}
          </Button>
          <Button size="sm" variant="outline" onClick={() => refetch()} title="立即刷新">
            <RefreshCw className="h-4 w-4 mr-2" />
            刷新
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-4 items-center">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">路径：</span>
          <div className="flex gap-1">
            {PATH_FILTERS.map((f) => (
              <Button
                key={f.value || 'all-path'}
                size="sm"
                variant={pathFilter === f.value ? 'default' : 'outline'}
                onClick={() => setPathFilter(f.value)}
              >
                {f.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">状态：</span>
          <div className="flex gap-1">
            {STATUS_FILTERS.map((f) => (
              <Button
                key={f.value || 'all-status'}
                size="sm"
                variant={statusFilter === f.value ? 'default' : 'outline'}
                onClick={() => setStatusFilter(f.value)}
              >
                {f.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Req ID：</span>
          <Input
            value={reqIdSearch}
            onChange={(e) => setReqIdSearch(e.target.value)}
            placeholder="搜索片段"
            className="h-9 w-40"
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="py-12 text-center text-muted-foreground">加载中...</div>
          ) : error ? (
            <div className="py-12 text-center text-destructive">
              加载失败：{(error as Error).message}
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              {data && data.length > 0
                ? '当前过滤条件下没有日志'
                : '暂无请求日志（试着发一次 /v1/messages）'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 border-b">
                  <tr className="text-left">
                    <th className="px-4 py-2 font-medium text-muted-foreground">时间</th>
                    <th className="px-4 py-2 font-medium text-muted-foreground">方法</th>
                    <th className="px-4 py-2 font-medium text-muted-foreground">路径</th>
                    <th className="px-4 py-2 font-medium text-muted-foreground">状态</th>
                    <th className="px-4 py-2 font-medium text-muted-foreground">耗时</th>
                    <th className="px-4 py-2 font-medium text-muted-foreground">Req ID</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((entry, idx) => (
                    <tr
                      key={`${entry.timeMs}-${entry.reqId}-${idx}`}
                      className="border-b last:border-b-0 hover:bg-muted/30"
                    >
                      <td
                        className="px-4 py-2 font-mono text-xs whitespace-nowrap"
                        title={formatDate(entry.timeMs)}
                      >
                        {formatTime(entry.timeMs)}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">{entry.method}</td>
                      <td className="px-4 py-2 font-mono text-xs">{entry.path}</td>
                      <td className="px-4 py-2">
                        <Badge variant={statusBadgeVariant(entry.status)}>{entry.status}</Badge>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">
                        {formatLatency(entry.latencyMs)}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                        {entry.reqId}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {data && data.length > 0 && (
        <p className="text-xs text-muted-foreground">
          显示 {filtered.length} / {data.length} 条
        </p>
      )}
    </div>
  )
}
