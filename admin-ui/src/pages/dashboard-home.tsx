import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, KeyRound, Pause, Activity, Clock } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useCredentials } from '@/hooks/use-credentials'

function formatDistance(iso: string | null | undefined): string {
  if (!iso) return '无'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '无'
  const diff = Math.floor((Date.now() - t) / 1000)
  if (diff < 60) return `${diff} 秒前`
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return `${Math.floor(diff / 86400)} 天前`
}

export function DashboardHome() {
  const { data, isLoading, error } = useCredentials()

  const aggregates = useMemo(() => {
    const creds = data?.credentials ?? []
    const disabled = creds.filter((c) => c.disabled).length
    const failed = creds.filter((c) => c.failureCount > 0 && !c.disabled).length
    const totalSuccess = creds.reduce((s, c) => s + (c.successCount || 0), 0)
    const totalFailure = creds.reduce((s, c) => s + (c.failureCount || 0), 0)
    const lastUsed = creds.reduce<string | null>((latest, c) => {
      if (!c.lastUsedAt) return latest
      if (!latest) return c.lastUsedAt
      return new Date(c.lastUsedAt) > new Date(latest) ? c.lastUsedAt : latest
    }, null)
    return { disabled, failed, totalSuccess, totalFailure, lastUsed }
  }, [data])

  if (isLoading) {
    return <div className="text-center text-muted-foreground py-12">加载中...</div>
  }
  if (error) {
    return (
      <div className="text-center text-destructive py-12">
        加载失败：{(error as Error).message}
      </div>
    )
  }

  const total = data?.total ?? 0
  const available = data?.available ?? 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">
          凭据池概览 — 详细管理请到{' '}
          <Link to="/accounts" className="underline">
            账户页
          </Link>{' '}
          或{' '}
          <Link to="/logs" className="underline">
            日志页
          </Link>
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <KeyRound className="h-4 w-4" />
              凭据总数
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{total}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              可用凭据
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{available}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {total > 0 ? `${Math.round((available / total) * 100)}% 可用` : '—'}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Activity className="h-4 w-4" />
              当前活跃
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold flex items-center gap-2">
              #{data?.currentId ?? '-'}
              <Badge variant="success">活跃</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Pause className="h-4 w-4" />
              已禁用
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{aggregates.disabled}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              有失败计数
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{aggregates.failed}</div>
            <div className="text-xs text-muted-foreground mt-1">
              累计失败 {aggregates.totalFailure} 次
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Clock className="h-4 w-4" />
              最近调用
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatDistance(aggregates.lastUsed)}</div>
            <div className="text-xs text-muted-foreground mt-1">
              累计成功 {aggregates.totalSuccess.toLocaleString()} 次
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex gap-2">
        <Button asChild variant="outline">
          <Link to="/accounts">→ 进入账户管理</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/logs">→ 查看请求日志</Link>
        </Button>
      </div>
    </div>
  )
}
