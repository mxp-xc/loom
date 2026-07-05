import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '../../components/ui/button'
import { ApiError } from '../../lib/api'
import type {
  JsonValue,
  VarEntry,
  VarEntryInput,
  VarType,
  VarsDiagnostic,
  VarsResolution,
} from '../../lib/vars'
import StringValueEditor from './StringValueEditor'

const JsonValueEditor = lazy(() => import('./JsonValueEditor'))

const MASK = '••••••••'
type SecretState = 'masked-unmodified' | 'revealed' | 'edited'

interface Props {
  initialKey?: string
  entry?: VarEntry
  resolution: VarsResolution | null
  pending: boolean
  onSave: (key: string, entry: VarEntryInput) => Promise<void>
  onReveal?: () => Promise<string>
  validateDraft: (
    key: string,
    entry: VarEntryInput,
  ) => Promise<{ ok: true; resolution: VarsResolution }>
  warnings?: VarsDiagnostic[]
}

const serialize = (entry?: VarEntry) => {
  if (!entry) return ''
  if (entry.type === 'secret' && 'masked' in entry && entry.masked) return ''
  if (entry.type === 'json') return JSON.stringify(entry.value, null, 2)
  return String(entry.value)
}

export default function VariableEditor({
  initialKey = '',
  entry,
  resolution,
  pending,
  onSave,
  onReveal,
  validateDraft,
  warnings = [],
}: Props) {
  const [key, setKey] = useState(initialKey)
  const [type, setType] = useState<VarType>(entry?.type ?? 'string')
  const [draft, setDraft] = useState(serialize(entry))
  const [preview, setPreview] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<import('../../lib/vars').VarsDiagnostic[]>([])
  const [validating, setValidating] = useState(false)
  const [secretState, setSecretState] = useState<SecretState>(
    entry?.type === 'secret' && 'masked' in entry && entry.masked ? 'masked-unmodified' : 'edited',
  )
  const previewSequence = useRef(0)
  const previewTimer = useRef<number | null>(null)
  const revealSequence = useRef(0)
  const mounted = useRef(true)
  const currentKey = useRef(key)
  const currentType = useRef(type)
  const draftRevision = useRef(0)
  const [revealPendingGeneration, setRevealPendingGeneration] = useState<number | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      revealSequence.current += 1
    }
  }, [])

  useEffect(() => {
    revealSequence.current += 1
    if (mounted.current) setRevealPendingGeneration(null)
    draftRevision.current += 1
    setKey(initialKey)
    setType(entry?.type ?? 'string')
    setDraft(serialize(entry))
    setFieldError(null)
    setDiagnostics([])
    setSecretState(
      entry?.type === 'secret' && 'masked' in entry && entry.masked
        ? 'masked-unmodified'
        : 'edited',
    )
  }, [entry, initialKey])

  currentKey.current = key
  currentType.current = type
  const formBusy = pending || validating || revealPendingGeneration !== null

  useEffect(() => {
    const sequence = ++previewSequence.current
    setPreview('')
    const normalizedKey = key.trim()
    if (type === 'secret' && secretState === 'masked-unmodified') return
    const parsed = parseDraft(type, draft)
    if (!normalizedKey || !parsed.entry) return
    const timer = window.setTimeout(() => {
      void validateDraft(normalizedKey, parsed.entry).then(
        ({ resolution: validated }) => {
          if (sequence !== previewSequence.current) return
          const value = validated.values[normalizedKey]
          setPreview(
            value
              ? 'masked' in value && value.masked
                ? MASK
                : value.type === 'json'
                  ? JSON.stringify(value.value, null, 2)
                  : String(value.value)
              : '',
          )
        },
        (cause) => {
          if (sequence !== previewSequence.current) return
          console.error('Failed to validate variable preview', cause)
          setPreview('预览不可用')
        },
      )
    }, 200)
    previewTimer.current = timer
    return () => {
      window.clearTimeout(timer)
      if (previewTimer.current === timer) previewTimer.current = null
      previewSequence.current += 1
    }
  }, [draft, key, secretState, type, validateDraft])

  const changeType = (next: VarType) => {
    if (formBusy) {
      draftRevision.current += 1
      return
    }
    revealSequence.current += 1
    draftRevision.current += 1
    currentType.current = next
    setType(next)
    setFieldError(null)
    setDiagnostics([])
    if (next === 'secret')
      setSecretState(
        entry?.type === 'secret' && 'masked' in entry && entry.masked
          ? 'masked-unmodified'
          : 'edited',
      )
    else if (type === 'secret' && entry?.type === 'secret' && 'masked' in entry && entry.masked)
      setSecretState('masked-unmodified')
    setDraft(next === 'boolean' ? 'true' : next === 'json' ? '{}' : '')
  }
  const updateDraft = (next: string) => {
    if (formBusy) {
      draftRevision.current += 1
      return
    }
    draftRevision.current += 1
    setDraft(next)
    if (type === 'secret') setSecretState('edited')
    setFieldError(null)
    setDiagnostics([])
  }

  const revealSecret = async () => {
    if (!onReveal || formBusy) throw new Error('密钥暂不可显示')
    const generation = ++revealSequence.current
    const capturedKey = key
    setRevealPendingGeneration(generation)
    setFieldError(null)
    try {
      const value = await onReveal()
      if (
        !mounted.current ||
        generation !== revealSequence.current ||
        currentKey.current !== capturedKey ||
        currentType.current !== 'secret'
      )
        throw new Error('stale reveal response')
      draftRevision.current += 1
      setDraft(value)
      setSecretState('revealed')
      return value
    } catch (cause) {
      console.error('Failed to reveal secret variable', cause)
      if (mounted.current && generation === revealSequence.current)
        setFieldError('密钥显示失败，请重试')
      throw cause
    } finally {
      if (mounted.current && generation === revealSequence.current)
        setRevealPendingGeneration((current) => (current === generation ? null : current))
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (previewTimer.current !== null) {
      window.clearTimeout(previewTimer.current)
      previewTimer.current = null
      previewSequence.current += 1
    }
    const normalizedKey = key.trim()
    if (type === 'secret' && secretState === 'masked-unmodified') {
      setFieldError('请先显示密钥或输入新值')
      return
    }
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(normalizedKey)) {
      setFieldError('变量名格式无效')
      return
    }
    const parsedDraft = parseDraft(type, draft)
    if (!parsedDraft.entry) {
      setFieldError(parsedDraft.error)
      return
    }
    const parsed = parsedDraft.entry
    const submittedRevision = draftRevision.current
    const submittedType = type
    setFieldError(null)
    setDiagnostics([])
    setValidating(true)
    try {
      await validateDraft(normalizedKey, parsed)
      if (
        submittedRevision !== draftRevision.current ||
        normalizedKey !== currentKey.current.trim() ||
        submittedType !== currentType.current
      ) {
        setFieldError('变量已变更，请重新保存')
        return
      }
      await onSave(normalizedKey, parsed)
    } catch (cause) {
      console.error('Failed to save variable', cause)
      if (cause instanceof ApiError) {
        setDiagnostics(cause.diagnostics ?? [])
        if (!cause.diagnostics?.length) setFieldError(cause.message)
      } else setFieldError('变量保存失败')
    } finally {
      setValidating(false)
    }
  }

  return (
    <form className="vars-editor" onSubmit={(event) => void submit(event)}>
      <div className="vars-editor-row">
        <label htmlFor="vars-key">变量名</label>
        <input
          id="vars-key"
          value={key}
          disabled={formBusy}
          onChange={(event) => {
            draftRevision.current += 1
            if (formBusy) return
            currentKey.current = event.target.value
            setKey(event.target.value)
          }}
        />
      </div>
      <div className="vars-editor-row">
        <label htmlFor="vars-type">类型</label>
        <select
          id="vars-type"
          value={type}
          disabled={formBusy}
          onChange={(event) => changeType(event.target.value as VarType)}
        >
          <option value="string">string</option>
          <option value="number">number</option>
          <option value="boolean">boolean</option>
          <option value="secret">secret</option>
          <option value="json">json</option>
        </select>
      </div>
      <div className="vars-editor-row">
        <label htmlFor="vars-value">值</label>
        {type === 'string' || type === 'secret' ? (
          <StringValueEditor
            value={draft}
            secret={type === 'secret'}
            resolution={resolution}
            disabled={formBusy}
            onChange={updateDraft}
            maskedPlaceholder={secretState === 'masked-unmodified'}
            onReveal={onReveal ? revealSecret : undefined}
          />
        ) : type === 'boolean' ? (
          <select
            id="vars-value"
            value={draft}
            disabled={formBusy}
            onChange={(event) => updateDraft(event.target.value)}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : type === 'json' ? (
          <Suspense
            fallback={
              <div className="vars-json-loading" role="status">
                正在加载 JSON 编辑器…
              </div>
            }
          >
            <JsonValueEditor
              value={draft}
              disabled={formBusy}
              onChange={updateDraft}
              error={fieldError}
              onError={setFieldError}
            />
          </Suspense>
        ) : (
          <input
            id="vars-value"
            type="number"
            step="any"
            value={draft}
            disabled={formBusy}
            onChange={(event) => updateDraft(event.target.value)}
          />
        )}
        {fieldError && type !== 'json' && (
          <p className="vars-field-error" role="alert">
            {fieldError}
          </p>
        )}
      </div>
      <section className="vars-preview" aria-label="解析预览">
        <span>解析预览</span>
        <pre>{preview || '—'}</pre>
      </section>
      {warnings.map((warning, index) => (
        <div className="vars-warning-detail" role="status" key={`${warning.code}-${index}`}>
          <strong>引用警告</strong>
          <span>缺失变量：{warning.referencedKey ?? warning.path?.at(-1) ?? '未知变量'}</span>
          <span>来源环境：{warning.environment ?? '未知'}</span>
          {warning.path?.length ? <span>引用路径：{warning.path.join(' → ')}</span> : null}
        </div>
      ))}
      {diagnostics.length > 0 && (
        <div className="vars-diagnostics" role="alert">
          <ul>
            {diagnostics.map((item, index) => (
              <li key={`${item.code}-${index}`}>
                <strong>{item.code}</strong>
                <span>{item.message}</span>
                {item.key && <code>{item.key}</code>}
                {item.path?.length ? <code>{item.path.join(' → ')}</code> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="vars-form-actions">
        <Button
          type="submit"
          disabled={formBusy || (type === 'secret' && secretState === 'masked-unmodified')}
        >
          {formBusy ? '处理中…' : '保存变量'}
        </Button>
      </div>
    </form>
  )
}

function parseDraft(type: VarType, draft: string): { entry?: VarEntryInput; error: string | null } {
  if (type === 'number') {
    if (draft.trim() === '') return { error: '请输入有限数字' }
    const value = Number(draft)
    return Number.isFinite(value)
      ? { entry: { type, value }, error: null }
      : { error: '请输入有限数字' }
  }
  if (type === 'boolean') return { entry: { type, value: draft === 'true' }, error: null }
  if (type === 'json') {
    try {
      return { entry: { type, value: JSON.parse(draft) as JsonValue }, error: null }
    } catch (cause) {
      return { error: cause instanceof Error ? `JSON 语法错误：${cause.message}` : 'JSON 语法错误' }
    }
  }
  return { entry: { type, value: draft }, error: null }
}
