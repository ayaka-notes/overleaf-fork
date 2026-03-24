import { useCallback, useEffect, useRef, useState } from 'react'
import MaterialIcon from '@/shared/components/material-icon'
import { useEditorContent } from '../hooks/use-editor-content'
import { useEditorSelectionContext } from '@/shared/context/editor-selection-context'

type AiChatInputProps = {
  onSend: (message: string) => void
  onStop: () => void
  isStreaming: boolean
  onTypingChange?: (isTyping: boolean) => void
}

function AiChatInput({
  onSend,
  onStop,
  isStreaming,
  onTypingChange,
}: AiChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { getEditorContext } = useEditorContent()
  const { editorSelection } = useEditorSelectionContext()
  const [value, setValue] = useState('')
  const [selectionPreview, setSelectionPreview] = useState<string | null>(null)
  const [currentFile, setCurrentFile] = useState<string | null>(null)

  // Refresh context indicators when the input is focused
  const refreshContext = useCallback(() => {
    const ctx = getEditorContext()
    setSelectionPreview(
      ctx.selectionRange
        ? `Lines ${ctx.selectionRange.startLine}-${ctx.selectionRange.endLine}`
        : null
    )
    setCurrentFile(ctx.fileName)
  }, [getEditorContext])

  useEffect(() => {
    // Refresh on mount.
    refreshContext()
  }, [refreshContext])

  useEffect(() => {
    refreshContext()
  }, [refreshContext, editorSelection])

  useEffect(() => {
    const handleSelectionChange = () => {
      const activeElement = document.activeElement
      if (activeElement?.closest('.cm-editor')) {
        refreshContext()
      }
    }

    document.addEventListener('selectionchange', handleSelectionChange)

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange)
    }
  }, [refreshContext])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = Math.max(textarea.scrollHeight, 120) + 'px'
  }, [value])

  const handleSubmit = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const trimmed = value.trim()
    if (!trimmed) return
    onSend(trimmed)
    setValue('')
    onTypingChange?.(false)
    textarea.style.height = '120px'
    setSelectionPreview(null)
  }, [onSend, onTypingChange, value])

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

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value
      setValue(newValue)
      onTypingChange?.(newValue.trim().length > 0)
      event.target.style.height = 'auto'
      event.target.style.height =
        Math.min(Math.max(event.target.scrollHeight, 120), 220) + 'px'
    },
    [onTypingChange]
  )

  const handleFocus = useCallback(() => {
    refreshContext()
  }, [refreshContext])

  const canSubmit = value.trim().length > 0 && !isStreaming

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
              <MaterialIcon type="rate_review" />
              {selectionPreview}
            </span>
          )}
        </div>
      )}
      <form
        className="my-1 p-2 workbench-prompt-input ai-chat-prompt-form"
        onSubmit={event => {
          event.preventDefault()
          handleSubmit()
        }}
      >
        <div className="d-flex w-100 flex-column gap-2 input-group">
          <div>
            <textarea
              ref={textareaRef}
              name="message"
              value={value}
              className="w-100 workbench-prompt-input-textarea form-control ai-chat-textarea"
              placeholder="What would you like to do?"
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onFocus={handleFocus}
              rows={4}
              disabled={isStreaming}
            />
          </div>
          <div className="d-flex align-items-end justify-content-between gap-2">
            <div />
            <div className="d-flex align-items-center justify-content-end gap-2 flex-grow-1">
              {isStreaming ? (
                <button
                  type="button"
                  className="d-inline-grid icon-button btn btn-ghost ai-chat-send-btn ai-chat-stop-btn"
                  onClick={onStop}
                  aria-label="Stop generating"
                >
                  <span className="button-content" aria-hidden="false">
                    <MaterialIcon type="stop" />
                  </span>
                </button>
              ) : (
                <span>
                  <button
                    type="submit"
                    className="d-inline-grid icon-button btn btn-ghost ai-chat-send-btn"
                    disabled={!canSubmit}
                    aria-label="Send message"
                  >
                    <span className="button-content" aria-hidden="false">
                      <MaterialIcon type="send" />
                    </span>
                  </button>
                </span>
              )}
            </div>
          </div>
        </div>
      </form>
      <div className="workbench-ai-message">
        <span>AI can make mistakes.</span>
        <span>Always check responses.</span>
      </div>
    </div>
  )
}

export default AiChatInput
