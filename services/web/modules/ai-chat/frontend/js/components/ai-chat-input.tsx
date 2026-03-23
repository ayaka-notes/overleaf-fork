import { useCallback, useEffect, useRef, useState } from 'react'
import MaterialIcon from '@/shared/components/material-icon'
import { useEditorContent } from '../hooks/use-editor-content'

type AiChatInputProps = {
  onSend: (message: string) => void
  onStop: () => void
  isStreaming: boolean
}

function AiChatInput({ onSend, onStop, isStreaming }: AiChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { getEditorContext } = useEditorContent()
  const [selectionPreview, setSelectionPreview] = useState<string | null>(null)
  const [currentFile, setCurrentFile] = useState<string | null>(null)

  // Refresh context indicators when the input is focused
  const refreshContext = useCallback(() => {
    const ctx = getEditorContext()
    setSelectionPreview(ctx.selectedText)
    setCurrentFile(ctx.fileName)
  }, [getEditorContext])

  useEffect(() => {
    // Refresh on mount and periodically when idle
    refreshContext()
    const interval = setInterval(refreshContext, 2000)
    return () => clearInterval(interval)
  }, [refreshContext])

  const handleSubmit = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const value = textarea.value.trim()
    if (!value) return
    onSend(value)
    textarea.value = ''
    textarea.style.height = 'auto'
    setSelectionPreview(null)
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

  const handleFocus = useCallback(() => {
    refreshContext()
  }, [refreshContext])

  return (
    <div className="ai-chat-input-area">
      {(selectionPreview || currentFile) && (
        <div className="ai-chat-context-bar">
          {currentFile && (
            <span className="ai-chat-context-chip">
              <MaterialIcon type="description" />
              {currentFile}
            </span>
          )}
          {selectionPreview && (
            <span className="ai-chat-context-chip ai-chat-context-chip-selection">
              <MaterialIcon type="highlight_alt" />
              {selectionPreview.length > 30
                ? selectionPreview.slice(0, 30) + '…'
                : selectionPreview}
            </span>
          )}
        </div>
      )}
      <div className="ai-chat-input-wrapper">
        <textarea
          ref={textareaRef}
          className="ai-chat-textarea"
          placeholder="Ask AI about your LaTeX document..."
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          onFocus={handleFocus}
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
