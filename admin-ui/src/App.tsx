import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { storage } from '@/lib/storage'
import { LoginPage } from '@/components/login-page'
import { Layout } from '@/components/layout'
import { DashboardHome } from '@/pages/dashboard-home'
import { AccountsPage } from '@/pages/accounts-page'
import { LogsPage } from '@/pages/logs-page'
import { Toaster } from '@/components/ui/sonner'

function AuthedApp({ onLogout }: { onLogout: () => void }) {
  return (
    <BrowserRouter basename="/admin">
      <Routes>
        <Route element={<Layout onLogout={onLogout} />}>
          <Route index element={<DashboardHome />} />
          <Route path="accounts" element={<AccountsPage />} />
          <Route path="logs" element={<LogsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false)

  useEffect(() => {
    if (storage.getApiKey()) {
      setIsLoggedIn(true)
    }
  }, [])

  const handleLogin = () => setIsLoggedIn(true)

  return (
    <>
      {isLoggedIn ? (
        <AuthedAppContainer onLogout={() => setIsLoggedIn(false)} />
      ) : (
        <LoginPage onLogin={handleLogin} />
      )}
      <Toaster position="top-right" />
    </>
  )
}

// 把 logout 时清 storage + clear queryClient 收拢到这里，避免 LayoutProps 接口爆炸
function AuthedAppContainer({ onLogout }: { onLogout: () => void }) {
  const queryClient = useQueryClient()
  const handleLogout = () => {
    storage.removeApiKey()
    queryClient.clear()
    onLogout()
  }
  return <AuthedApp onLogout={handleLogout} />
}

export default App
