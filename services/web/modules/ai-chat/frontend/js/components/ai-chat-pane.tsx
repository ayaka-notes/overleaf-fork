import RailPanelHeader from '@/features/ide-react/components/rail/rail-panel-header'
import MaterialIcon from '@/shared/components/material-icon'
import OLIconButton from '@/shared/components/ol/ol-icon-button'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import { useCallback, useState } from 'react'
import { AiChatProvider, useAiChatContext } from '../context/ai-chat-context'
import AiChatInput from './ai-chat-input'
import AiChatMessageList from './ai-chat-message-list'
import AiChatEmptyState from './ai-chat-empty-state'

function AiChatPaneContent() {
  const { messages, status, error, sendMessage, clearMessages, stopStreaming } =
    useAiChatContext()
  const [isTyping, setIsTyping] = useState(false)

  const handleClear = useCallback(() => {
    clearMessages()
  }, [clearMessages])

  const isStreaming = status === 'streaming'
  const isEmpty = messages.length === 0

  return (
    <div className="ai-chat-panel">
      <RailPanelHeader
        title="AI Assistant"
        actions={
          messages.length > 0 ? (
            <OLTooltip
              id="clear-ai-chat"
              description="New conversation"
              overlayProps={{ placement: 'bottom' }}
            >
              <OLIconButton
                onClick={handleClear}
                className="rail-panel-header-button-subdued"
                icon="delete_sweep"
                accessibilityLabel="New conversation"
                size="sm"
              />
            </OLTooltip>
          ) : undefined
        }
      />
      <div className="ai-chat-body conversation" role="log" aria-live="polite">
        {isEmpty && !isTyping && !error ? (
          <AiChatEmptyState onSelectPrompt={sendMessage} />
        ) : (
          <AiChatMessageList messages={messages} />
        )}
        {error && (
          <div className="ai-chat-error">
            <MaterialIcon type="error" className="ai-chat-error-icon" />
            <span>{error}</span>
          </div>
        )}
      </div>
      <AiChatInput
        onSend={sendMessage}
        onStop={stopStreaming}
        isStreaming={isStreaming}
        onTypingChange={setIsTyping}
      />
    </div>
  )
}

function AiChatPane() {
  return (
    <AiChatProvider>
      <AiChatPaneContent />
    </AiChatProvider>
  )
}

export default AiChatPane
