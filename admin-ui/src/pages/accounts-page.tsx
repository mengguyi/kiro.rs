import { useState, useEffect, useRef } from 'react'
import {
  RefreshCw,
  Plus,
  Upload,
  FileUp,
  Trash2,
  RotateCcw,
  CheckCircle2,
  ChevronDown,
  X,
} from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CredentialCard } from '@/components/credential-card'
import { BalanceDialog } from '@/components/balance-dialog'
import { AddCredentialDialog } from '@/components/add-credential-dialog'
import { BatchImportDialog } from '@/components/batch-import-dialog'
import { KamImportDialog } from '@/components/kam-import-dialog'
import { BatchVerifyDialog, type VerifyResult } from '@/components/batch-verify-dialog'
import {
  useCredentials,
  useDeleteCredential,
  useResetFailure,
} from '@/hooks/use-credentials'
import { getCredentialBalance, forceRefreshToken } from '@/api/credentials'
import { extractErrorMessage } from '@/lib/utils'
import type { BalanceResponse } from '@/types/api'

// 节流的"刷新全部余额"并发上限。Kiro 上游会算"短时间高频请求"为风控，所以保守一点。
const REFRESH_ALL_CONCURRENCY = 3

export function AccountsPage() {
  const [selectedCredentialId, setSelectedCredentialId] = useState<number | null>(null)
  const [balanceDialogOpen, setBalanceDialogOpen] = useState(false)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [batchImportDialogOpen, setBatchImportDialogOpen] = useState(false)
  const [kamImportDialogOpen, setKamImportDialogOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [verifyDialogOpen, setVerifyDialogOpen] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyProgress, setVerifyProgress] = useState({ current: 0, total: 0 })
  const [verifyResults, setVerifyResults] = useState<Map<number, VerifyResult>>(new Map())
  const [balanceMap, setBalanceMap] = useState<Map<number, BalanceResponse>>(new Map())
  const [loadingBalanceIds, setLoadingBalanceIds] = useState<Set<number>>(new Set())
  const [queryingInfo, setQueryingInfo] = useState(false)
  const [queryInfoProgress, setQueryInfoProgress] = useState({ current: 0, total: 0 })
  const [queryAllInfo, setQueryAllInfo] = useState(false)
  const [queryAllProgress, setQueryAllProgress] = useState({ current: 0, total: 0 })
  const [batchRefreshing, setBatchRefreshing] = useState(false)
  const [batchRefreshProgress, setBatchRefreshProgress] = useState({ current: 0, total: 0 })
  const cancelVerifyRef = useRef(false)
  // 余额刷新统一 cancel ref（"本页" 和 "全部" 共用，由 fetchBalancesSequentially 内部检查）
  const cancelBalanceRef = useRef(false)
  const [currentPage, setCurrentPage] = useState(1)
  const itemsPerPage = 12

  const queryClient = useQueryClient()
  const { data, isLoading, error, refetch } = useCredentials()
  const { mutate: deleteCredential } = useDeleteCredential()
  const { mutate: resetFailure } = useResetFailure()

  const totalPages = Math.ceil((data?.credentials.length || 0) / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = startIndex + itemsPerPage
  const currentCredentials = data?.credentials.slice(startIndex, endIndex) || []
  const disabledCredentialCount = data?.credentials.filter((c) => c.disabled).length || 0
  const selectedDisabledCount = Array.from(selectedIds).filter((id) => {
    const credential = data?.credentials.find((c) => c.id === id)
    return Boolean(credential?.disabled)
  }).length

  useEffect(() => {
    setCurrentPage(1)
  }, [data?.credentials.length])

  // 删除/隐藏的凭据自动清理 balance 缓存
  useEffect(() => {
    if (!data?.credentials) {
      setBalanceMap(new Map())
      setLoadingBalanceIds(new Set())
      return
    }
    const validIds = new Set(data.credentials.map((c) => c.id))
    setBalanceMap((prev) => {
      const next = new Map<number, BalanceResponse>()
      prev.forEach((v, id) => {
        if (validIds.has(id)) next.set(id, v)
      })
      return next.size === prev.size ? prev : next
    })
    setLoadingBalanceIds((prev) => {
      if (prev.size === 0) return prev
      const next = new Set<number>()
      prev.forEach((id) => {
        if (validIds.has(id)) next.add(id)
      })
      return next.size === prev.size ? prev : next
    })
  }, [data?.credentials])

  const handleViewBalance = (id: number) => {
    setSelectedCredentialId(id)
    setBalanceDialogOpen(true)
  }

  const handleRefresh = () => {
    refetch()
    toast.success('已刷新凭据列表')
  }

  const toggleSelect = (id: number) => {
    const newSelected = new Set(selectedIds)
    if (newSelected.has(id)) newSelected.delete(id)
    else newSelected.add(id)
    setSelectedIds(newSelected)
  }

  const deselectAll = () => setSelectedIds(new Set())

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) {
      toast.error('请先选择要删除的凭据')
      return
    }
    const disabledIds = Array.from(selectedIds).filter((id) => {
      const credential = data?.credentials.find((c) => c.id === id)
      return Boolean(credential?.disabled)
    })
    if (disabledIds.length === 0) {
      toast.error('选中的凭据中没有已禁用项')
      return
    }
    const skippedCount = selectedIds.size - disabledIds.length
    const skippedText = skippedCount > 0 ? `（将跳过 ${skippedCount} 个未禁用凭据）` : ''
    if (!confirm(`确定要删除 ${disabledIds.length} 个已禁用凭据吗？此操作无法撤销。${skippedText}`)) return

    let successCount = 0
    let failCount = 0
    for (const id of disabledIds) {
      try {
        await new Promise<void>((resolve, reject) => {
          deleteCredential(id, {
            onSuccess: () => {
              successCount++
              resolve()
            },
            onError: (err) => {
              failCount++
              reject(err)
            },
          })
        })
      } catch {
        /* handled in onError */
      }
    }
    const skippedResultText = skippedCount > 0 ? `，已跳过 ${skippedCount} 个未禁用凭据` : ''
    if (failCount === 0) {
      toast.success(`成功删除 ${successCount} 个已禁用凭据${skippedResultText}`)
    } else {
      toast.warning(`删除已禁用凭据：成功 ${successCount} 个，失败 ${failCount} 个${skippedResultText}`)
    }
    deselectAll()
  }

  const handleBatchResetFailure = async () => {
    if (selectedIds.size === 0) {
      toast.error('请先选择要恢复的凭据')
      return
    }
    const failedIds = Array.from(selectedIds).filter((id) => {
      const cred = data?.credentials.find((c) => c.id === id)
      return cred && cred.failureCount > 0
    })
    if (failedIds.length === 0) {
      toast.error('选中的凭据中没有失败的凭据')
      return
    }
    let successCount = 0
    let failCount = 0
    for (const id of failedIds) {
      try {
        await new Promise<void>((resolve, reject) => {
          resetFailure(id, {
            onSuccess: () => {
              successCount++
              resolve()
            },
            onError: (err) => {
              failCount++
              reject(err)
            },
          })
        })
      } catch {
        /* handled in onError */
      }
    }
    if (failCount === 0) toast.success(`成功恢复 ${successCount} 个凭据`)
    else toast.warning(`成功 ${successCount} 个，失败 ${failCount} 个`)
    deselectAll()
  }

  const handleBatchForceRefresh = async () => {
    if (selectedIds.size === 0) {
      toast.error('请先选择要刷新的凭据')
      return
    }
    const enabledIds = Array.from(selectedIds).filter((id) => {
      const cred = data?.credentials.find((c) => c.id === id)
      return cred && !cred.disabled
    })
    if (enabledIds.length === 0) {
      toast.error('选中的凭据中没有启用的凭据')
      return
    }
    setBatchRefreshing(true)
    setBatchRefreshProgress({ current: 0, total: enabledIds.length })
    let successCount = 0
    let failCount = 0
    for (let i = 0; i < enabledIds.length; i++) {
      try {
        await forceRefreshToken(enabledIds[i])
        successCount++
      } catch {
        failCount++
      }
      setBatchRefreshProgress({ current: i + 1, total: enabledIds.length })
    }
    setBatchRefreshing(false)
    queryClient.invalidateQueries({ queryKey: ['credentials'] })
    if (failCount === 0) toast.success(`成功刷新 ${successCount} 个凭据的 Token`)
    else toast.warning(`刷新 Token：成功 ${successCount} 个，失败 ${failCount} 个`)
    deselectAll()
  }

  const handleClearAll = async () => {
    if (!data?.credentials || data.credentials.length === 0) {
      toast.error('没有可清除的凭据')
      return
    }
    const disabledCredentials = data.credentials.filter((c) => c.disabled)
    if (disabledCredentials.length === 0) {
      toast.error('没有可清除的已禁用凭据')
      return
    }
    if (!confirm(`确定要清除所有 ${disabledCredentials.length} 个已禁用凭据吗？此操作无法撤销。`)) return

    let successCount = 0
    let failCount = 0
    for (const credential of disabledCredentials) {
      try {
        await new Promise<void>((resolve, reject) => {
          deleteCredential(credential.id, {
            onSuccess: () => {
              successCount++
              resolve()
            },
            onError: (err) => {
              failCount++
              reject(err)
            },
          })
        })
      } catch {
        /* handled in onError */
      }
    }
    if (failCount === 0) toast.success(`成功清除所有 ${successCount} 个已禁用凭据`)
    else toast.warning(`清除已禁用凭据：成功 ${successCount} 个，失败 ${failCount} 个`)
    deselectAll()
  }

  // 拉一批 balance（用于"刷新本页"和"刷新全部"两条路径复用）
  // 串行单次只发一个请求，避免上游 IP 风控
  const fetchBalancesSequentially = async (
    ids: number[],
    onProgress: (current: number, total: number) => void
  ) => {
    let success = 0
    let fail = 0
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      setLoadingBalanceIds((prev) => {
        const next = new Set(prev)
        next.add(id)
        return next
      })
      try {
        const balance = await getCredentialBalance(id)
        success++
        setBalanceMap((prev) => {
          const next = new Map(prev)
          next.set(id, balance)
          return next
        })
      } catch {
        fail++
      } finally {
        setLoadingBalanceIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
      onProgress(i + 1, ids.length)
      if (cancelBalanceRef.current) break
    }
    return { success, fail }
  }

  // 刷新本页（已启用凭据的）余额
  const handleQueryCurrentPageBalance = async () => {
    if (currentCredentials.length === 0) {
      toast.error('当前页没有可查询的凭据')
      return
    }
    const ids = currentCredentials.filter((c) => !c.disabled).map((c) => c.id)
    if (ids.length === 0) {
      toast.error('当前页没有可查询的启用凭据')
      return
    }
    cancelBalanceRef.current = false
    setQueryingInfo(true)
    setQueryInfoProgress({ current: 0, total: ids.length })
    const { success, fail } = await fetchBalancesSequentially(ids, (cur, total) =>
      setQueryInfoProgress({ current: cur, total })
    )
    setQueryingInfo(false)
    if (cancelBalanceRef.current) {
      toast.info(`已取消，本次完成 ${success}/${ids.length}`)
    } else if (fail === 0) {
      toast.success(`本页余额刷新完成：成功 ${success}/${ids.length}`)
    } else {
      toast.warning(`本页余额刷新：成功 ${success} 个，失败 ${fail} 个`)
    }
  }

  // 刷新全部（已启用凭据的）余额
  const handleQueryAllBalance = async () => {
    const ids = (data?.credentials ?? []).filter((c) => !c.disabled).map((c) => c.id)
    if (ids.length === 0) {
      toast.error('没有可查询的启用凭据')
      return
    }
    if (
      ids.length > 30 &&
      !confirm(`将逐条查询 ${ids.length} 个凭据的余额，估计耗时 ${Math.ceil(ids.length * 0.8)} 秒。继续？`)
    )
      return
    cancelBalanceRef.current = false
    setQueryAllInfo(true)
    setQueryAllProgress({ current: 0, total: ids.length })
    const { success, fail } = await fetchBalancesSequentially(ids, (cur, total) =>
      setQueryAllProgress({ current: cur, total })
    )
    setQueryAllInfo(false)
    if (cancelBalanceRef.current) {
      toast.info(`已取消，本次完成 ${success}/${ids.length}`)
    } else if (fail === 0) {
      toast.success(`全部余额刷新完成：成功 ${success}/${ids.length}`)
    } else {
      toast.warning(`全部余额刷新：成功 ${success} 个，失败 ${fail} 个`)
    }
  }

  const handleCancelBalance = () => {
    cancelBalanceRef.current = true
  }

  const refreshingBalance = queryingInfo || queryAllInfo
  const refreshingLabel = queryAllInfo
    ? `${queryAllProgress.current}/${queryAllProgress.total}`
    : `${queryInfoProgress.current}/${queryInfoProgress.total}`
  const currentPageEnabledCount = currentCredentials.filter((c) => !c.disabled).length
  const allEnabledCount = (data?.credentials ?? []).filter((c) => !c.disabled).length

  const handleBatchVerify = async () => {
    if (selectedIds.size === 0) {
      toast.error('请先选择要验活的凭据')
      return
    }
    setVerifying(true)
    cancelVerifyRef.current = false
    const ids = Array.from(selectedIds)
    setVerifyProgress({ current: 0, total: ids.length })
    let successCount = 0
    const initialResults = new Map<number, VerifyResult>()
    ids.forEach((id) => initialResults.set(id, { id, status: 'pending' }))
    setVerifyResults(initialResults)
    setVerifyDialogOpen(true)

    for (let i = 0; i < ids.length; i++) {
      if (cancelVerifyRef.current) {
        toast.info('已取消验活')
        break
      }
      const id = ids[i]
      setVerifyResults((prev) => {
        const newResults = new Map(prev)
        newResults.set(id, { id, status: 'verifying' })
        return newResults
      })
      try {
        const balance = await getCredentialBalance(id)
        successCount++
        setVerifyResults((prev) => {
          const newResults = new Map(prev)
          newResults.set(id, {
            id,
            status: 'success',
            usage: `${balance.currentUsage}/${balance.usageLimit}`,
          })
          return newResults
        })
      } catch (error) {
        setVerifyResults((prev) => {
          const newResults = new Map(prev)
          newResults.set(id, {
            id,
            status: 'failed',
            error: extractErrorMessage(error),
          })
          return newResults
        })
      }
      setVerifyProgress({ current: i + 1, total: ids.length })
      if (i < ids.length - 1 && !cancelVerifyRef.current) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
    setVerifying(false)
    if (!cancelVerifyRef.current) toast.success(`验活完成：成功 ${successCount}/${ids.length}`)
  }

  const handleCancelVerify = () => {
    cancelVerifyRef.current = true
    setVerifying(false)
  }

  // refs intentionally kept (currently unused but reserved for future throttle tweak)
  void REFRESH_ALL_CONCURRENCY

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold">账户管理</h1>
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2">
              <Badge variant="secondary">已选择 {selectedIds.size} 个</Badge>
              <Button onClick={deselectAll} size="sm" variant="ghost">
                取消选择
              </Button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {selectedIds.size > 0 && (
            <>
              <Button onClick={handleBatchVerify} size="sm" variant="outline">
                <CheckCircle2 className="h-4 w-4 mr-2" />
                批量验活
              </Button>
              <Button
                onClick={handleBatchForceRefresh}
                size="sm"
                variant="outline"
                disabled={batchRefreshing}
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${batchRefreshing ? 'animate-spin' : ''}`} />
                {batchRefreshing
                  ? `刷新中... ${batchRefreshProgress.current}/${batchRefreshProgress.total}`
                  : '批量刷新 Token'}
              </Button>
              <Button onClick={handleBatchResetFailure} size="sm" variant="outline">
                <RotateCcw className="h-4 w-4 mr-2" />
                恢复异常
              </Button>
              <Button
                onClick={handleBatchDelete}
                size="sm"
                variant="destructive"
                disabled={selectedDisabledCount === 0}
                title={selectedDisabledCount === 0 ? '只能删除已禁用凭据' : undefined}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                批量删除
              </Button>
            </>
          )}
          {verifying && !verifyDialogOpen && (
            <Button onClick={() => setVerifyDialogOpen(true)} size="sm" variant="secondary">
              <CheckCircle2 className="h-4 w-4 mr-2 animate-spin" />
              验活中... {verifyProgress.current}/{verifyProgress.total}
            </Button>
          )}
          <Button onClick={handleRefresh} size="sm" variant="outline" title="重新拉取凭据列表">
            <RefreshCw className="h-4 w-4 mr-2" />
            刷新列表
          </Button>
          {data?.credentials && data.credentials.length > 0 &&
            (refreshingBalance ? (
              <Button
                onClick={handleCancelBalance}
                size="sm"
                variant="outline"
                title="取消正在进行的余额查询"
              >
                <X className="h-4 w-4 mr-2" />
                取消查询 ({refreshingLabel})
              </Button>
            ) : (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    title="逐个查询凭据余额（调上游 getUsageLimits）"
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    刷新余额
                    <ChevronDown className="h-3.5 w-3.5 ml-1 opacity-70" />
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    sideOffset={4}
                    className="z-50 min-w-[200px] rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
                  >
                    <DropdownMenu.Item
                      onSelect={handleQueryCurrentPageBalance}
                      disabled={currentPageEnabledCount === 0}
                      className="flex justify-between items-center px-3 py-2 text-sm rounded-sm outline-none cursor-pointer hover:bg-accent hover:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                    >
                      <span>本页</span>
                      <span className="text-xs text-muted-foreground">
                        {currentPageEnabledCount} 个
                      </span>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onSelect={handleQueryAllBalance}
                      disabled={allEnabledCount === 0}
                      className="flex justify-between items-center px-3 py-2 text-sm rounded-sm outline-none cursor-pointer hover:bg-accent hover:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                    >
                      <span>全部</span>
                      <span className="text-xs text-muted-foreground">
                        {allEnabledCount} 个
                      </span>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            ))}
          {data?.credentials && data.credentials.length > 0 && (
            <Button
              onClick={handleClearAll}
              size="sm"
              variant="outline"
              className="text-destructive hover:text-destructive"
              disabled={disabledCredentialCount === 0}
              title={disabledCredentialCount === 0 ? '没有可清除的已禁用凭据' : undefined}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              清除已禁用
            </Button>
          )}
          <Button onClick={() => setKamImportDialogOpen(true)} size="sm" variant="outline">
            <FileUp className="h-4 w-4 mr-2" />
            KAM 导入
          </Button>
          <Button onClick={() => setBatchImportDialogOpen(true)} size="sm" variant="outline">
            <Upload className="h-4 w-4 mr-2" />
            批量导入
          </Button>
          <Button onClick={() => setAddDialogOpen(true)} size="sm">
            <Plus className="h-4 w-4 mr-2" />
            添加凭据
          </Button>
        </div>
      </div>

      {data?.credentials.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            暂无凭据
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {currentCredentials.map((credential) => (
              <CredentialCard
                key={credential.id}
                credential={credential}
                onViewBalance={handleViewBalance}
                selected={selectedIds.has(credential.id)}
                onToggleSelect={() => toggleSelect(credential.id)}
                balance={balanceMap.get(credential.id) || null}
                loadingBalance={loadingBalanceIds.has(credential.id)}
              />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex justify-center items-center gap-4 mt-6">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                上一页
              </Button>
              <span className="text-sm text-muted-foreground">
                第 {currentPage} / {totalPages} 页（共 {data?.credentials.length} 个凭据）
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
              >
                下一页
              </Button>
            </div>
          )}
        </>
      )}

      <BalanceDialog
        credentialId={selectedCredentialId}
        open={balanceDialogOpen}
        onOpenChange={setBalanceDialogOpen}
      />
      <AddCredentialDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />
      <BatchImportDialog open={batchImportDialogOpen} onOpenChange={setBatchImportDialogOpen} />
      <KamImportDialog open={kamImportDialogOpen} onOpenChange={setKamImportDialogOpen} />
      <BatchVerifyDialog
        open={verifyDialogOpen}
        onOpenChange={setVerifyDialogOpen}
        verifying={verifying}
        progress={verifyProgress}
        results={verifyResults}
        onCancel={handleCancelVerify}
      />
    </div>
  )
}
