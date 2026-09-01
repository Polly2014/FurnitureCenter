import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { Armchair, ArrowRight, KeyRound, ShieldCheck } from 'lucide-react'
import { getAuthSession, login, logout } from '../../api'
import type { AuthSession } from '../../types'

type AuthGateContext = {
  session: AuthSession
  logout: () => Promise<void>
}

type AuthGateProps = {
  children: (context: AuthGateContext) => ReactNode
}

export function AuthGate({ children }: AuthGateProps) {
  const [checking, setChecking] = useState(true)
  const [session, setSession] = useState<AuthSession>()
  const [error, setError] = useState<string>()
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let active = true
    getAuthSession()
      .then((identity) => {
        if (active) setSession(identity)
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setChecking(false)
      })
    return () => {
      active = false
    }
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const tokenInput = form.elements.namedItem('token') as HTMLInputElement
    const token = tokenInput.value.trim()
    tokenInput.value = ''
    if (!token) return
    setSubmitting(true)
    setError(undefined)
    try {
      setSession(await login(token))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '凭据无效或已失效')
    } finally {
      setSubmitting(false)
    }
  }

  async function endSession() {
    try {
      await logout()
    } finally {
      setSession(undefined)
    }
  }

  if (checking) {
    return (
      <main className="auth-shell" aria-label="正在验证会话">
        <div className="auth-loading"><Armchair size={24} /><span>正在验证访问权限…</span></div>
      </main>
    )
  }

  if (session) return children({ session, logout: endSession })

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand">
          <span><Armchair size={23} /></span>
          <div><strong>FURNITURE CENTER</strong><small>家具中心</small></div>
        </div>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>访问凭据</span>
            <div className="auth-token-field">
              <KeyRound size={17} />
              <input
                name="token"
                type="password"
                autoComplete="current-password"
                required
                disabled={submitting}
                placeholder="ms-fc-…"
              />
            </div>
          </label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button type="submit" disabled={submitting}>
            {submitting ? '正在验证…' : '进入 FurnitureCenter'}
            {!submitting && <ArrowRight size={17} />}
          </button>
        </form>
        <footer><ShieldCheck size={15} />受保护的内部家具目录</footer>
      </section>
    </main>
  )
}
