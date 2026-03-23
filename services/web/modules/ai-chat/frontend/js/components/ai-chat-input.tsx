import { useCallback, useRef } from 'react'
import MaterialIcon from '@/shared/components/material-icon'

type AiChatInputProps = {
  onSend: (message: string) => void
  onStop: () => void
  isStreaming: boolean
}

function AiChatInput({ onSend, onStop, isStreaming }: AiChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSubmit = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const value = textarea.value.trim()
    if (!value) return
    onSend(value)
    textarea.value = ''
    textarea.style.height = 'auto'
  }, [onSend])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        if (!isStreaming) {
          handleSubmit()
        }
      }
    },
    [handleSubmit, isStreaming]
  )

  const handleInput = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px'
  }, [])

  return (
    <div className="ai-chat-input-area">
      <div className="ai-chat-input-wrapper">
        <textarea
          ref={textareaRef}
          className="ai-chat-textarea"
          placeholder="Ask AI about your LaTeX document..."
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          rows={1}
          disabled={isStreaming}
        />
        {isStreaming ? (
          <button
            className="ai-chat-send-btn ai-chat-stop-btn"
            onClick={onStop}
            aria-label="Stop generating"
            type="button"
          >
            <MaterialIcon type="stop" />
          </button>
        ) : (
          <button
            className="ai-chat-send-btn"
            onClick={handleSubmit}
            aria-label="Send message"
            type="button"
          >
            <MaterialIcon type="send" />
          </button>
        )}
      </div>
    </div>
  )
}

export default AiChatInput
