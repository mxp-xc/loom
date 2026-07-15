import { useEffect, useState } from 'react'
import type { SourceTreeBundleNode } from '@loom/core'
import { api } from '@/lib/api'
import { inferRepositoryFileWebUrl } from '@/lib/repository-links'
import { MarkdownDocument } from '@/components/MarkdownPreview'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import {
  ArrowLeft,
  Check,
  Code2,
  Copy,
  ExternalLink,
  FileText,
  LoaderCircle,
  PackageCheck,
} from 'lucide-react'
import { skillFolderDisplayPath } from './source-paths'
import styles from './SourceSkillPreview.module.css'

interface Props {
  repoPath: string
  sourceUrl: string
  sourceRef: string
  sourceName: string
  bundle: SourceTreeBundleNode
  onBack: () => void
}

type DocumentMode = 'preview' | 'source'

export default function SourceSkillPreview({
  repoPath,
  sourceUrl,
  sourceRef,
  sourceName,
  bundle,
  onBack,
}: Props) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<DocumentMode>('preview')
  const [copied, setCopied] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let active = true
    setContent(null)
    setError(null)
    setMode('preview')
    setCopied(false)
    api
      .getSkillContent(repoPath, `${sourceName}-${bundle.name}`, sourceUrl, bundle.entry)
      .then((result) => {
        if (!active) return
        if (!result.ok) {
          setError(result.message ?? result.error ?? '读取失败')
          return
        }
        setContent(result.content ?? '')
      })
      .catch((err: unknown) => {
        if (!active) return
        console.error({ err, sourceUrl, entry: bundle.entry }, 'Failed to preview source skill')
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
    }
  }, [bundle.entry, bundle.name, reloadKey, repoPath, sourceName, sourceUrl])

  const copyContent = async () => {
    if (!navigator.clipboard || content == null) return
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error({ err, sourceUrl, entry: bundle.entry }, 'Failed to copy source skill preview')
    }
  }

  const remoteUrl = inferRepositoryFileWebUrl(sourceUrl, sourceRef, bundle.entry)
  const displayPath = skillFolderDisplayPath(bundle.entry)

  return (
    <section className={styles.root} aria-label={`Preview ${bundle.name}`}>
      <header className={styles.header}>
        <Button variant="ghost" size="xs" onClick={onBack}>
          <ArrowLeft size={14} />
          Back
        </Button>
        <span className={styles.identity}>
          <span className={styles.icon} aria-hidden="true">
            <PackageCheck size={14} />
          </span>
          <span>
            <strong>{bundle.name}</strong>
            <code title={bundle.entry}>{displayPath}</code>
          </span>
        </span>
        {remoteUrl && (
          <a
            className={styles.remoteLink}
            href={remoteUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${bundle.name} in remote repository`}
            title={remoteUrl}
          >
            <ExternalLink size={14} />
          </a>
        )}
      </header>

      <div className={styles.toolbar}>
        <div className={styles.tabs} role="tablist" aria-label="Source skill view">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'preview'}
            onClick={() => setMode('preview')}
          >
            <FileText size={14} />
            Preview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'source'}
            onClick={() => setMode('source')}
          >
            <Code2 size={14} />
            Source
          </button>
        </div>
        <IconButton
          label={copied ? 'Copied SKILL.md' : 'Copy SKILL.md'}
          tooltip={copied ? 'Copied' : 'Copy'}
          tone={copied ? 'success' : 'default'}
          size="sm"
          disabled={content == null}
          onClick={() => void copyContent()}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </IconButton>
      </div>

      <div className={styles.content}>
        {content == null && !error && (
          <div className={styles.state} role="status">
            <LoaderCircle size={20} className={styles.spin} />
            <strong>Loading SKILL.md</strong>
          </div>
        )}
        {error && (
          <div className={styles.state} role="alert">
            <FileText size={20} />
            <strong>SKILL.md failed to load</strong>
            <p>{error}</p>
            <Button variant="secondary" size="sm" onClick={() => setReloadKey((key) => key + 1)}>
              Retry
            </Button>
          </div>
        )}
        {content != null && mode === 'preview' && content.trim() !== '' && (
          <MarkdownDocument content={content} className={styles.markdown} />
        )}
        {content != null && mode === 'preview' && content.trim() === '' && (
          <div className={styles.state}>
            <FileText size={20} />
            <strong>Empty SKILL.md</strong>
          </div>
        )}
        {content != null && mode === 'source' && <pre className={styles.source}>{content}</pre>}
      </div>
    </section>
  )
}
