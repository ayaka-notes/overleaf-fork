import { useCallback, useMemo } from 'react'
import { useEditorManagerContext } from '@/features/ide-react/context/editor-manager-context'
import { useEditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'
import { useEditorViewContext } from '@/features/ide-react/context/editor-view-context'

export type EditorContentInfo = {
  fileName: string | null
  documentContent: string | null
  selectedText: string | null
  selectionRange: {
    startLine: number
    endLine: number
  } | null
}

/**
 * Hook to gather current editor context for AI chat.
 * Uses getCurrentDocValue() for full doc content and the active CodeMirror
 * EditorView for source-accurate selection line ranges.
 */
export function useEditorContent(): {
  getEditorContext: () => EditorContentInfo
} {
  const { getCurrentDocValue } = useEditorManagerContext()
  const { openDocName } = useEditorOpenDocContext()
  const { view } = useEditorViewContext()

  const getEditorContext = useCallback((): EditorContentInfo => {
    const documentContent = getCurrentDocValue()

    let selectedText: string | null = null
    let selectionRange: EditorContentInfo['selectionRange'] = null

    if (view) {
      const { from, to } = view.state.selection.main
      if (from !== to) {
        selectedText = view.state.sliceDoc(from, to).trim() || null
        selectionRange = {
          startLine: view.state.doc.lineAt(from).number,
          endLine: view.state.doc.lineAt(Math.max(from, to - 1)).number,
        }
      }
    }

    return {
      fileName: openDocName,
      documentContent,
      selectedText,
      selectionRange,
    }
  }, [getCurrentDocValue, openDocName, view])

  return useMemo(() => ({ getEditorContext }), [getEditorContext])
}
