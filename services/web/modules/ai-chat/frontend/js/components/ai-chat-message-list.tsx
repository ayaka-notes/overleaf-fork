import { useEffect, useRef } from 'react'
import MaterialIcon from '@/shared/components/material-icon'
import type { AiChatMessage } from '../context/ai-chat-context'
import AiChatMarkdown from './ai-chat-markdown'

function AiChatMessageList({ messages }: { messages: AiChatMessage[] }) {
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="conversation-content ai-chat-messages">
      {messages.map(message => (
        <div
          key={message.id}
          className={`workbench-message ai-chat-message ai-chat-message-${message.role} ${
            message.role === 'assistant' ? 'from-assistant' : 'from-user'
          }`}
        >
          <div className="workbench-message-content ai-chat-message-card">
            <div className="ai-chat-message-avatar">
              {message.role === 'assistant' ? (
                <span className="ai-chat-avatar-icon">
                  <MaterialIcon type="smart_toy" />
                </span>
              ) : (
                <span className="ai-chat-avatar-icon ai-chat-avatar-user">
                  <MaterialIcon type="person" />
                </span>
              )}
            </div>
            <div className="ai-chat-message-body">
              <div className="ai-chat-message-role">
                {message.role === 'assistant' ? 'AI Assistant' : 'You'}
              </div>
              {message.editorContext && (
                <ContextBadges ctx={message.editorContext} />
              )}
              <div className="ai-chat-message-content">
                <AiChatMarkdown content={message.content} />
              </div>
              {message.isStreaming && (
                <div className="ai-chat-message-streaming">
                  <span className="ai-chat-cursor" aria-hidden="true" />
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
      <div ref={messagesEndRef} />
    </div>
  )
}

function ContextBadges({
  ctx,
}: {
  ctx: NonNullable<AiChatMessage['editorContext']>
}) {
  const hasBadge = ctx.fileName || ctx.selectionRange
  if (!hasBadge) return null

  return (
    <div className="ai-chat-context-badges">
      {ctx.fileName && (
        <span className="ai-chat-badge">
          <MaterialIcon type="description" />
          {ctx.fileName}
        </span>
      )}
      {ctx.selectionRange && (
        <span className="ai-chat-badge ai-chat-badge-selection">
          <MaterialIcon type="rate_review" />
          {`Lines ${ctx.selectionRange.startLine}-${ctx.selectionRange.endLine}`}
        </span>
      )}
    </div>
  )
}

export default AiChatMessageList
