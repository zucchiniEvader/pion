// Markdown renderer for assistant reply text. Visual styling lives in the
// `.md` rules in styles.css so the transcript's 13px scale and design tokens
// stay in one place. GFM adds tables, task lists and strikethrough; raw HTML
// is not rendered (react-markdown default), which keeps session content inert.
import { memo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  )
})
