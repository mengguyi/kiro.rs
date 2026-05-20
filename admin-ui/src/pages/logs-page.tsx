import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { RequestLogsTab } from './request-logs-tab'
import { ConsoleLogsTab } from './console-logs-tab'

type Tab = 'requests' | 'console'

export function LogsPage() {
  const [tab, setTab] = useState<Tab>('requests')

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold">日志</h1>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={tab === 'requests' ? 'default' : 'outline'}
            onClick={() => setTab('requests')}
          >
            请求日志
          </Button>
          <Button
            size="sm"
            variant={tab === 'console' ? 'default' : 'outline'}
            onClick={() => setTab('console')}
          >
            控制台日志
          </Button>
        </div>
      </div>

      {tab === 'requests' ? <RequestLogsTab /> : <ConsoleLogsTab />}
    </div>
  )
}
