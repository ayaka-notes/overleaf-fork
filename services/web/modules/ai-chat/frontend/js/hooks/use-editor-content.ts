import { useCallback, useMemo } from 'react'
import { useEditorManagerContext } from '@/features/ide-react/context/editor-manager-context'
import { useEditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'

export type EditorContentInfo = {
  fileName: string | null
  documentContent: string | null
  selectedText: string | null
}

/**
 * Hook to gather current editor context for AI chat.
 * Uses getCurrentDocValue() for full doc content and
 * window.getSelection() as a fallback for selected text
 * (since CodeMirrorViewContext is not available in the rail).
 */
export function useEditorContent(): {
  getEditorContext: () => EditorContentInfo
} {
  const { getCurrentDocValue } = useEditorManagerContext()
  const { openDocName } = useEditorOpenDocContext()

  const getEditorContext = useCallback((): EditorContentInfo => {
    const documentContent = getCurrentDocValue()

    // Try to get selected text from the CodeMirror editor DOM
    let selectedText: string | null = null
    const cmEditor = document.querySelector('.cm-editor') as HTMLElement | null
    if (cmEditor) {
      // CodeMirror stores selection in its state, but we can read it via
      // the DOM selection if the editor is focused
      const sel = window.getSelection()
      if (sel && sel.toString().trim()) {
        // Check that the selection is within the editor
        const range = sel.getRangeAt(0)
        if (cmEditor.contains(range.commonAncestorContainer)) {
          selectedText = sel.toString().trim()
        }
      }
    }

    return {
      fileName: openDocName,
      documentContent,
      selectedText,
    }
  }, [getCurrentDocValue, openDocName])

  return useMemo(() => ({ getEditorContext }), [getEditorContext])
}
