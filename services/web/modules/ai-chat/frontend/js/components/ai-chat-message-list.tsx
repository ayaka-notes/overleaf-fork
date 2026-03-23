import { useEffect, useRef } from 'react'
import MaterialIcon from '@/shared/components/material-icon'
import type { AiChatMessage } from '../context/ai-chat-context'

function AiChatMessageList({ messages }: { messages: AiChatMessage[] }) {
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="ai-chat-messages">
      {messages.map(message => (
        <div
          key={message.id}
          className={`ai-chat-message ai-chat-message-${message.role}`}
        >
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
              {message.role === 'assistant' ? 'AI' : 'You'}
            </div>
            <div className="ai-chat-message-content">
              {message.content}
              {message.isStreaming && (
                <span className="ai-chat-cursor" aria-hidden="true" />
              )}
            </div>
          </div>
        </div>
      ))}
      <div ref={messagesEndRef} />
    </div>
  )
}

export default AiChatMessageList
