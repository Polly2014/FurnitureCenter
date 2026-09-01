import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}))

vi.mock('../../api', () => api)

import { AuthGate } from './AuthGate'

beforeEach(() => {
  api.getAuthSession.mockReset()
  api.login.mockReset()
  api.logout.mockReset()
})

describe('AuthGate', () => {
  it('removes the unauthenticated gate copy block', async () => {
    api.getAuthSession.mockRejectedValue(new Error('未认证'))
    render(
      <AuthGate>
        {({ session }) => <p>{session.role}</p>}
      </AuthGate>,
    )

    await screen.findByLabelText('访问凭据')
    expect(screen.getByText('FURNITURE SHARING PLATFORM')).toBeInTheDocument()
    expect(screen.getByText('家具共享平台')).toBeInTheDocument()
    expect(screen.queryByText('PRIVATE INVENTORY')).not.toBeInTheDocument()
    expect(screen.queryByText('访问家具共享目录')).not.toBeInTheDocument()
    expect(
      screen.queryByText('输入分配给你的访问凭据。凭据仅用于换取当前浏览器的安全会话，不会保存在页面中。'),
    ).not.toBeInTheDocument()
  })

  it('shows the credential prefix in the unauthenticated gate', async () => {
    api.getAuthSession.mockRejectedValue(new Error('未认证'))
    render(
      <AuthGate>
        {({ session }) => <p>{session.role}</p>}
      </AuthGate>,
    )

    expect(await screen.findByLabelText('访问凭据')).toHaveAttribute('placeholder', 'ms-fc-…')
  })

  it('exchanges a token once and renders the authenticated identity without echoing it', async () => {
    const user = userEvent.setup()
    api.getAuthSession.mockRejectedValue(new Error('未认证'))
    api.login.mockResolvedValue({
      role: 'admin',
      label: '家具管理员',
      expires_at: '2026-09-01T00:00:00.000Z',
    })
    render(
      <AuthGate>
        {({ session }) => <p>已登录：{session.role} · {session.label}</p>}
      </AuthGate>,
    )

    const token = 'ms-fc-admin-browser-test-token'
    await user.type(await screen.findByLabelText('访问凭据'), token)
    await user.click(screen.getByRole('button', { name: '进入家具共享平台' }))

    expect(await screen.findByText('已登录：admin · 家具管理员')).toBeInTheDocument()
    expect(screen.queryByDisplayValue(token)).not.toBeInTheDocument()
  })

  it('shows a sanitized login error and keeps the credential field clear', async () => {
    const user = userEvent.setup()
    api.getAuthSession.mockRejectedValue(new Error('未认证'))
    api.login.mockRejectedValue(new Error('凭据无效或已失效'))
    render(
      <AuthGate>
        {({ session }) => <p>{session.role}</p>}
      </AuthGate>,
    )

    const input = await screen.findByLabelText('访问凭据')
    await user.type(input, 'ms-fc-invalid-secret-value')
    await user.click(screen.getByRole('button', { name: '进入家具共享平台' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('凭据无效或已失效')
    expect(input).toHaveValue('')
    expect(screen.queryByText('ms-fc-invalid-secret-value')).not.toBeInTheDocument()
  })
})
