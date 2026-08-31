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

    const token = 'fc_admin_browser_test_token'
    await user.type(await screen.findByLabelText('访问凭据'), token)
    await user.click(screen.getByRole('button', { name: '进入 FurnitureCenter' }))

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
    await user.type(input, 'invalid-secret-value')
    await user.click(screen.getByRole('button', { name: '进入 FurnitureCenter' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('凭据无效或已失效')
    expect(input).toHaveValue('')
    expect(screen.queryByText('invalid-secret-value')).not.toBeInTheDocument()
  })
})
