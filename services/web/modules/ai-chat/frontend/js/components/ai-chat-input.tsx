import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MaterialIcon from '@/shared/components/material-icon'
import { useEditorContent } from '../hooks/use-editor-content'
import { useEditorSelectionContext } from '@/shared/context/editor-selection-context'
import { type AiChatAttachment } from '../context/ai-chat-context'

type AiChatInputProps = {
  onSend: (message: string, attachments?: AiChatAttachment[]) => void
  onStop: () => void
  isStreaming: boolean
  onTypingChange?: (isTyping: boolean) => void
}

const ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

function AiChatInput({
  onSend,
  onStop,
  isStreaming,
  onTypingChange,
}: AiChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { getEditorContext } = useEditorContent()
  const { editorSelection } = useEditorSelectionContext()
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<AiChatAttachment[]>([])
  const [selectionPreview, setSelectionPreview] = useState<string | null>(null)
  const [currentFile, setCurrentFile] = useState<string | null>(null)
  const [previewAttachment, setPreviewAttachment] =
    useState<AiChatAttachment | null>(null)
  const [previewAnchor, setPreviewAnchor] = useState<DOMRect | null>(null)

  const previewStyle = useMemo(() => {
    if (!previewAnchor) return {}
    const PREVIEW_W = Math.min(0.4 * window.innerWidth, 400)
    const GAP = 8
    let left = previewAnchor.left + previewAnchor.width / 2 - PREVIEW_W / 2
    left = Math.max(8, Math.min(left, window.innerWidth - PREVIEW_W - 8))
    const top =
      previewAnchor.top - GAP > 300
        ? undefined
        : previewAnchor.bottom + GAP
    const bottom =
      previewAnchor.top - GAP > 300
        ? window.innerHeight - previewAnchor.top + GAP
        : undefined
    return { left, top, bottom, width: PREVIEW_W }
  }, [previewAnchor])

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
    if (!trimmed && attachments.length === 0) return
    onSend(trimmed, attachments)
    setValue('')
    setAttachments([])
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
    onTypingChange?.(false)
    textarea.style.height = '120px'
    setSelectionPreview(null)
  }, [attachments, onSend, onTypingChange, value])

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
      onTypingChange?.(newValue.trim().length > 0 || attachments.length > 0)
      event.target.style.height = 'auto'
      event.target.style.height =
        Math.min(Math.max(event.target.scrollHeight, 120), 220) + 'px'
    },
    [attachments.length, onTypingChange]
  )

  const handleFocus = useCallback(() => {
    refreshContext()
  }, [refreshContext])

  const removeAttachment = useCallback((id: string) => {
    setAttachments(current => {
      const next = current.filter(item => item.id !== id)
      onTypingChange?.(value.trim().length > 0 || next.length > 0)
      return next
    })
  }, [onTypingChange, value])

  const handleChooseFiles = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? [])
      if (files.length === 0) return

      const nextAttachments = await Promise.all(
        files
          .filter(file => ACCEPTED_IMAGE_TYPES.includes(file.type))
          .map(
            file =>
              new Promise<AiChatAttachment>((resolve, reject) => {
                const reader = new FileReader()
                reader.onload = () => {
                  if (typeof reader.result !== 'string') {
                    reject(new Error('Failed to read image file'))
                    return
                  }
                  resolve({
                    id: `${file.name}-${file.lastModified}-${file.size}`,
                    name: file.name,
                    mimeType: file.type,
                    dataUrl: reader.result,
                    size: file.size,
                  })
                }
                reader.onerror = () => reject(new Error('Failed to read image file'))
                reader.readAsDataURL(file)
              })
          )
      )

      setAttachments(current => {
        const existing = new Set(current.map(item => item.id))
        return [
          ...current,
          ...nextAttachments.filter(item => !existing.has(item.id)),
        ]
      })
      onTypingChange?.(value.trim().length > 0 || nextAttachments.length > 0)
      event.target.value = ''
    },
    [onTypingChange, value]
  )

  const hasPendingInput = value.trim().length > 0 || attachments.length > 0
  const canSubmit = hasPendingInput && !isStreaming

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
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            multiple
            className="ai-chat-hidden-file-input"
            onChange={handleFileChange}
            tabIndex={-1}
          />
          {attachments.length > 0 && (
            <div className="ai-chat-attachment-strip">
              {attachments.map(attachment => (
                <div
                  key={attachment.id}
                  className="ai-chat-attachment-preview"
                  onMouseEnter={event => {
                    setPreviewAttachment(attachment)
                    setPreviewAnchor(
                      (
                        event.currentTarget as HTMLElement
                      ).getBoundingClientRect()
                    )
                  }}
                  onMouseLeave={() => {
                    setPreviewAttachment(null)
                    setPreviewAnchor(null)
                  }}
                >
                  <img
                    src={attachment.dataUrl}
                    alt={attachment.name}
                    className="ai-chat-attachment-preview-image"
                  />
                  <button
                    type="button"
                    className="ai-chat-attachment-remove btn btn-ghost btn-sm"
                    onClick={() => removeAttachment(attachment.id)}
                    aria-label={`Remove ${attachment.name}`}
                  >
                    <MaterialIcon type="close" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {previewAttachment && previewAnchor && (
            <div
              className="ai-chat-image-hover-preview"
              style={previewStyle}
              aria-hidden="true"
            >
              <img
                src={previewAttachment.dataUrl}
                alt={previewAttachment.name}
                className="ai-chat-image-hover-preview-image"
              />
            </div>
          )}
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
            <div className="d-flex align-items-center gap-2">
              <button
                type="button"
                data-ol-loading="false"
                className="d-inline-grid icon-button btn btn-ghost ai-chat-attach-btn"
                onClick={handleChooseFiles}
                disabled={isStreaming}
                aria-label="Attach image"
              >
                <span className="button-content" aria-hidden="false">
                  <MaterialIcon type="attach_file" />
                </span>
              </button>
            </div>
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
