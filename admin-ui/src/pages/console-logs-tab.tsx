import { useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  clearConsoleLogs,
  listConsoleRecent,
  streamConsoleLogs,
} from '@/api/credentials'
import { extractErrorMessage } from '@/lib/utils'
import type { ConsoleLogEntry } from '@/types/api'

const LEVEL_FILTERS: { label: string; value: string }[] = [
  { label: '全部', value: '' },
  { label: 'ERROR', value: 'ERROR' },
  { label: 'WARN', value: 'WARN' },
  { label: 'INFO', value: 'INFO' },
  { label: 'DEBUG', value: 'DEBUG' },
]

const BUFFER_SIZE = 2000

function levelClass(level: string): string {
  switch (level) {
    case 'ERROR':
      return 'text-red-500'
    case 'WARN':
      return 'text-amber-500'
    case 'INFO':
      return 'text-green-500'
    case 'DEBUG':
      return 'text-blue-400'
    case 'TRACE':
      return 'text-purple-400'
    default:
      return 'text-muted-foreground'
  }
}

function formatTime(timeMs: number): string {
  const d = new Date(timeMs)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${d
    .getMilliseconds()
    .toString()
    .padStart(3, '0')}`
}

export function ConsoleLogsTab() {
  const [entries, setEntries] = useState<ConsoleLogEntry[]>([])
  const [paused, setPaused] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [connected, setConnected] = useState(false)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [levelFilter, setLevelFilter] = useState('')
  const [search, setSearch] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  // 拉历史 + 订阅 SSE
  useEffect(() => {
    if (paused) return
    let cancelled = false
    const controller = new AbortController()

    listConsoleRecent(300)
      .then((history) => {
        if (cancelled) return
        // 后端返回倒序（最新在前），UI 显示正序（最早在上、最新在下，方便像终端那样追加）
        setEntries(history.slice().reverse())
      })
      .catch(() => {
        // 历史拉不到就忽略，等 SSE 直接推
      })

    streamConsoleLogs({
      onEntry: (entry) => {
        if (cancelled) return
        setEntries((prev) => {
          if (prev.length === 0) return [entry]
          // SSE 推流可能在历史之前到达，做个去重保护：
          // 用 (timeMs+target+message) 作为粗糙 dedupe key
          const last = prev[prev.length - 1]
          if (
            last.timeMs === entry.timeMs &&
            last.target === entry.target &&
            last.message === entry.message
          ) {
            return prev
          }
          const next = prev.length >= BUFFER_SIZE ? prev.slice(prev.length - BUFFER_SIZE + 1) : prev
          return [...next, entry]
        })
      },
      onOpen: () => {
        if (!cancelled) {
          setConnected(true)
          setStreamError(null)
        }
      },
      signal: controller.signal,
    })
      .then(() => setConnected(false))
      .catch((e: unknown) => {
        if ((e as Error)?.name === 'AbortError') return
        if (!cancelled) {
          setConnected(false)
          setStreamError(extractErrorMessage(e))
        }
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [paused])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter((e) => {
      if (levelFilter && e.level !== levelFilter) return false
      if (q) {
        const hay = `${e.target} ${e.message}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [entries, levelFilter, search])

  // auto-scroll 到底
  useEffect(() => {
    if (!autoScroll) return
    bottomRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior, block: 'end' })
  }, [filtered, autoScroll])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-muted-foreground">
          实时 SSE 流式（tracing 输出镜像、内存级、容量 {BUFFER_SIZE}、重启清零）
          {connected && <span className="ml-2 text-green-600">● 已连接</span>}
          {!connected && !paused && <span className="ml-2 text-amber-600">● 断开</span>}
          {paused && <span className="ml-2 text-muted-foreground">● 已暂停</span>}
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPaused((v) => !v)}
            title={paused ? '恢复 SSE 流' : '断开 SSE 流（不再接收新日志）'}
          >
            {paused ? <Play className="h-4 w-4 mr-2" /> : <Pause className="h-4 w-4 mr-2" />}
            {paused ? '恢复' : '暂停'}
          </Button>
          <Button
            size="sm"
            variant={autoScroll ? 'outline' : 'default'}
            onClick={() => setAutoScroll((v) => !v)}
            title="新日志到达时是否自动滚到底部"
          >
            自动滚动：{autoScroll ? '开' : '关'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEntries([])}
            title="只清空前端缓冲，不影响后端 ring buffer"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            清屏
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              if (!confirm('清空后端控制台日志缓冲？已建立的 SSE 流继续推新事件，不受影响。')) return
              try {
                await clearConsoleLogs()
                setEntries([])
                toast.success('控制台日志已清空')
              } catch (e) {
                toast.error(`清空失败：${extractErrorMessage(e)}`)
              }
            }}
            title="同时清空后端 ring buffer 和前端缓冲"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            清空缓冲
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-4 items-center">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">级别：</span>
          <div className="flex gap-1">
            {LEVEL_FILTERS.map((f) => (
              <Button
                key={f.value || 'all-level'}
                size="sm"
                variant={levelFilter === f.value ? 'default' : 'outline'}
                onClick={() => setLevelFilter(f.value)}
              >
                {f.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <span className="text-sm text-muted-foreground">搜索：</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="target / message 子串"
            className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
      </div>

      {streamError && (
        <div className="text-sm text-destructive">SSE 连接错误：{streamError}</div>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="bg-zinc-950 text-zinc-100 font-mono text-xs overflow-y-auto max-h-[60vh] p-3 leading-relaxed">
            {filtered.length === 0 ? (
              <div className="py-8 text-center text-zinc-500">
                {entries.length === 0
                  ? connected
                    ? '已连接，等待日志...'
                    : '暂无日志'
                  : '当前过滤条件下没有日志'}
              </div>
            ) : (
              filtered.map((entry, idx) => (
                <div key={`${entry.timeMs}-${idx}`} className="whitespace-pre-wrap break-words">
                  <span className="text-zinc-500">{formatTime(entry.timeMs)}</span>{' '}
                  <span className={`font-semibold ${levelClass(entry.level)}`}>
                    {entry.level.padEnd(5)}
                  </span>{' '}
                  <span className="text-zinc-400">{entry.target}</span>{' '}
                  <span>{entry.message}</span>
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </CardContent>
      </Card>

      {entries.length > 0 && (
        <p className="text-xs text-muted-foreground">
          显示 {filtered.length} / {entries.length} 条
        </p>
      )}
    </div>
  )
}
