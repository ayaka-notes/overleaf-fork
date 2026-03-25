import { useEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import sanitizeHtml from 'sanitize-html'
import useIsMounted from '@/shared/hooks/use-is-mounted'
import { debugConsole } from '@/utils/debugging'
import { loadMathJax } from '@/features/mathjax/load-mathjax'

const COPY_ICON = 'content_copy'
const CHECK_ICON = 'check'

function attachCopyButtons(container: HTMLElement) {
  container.querySelectorAll<HTMLElement>('pre').forEach(pre => {
    if (pre.querySelector('.ai-chat-copy-btn')) return
    const code = pre.querySelector('code')
    if (!code) return

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ai-chat-copy-btn'
    btn.setAttribute('aria-label', 'Copy code')
    btn.innerHTML = `<span class="material-symbols" aria-hidden="true">${COPY_ICON}</span>`

    btn.addEventListener('click', () => {
      const text = code.textContent ?? ''
      navigator.clipboard
        .writeText(text)
        .then(() => {
          btn.innerHTML = `<span class="material-symbols" aria-hidden="true">${CHECK_ICON}</span>`
          setTimeout(() => {
            btn.innerHTML = `<span class="material-symbols" aria-hidden="true">${COPY_ICON}</span>`
          }, 2000)
        })
        .catch(debugConsole.error)
    })

    pre.appendChild(btn)
  })
}

type AiChatMarkdownProps = {
  content: string
}

function stripHiddenReasoning(content: string) {
  return content
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/&lt;think&gt;[\s\S]*?(?:&lt;\/think&gt;|$)/gi, '')
    .trim()
}

export default function AiChatMarkdown({ content }: AiChatMarkdownProps) {
  const root = useRef<HTMLDivElement | null>(null)
  const mounted = useIsMounted()

  const html = useMemo(() => {
    const cleanContent = stripHiddenReasoning(content)
    const rendered = marked.parse(cleanContent, {
      breaks: true,
      gfm: true,
    })

    return sanitizeHtml(rendered, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat([
        'img',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'pre',
        'code',
      ]),
      allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        a: ['href', 'name', 'target', 'rel'],
        code: ['class'],
      },
      transformTags: {
        a: sanitizeHtml.simpleTransform('a', {
          target: '_blank',
          rel: 'noreferrer noopener',
        }),
      },
    })
  }, [content])

  useEffect(() => {
    if (!root.current || !html) return
    attachCopyButtons(root.current)
  }, [html])

  useEffect(() => {
    if (!root.current || !html) return

    loadMathJax()
      .then(async MathJax => {
        if (!mounted.current || !root.current) return

        const element = root.current
        try {
          await MathJax.typesetPromise([element])
          MathJax.typesetClear([element])
        } catch (error) {
          debugConsole.error(error)
        }
      })
      .catch(debugConsole.error)
  }, [html, mounted])

  if (!html) {
    return null
  }

  return (
    <div
      ref={root}
      className="ai-chat-markdown"
      data-ol-mathjax
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
