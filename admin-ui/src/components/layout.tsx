import { useState } from 'react'
import { Outlet, NavLink } from 'react-router-dom'
import {
  RefreshCw,
  LogOut,
  Moon,
  Sun,
  Server,
  LayoutDashboard,
  Users,
  ScrollText,
  ChevronDown,
  Check,
} from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useLoadBalancingMode, useSetLoadBalancingMode } from '@/hooks/use-credentials'
import { extractErrorMessage } from '@/lib/utils'
import type { LoadBalancingMode } from '@/types/api'

const MODE_LABELS: Record<LoadBalancingMode, string> = {
  priority: '优先级模式',
  balanced: '均衡负载',
  per_credential: '渠道独立 (new-api)',
}

const MODE_DESCRIPTIONS: Record<LoadBalancingMode, string> = {
  priority: '按 priority 字段挑号，固定使用当前号直到失败',
  balanced: '按调用成功数做内部负载均衡，每次请求重新选号',
  per_credential: 'API key 必须带 -{id} 后缀；裸 base_key 直接 401。由外部 (new-api) 做渠道调度',
}

interface LayoutProps {
  onLogout: () => void
}

export function Layout({ onLogout }: LayoutProps) {
  const queryClient = useQueryClient()
  const { data: loadBalancingData, isLoading: isLoadingMode } = useLoadBalancingMode()
  const { mutate: setLoadBalancingMode, isPending: isSettingMode } = useSetLoadBalancingMode()

  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return document.documentElement.classList.contains('dark')
    }
    return false
  })

  const toggleDarkMode = () => {
    setDarkMode(!darkMode)
    document.documentElement.classList.toggle('dark')
  }

  const handleRefreshAll = () => {
    queryClient.invalidateQueries()
    toast.success('已刷新所有数据')
  }

  const currentMode: LoadBalancingMode = loadBalancingData?.mode || 'priority'

  const handleSelectMode = (newMode: LoadBalancingMode) => {
    if (newMode === currentMode) return
    setLoadBalancingMode(newMode, {
      onSuccess: () => {
        toast.success(`已切换到${MODE_LABELS[newMode]}`)
      },
      onError: (error) => {
        toast.error(`切换失败: ${extractErrorMessage(error)}`)
      },
    })
  }

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
      isActive
        ? 'bg-primary text-primary-foreground'
        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
    }`

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center justify-between px-4 md:px-8">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              <span className="font-semibold">Kiro Admin</span>
            </div>
            <nav className="flex items-center gap-1">
              <NavLink to="/" end className={navLinkClass}>
                <LayoutDashboard className="h-4 w-4" />
                <span className="hidden sm:inline">Dashboard</span>
              </NavLink>
              <NavLink to="/accounts" className={navLinkClass}>
                <Users className="h-4 w-4" />
                <span className="hidden sm:inline">账户</span>
              </NavLink>
              <NavLink to="/logs" className={navLinkClass}>
                <ScrollText className="h-4 w-4" />
                <span className="hidden sm:inline">日志</span>
              </NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isLoadingMode || isSettingMode}
                  title="切换负载均衡模式"
                >
                  {isLoadingMode ? '加载中...' : MODE_LABELS[currentMode]}
                  <ChevronDown className="h-4 w-4 ml-1.5 opacity-60" />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={4}
                  className="z-50 min-w-[280px] rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
                >
                  {(['priority', 'balanced', 'per_credential'] as LoadBalancingMode[]).map(
                    (mode) => (
                      <DropdownMenu.Item
                        key={mode}
                        onSelect={() => handleSelectMode(mode)}
                        className="flex items-start gap-2 px-3 py-2 text-sm rounded-sm outline-none cursor-pointer hover:bg-accent hover:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                      >
                        <div className="w-4 mt-0.5">
                          {mode === currentMode && <Check className="h-4 w-4 text-primary" />}
                        </div>
                        <div className="flex-1">
                          <div className="font-medium">{MODE_LABELS[mode]}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {MODE_DESCRIPTIONS[mode]}
                          </div>
                        </div>
                      </DropdownMenu.Item>
                    )
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleDarkMode}
              title={darkMode ? '切换到亮色' : '切换到暗色'}
              aria-label="切换暗色模式"
            >
              {darkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleRefreshAll}
              title="刷新所有数据"
              aria-label="刷新所有数据"
            >
              <RefreshCw className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onLogout}
              title="登出"
              aria-label="登出"
            >
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 md:px-8 py-6">
        <Outlet />
      </main>
    </div>
  )
}
