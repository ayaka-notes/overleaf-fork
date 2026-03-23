import RailPanelHeader from '@/features/ide-react/components/rail/rail-panel-header'
import MaterialIcon from '@/shared/components/material-icon'
import OLIconButton from '@/shared/components/ol/ol-icon-button'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import { useCallback } from 'react'
import { AiChatProvider, useAiChatContext } from '../context/ai-chat-context'
import AiChatInput from './ai-chat-input'
import AiChatMessageList from './ai-chat-message-list'

function AiChatPaneContent() {
  const { messages, status, error, sendMessage, clearMessages, stopStreaming } =
    useAiChatContext()

  const handleClear = useCallback(() => {
    clearMessages()
  }, [clearMessages])

  const isStreaming = status === 'streaming'
  const isEmpty = messages.length === 0

  return (
    <div className="ai-chat-panel">
      <RailPanelHeader
        title="AI Chat"
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
      <div className="ai-chat-body">
        {isEmpty && !error ? (
          <AiChatEmptyState />
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
      />
    </div>
  )
}

function AiChatEmptyState() {
  return (
    <div className="ai-chat-empty-state">
      <div>
        <span className="ai-chat-empty-icon">
          <MaterialIcon type="smart_toy" />
        </span>
      </div>
      <div className="ai-chat-empty-title">AI Assistant</div>
      <div className="ai-chat-empty-body">
        Ask questions about your LaTeX document, get help with formatting,
        debugging compilation errors, or writing content.
      </div>
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
