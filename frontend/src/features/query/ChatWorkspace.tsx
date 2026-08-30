import { type FormEvent, useEffect, useRef } from 'react'
import { ArrowUp, Bot, Sparkles, Trash2 } from 'lucide-react'
import type { AgentStatus } from '../../types'

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
}

type ChatWorkspaceProps = {
  messages: ChatMessage[]
  draft: string
  loading: boolean
  phase: 'planning' | 'answering'
  resultCount: number
  agentStatus?: AgentStatus
  onDraftChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onSuggestion: (message: string) => void
  onClear: () => void
}

const suggestions = [
  '北京有哪些会议椅？',
  '找 Haworth 品牌的家具',
  '有哪些可用的会议桌？',
]

export function ChatWorkspace({
  messages,
  draft,
  loading,
  phase,
  resultCount,
  agentStatus,
  onDraftChange,
  onSubmit,
  onSuggestion,
  onClear,
}: ChatWorkspaceProps) {
  const threadEndRef = useRef<HTMLDivElement>(null)
  const lastMessage = messages[messages.length - 1]

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'nearest' })
  }, [loading, messages])

  return (
    <section className="conversation-panel">
      <header className="conversation-heading">
        <div className="assistant-identity"><span><Bot size={18} /></span><strong>家具助手</strong></div>
        <div className="conversation-state"><span className={`agent-readiness${agentStatus?.configured ? ' is-ready' : ''}`}>{agentStatus?.configured ? '已连接' : '待配置'}</span><span className="context-count">当前结果 {resultCount}</span><button type="button" className="clear-conversation" onClick={onClear} disabled={loading || messages.length <= 1} aria-label="清空会话" title="清空会话"><Trash2 size={15} /></button></div>
      </header>

      <div className="message-thread" aria-live="polite">
        {messages.map((message) => (
          <article key={message.id} className={`message ${message.role}${loading && message.id === lastMessage?.id && message.role === 'assistant' ? ' is-streaming' : ''}`}>
            {message.role === 'assistant' && <span className="message-avatar"><Sparkles size={14} /></span>}
            <div><small>{message.role === 'assistant' ? 'FURNITURE CENTER' : '你'}</small><p>{message.content}{loading && message.id === lastMessage?.id && message.role === 'assistant' && <span className="stream-caret" />}</p></div>
          </article>
        ))}
        {loading && lastMessage?.role !== 'assistant' && <article className="message assistant is-loading"><span className="message-avatar"><Sparkles size={14} /></span><div><small>FURNITURE CENTER</small><p><span className="loading-label">{phase === 'planning' ? '我去翻翻库存…' : '找到了，整理一下…'}</span><i /><i /><i /></p></div></article>}
        <div ref={threadEndRef} />
      </div>

      <div className="suggestion-row" aria-label="建议问题">
        {suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => onSuggestion(suggestion)} disabled={loading}>{suggestion}</button>)}
      </div>

      <form className="chat-composer" onSubmit={onSubmit}>
        <label><span>询问家具、库存或所在园区</span><textarea value={draft} onChange={(event) => onDraftChange(event.target.value)} rows={2} placeholder="例如：北京还有哪些 Haworth 会议椅？" aria-label="自然语言查询" /></label>
        <button type="submit" disabled={loading || !draft.trim()} aria-label="发送查询"><ArrowUp size={18} /></button>
      </form>
    </section>
  )
}