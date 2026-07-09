import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import MonacoTextEditor from '@/components/monaco/MonacoTextEditor.js'
import { languageForFile } from '@/components/monaco/languages.js'
import { Button } from '@/components/ui/button.js'
import type { GitConflictFile } from '@/lib/api.js'
import { cn } from '@/lib/utils.js'
import {
  applyBlockSide,
  buildMergeModel,
  ignoreBlockSide,
  resetBlockSide,
  type BlockDecision,
  type BlockSide,
  type MergeBlock,
  type MergeChange,
  type MergeModel,
} from './merge-model.js'
import styles from './ConflictEditor.module.css'

interface Props {
  conflict: GitConflictFile
  index: number
  total: number
  saving: boolean
  onSave: (path: string, result: string) => void
  onAbort: () => void
}

type VisualChangeKind = 'stable' | 'conflict' | 'applied' | 'ignored'

interface DecorationTarget {
  editor: any
  monaco: any
  ids: string[]
}

function sideState(block: MergeBlock, side: BlockSide): BlockDecision {
  return side === 'local' ? block.localState : block.remoteState
}

function sideRange(block: MergeBlock, side: BlockSide) {
  return side === 'local'
    ? { from: block.localFrom, to: block.localTo }
    : { from: block.remoteFrom, to: block.remoteTo }
}

function overlaps(from: number, to: number, otherFrom: number, otherTo: number) {
  if (from === to) return from >= otherFrom && from <= otherTo
  if (otherFrom === otherTo) return otherFrom >= from && otherFrom <= to
  return from < otherTo && otherFrom < to
}

function commonPrefixLength(left: string, right: string) {
  const max = Math.min(left.length, right.length)
  let index = 0
  while (index < max && left[index] === right[index]) index += 1
  return index
}

function commonSuffixLength(left: string, right: string, prefixLength: number) {
  const max = Math.min(left.length, right.length) - prefixLength
  let length = 0
  while (length < max && left[left.length - length - 1] === right[right.length - length - 1]) {
    length += 1
  }
  return length
}

function resultTextEdit(previous: string, next: string) {
  const prefixLength = commonPrefixLength(previous, next)
  const suffixLength = commonSuffixLength(previous, next, prefixLength)
  return {
    previousFrom: prefixLength,
    previousTo: previous.length - suffixLength,
    nextTo: next.length - suffixLength,
    delta: next.length - previous.length,
  }
}

function mapResultPosition(
  position: number,
  edit: ReturnType<typeof resultTextEdit>,
  assoc: -1 | 1,
) {
  if (position < edit.previousFrom || (position === edit.previousFrom && assoc < 0)) {
    return position
  }
  if (position > edit.previousTo || (position === edit.previousTo && assoc > 0)) {
    return position + edit.delta
  }
  return assoc < 0 ? edit.previousFrom : edit.nextTo
}

function mapResultBlocks(blocks: MergeBlock[], previous: string, next: string) {
  const edit = resultTextEdit(previous, next)
  return blocks.map((block) => {
    const editTouchesBlock = overlaps(
      edit.previousFrom,
      edit.previousTo,
      block.resultFrom,
      block.resultTo,
    )
    return {
      ...block,
      resultFrom: mapResultPosition(block.resultFrom, edit, 1),
      resultTo: mapResultPosition(block.resultTo, edit, -1),
      ...(editTouchesBlock
        ? {
            localState: 'pending' as const,
            remoteState: 'pending' as const,
            appliedOrder: [],
          }
        : {}),
    }
  })
}

function unresolvedCount(blocks: MergeBlock[]) {
  return blocks.filter((block) => block.localState === 'pending' || block.remoteState === 'pending')
    .length
}

function visualKind(change: MergeChange, blocks: MergeBlock[], side: BlockSide): VisualChangeKind {
  if (change.kind === 'stable') return 'stable'
  const block = blocks.find((candidate) => {
    const range = sideRange(candidate, side)
    return overlaps(change.from, change.to, range.from, range.to)
  })
  const state = block ? sideState(block, side) : 'pending'
  return state === 'applied' || state === 'ignored' ? state : 'conflict'
}

function lineNumberAt(text: string, offset: number) {
  const boundedOffset = Math.max(0, Math.min(offset, text.length))
  let line = 1
  for (let index = 0; index < boundedOffset; index += 1) {
    if (text[index] === '\n') line += 1
  }
  return line
}

function changeDecorations(
  text: string,
  changes: Array<MergeChange & { visualKind: VisualChangeKind }>,
  monaco: any,
) {
  return changes.flatMap((change) => {
    const fromLine = lineNumberAt(text, change.from)
    const lastPosition = change.to > change.from ? change.to : change.from
    const toLine = lineNumberAt(text, lastPosition)
    const decorations = []
    for (let line = fromLine; line <= toLine; line += 1) {
      decorations.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: `merge-change merge-change-${change.visualKind}`,
          linesDecorationsClassName: `merge-change-${change.visualKind}`,
        },
      })
    }
    return decorations
  })
}

function updateDecorations(
  target: DecorationTarget | null,
  text: string,
  changes: Array<MergeChange & { visualKind: VisualChangeKind }>,
  onError: (message: string) => void,
) {
  if (!target?.editor?.deltaDecorations || !target.monaco?.Range) return
  try {
    target.ids = target.editor.deltaDecorations(
      target.ids,
      changeDecorations(text, changes, target.monaco),
    )
  } catch (err) {
    console.error({ err }, 'Failed to update Monaco conflict decorations')
    onError('冲突高亮加载失败')
  }
}

function sideChanges(model: MergeModel, side: BlockSide) {
  return model.changes[side].map((change) => ({
    ...change,
    visualKind: visualKind(change, model.blocks, side),
  }))
}

function resultVisualKind(block: MergeBlock): VisualChangeKind {
  if (block.localState === 'pending' || block.remoteState === 'pending') return 'conflict'
  if (block.localState === 'applied' || block.remoteState === 'applied') return 'applied'
  return 'ignored'
}

function resultChanges(model: MergeModel) {
  return model.blocks.map((block) => ({
    from: block.resultFrom,
    to: block.resultTo,
    kind: 'conflict' as const,
    visualKind: resultVisualKind(block),
  }))
}

function actionLabel(side: BlockSide) {
  return side === 'local' ? '本地' : '远程'
}

function ActionButtons({
  block,
  side,
  number,
  onApply,
  onIgnore,
  onReset,
}: {
  block: MergeBlock
  side: BlockSide
  number: number
  onApply: (id: string, side: BlockSide) => void
  onIgnore: (id: string, side: BlockSide) => void
  onReset: (id: string, side: BlockSide) => void
}) {
  const label = actionLabel(side)
  const state = sideState(block, side)
  const applyButton = (
    <button
      key="apply"
      type="button"
      className="merge-block-action"
      aria-label={
        state === 'applied'
          ? `${label}变更 ${number}：撤回应用`
          : `${label}变更 ${number}：应用到结果`
      }
      title={
        state === 'applied'
          ? `${label}变更 ${number}：撤回应用`
          : `${label}变更 ${number}：应用到结果`
      }
      disabled={state === 'ignored'}
      onClick={() => (state === 'applied' ? onReset(block.id, side) : onApply(block.id, side))}
    >
      {state === 'applied' ? '↶' : side === 'local' ? '→' : '←'}
    </button>
  )
  const ignoreButton = (
    <button
      key="ignore"
      type="button"
      className="merge-block-action"
      aria-label={
        state === 'ignored'
          ? `${label}变更 ${number}：撤回忽略`
          : `${label}变更 ${number}：忽略变更`
      }
      title={
        state === 'ignored'
          ? `${label}变更 ${number}：撤回忽略`
          : `${label}变更 ${number}：忽略变更`
      }
      disabled={state === 'applied'}
      onClick={() => (state === 'ignored' ? onReset(block.id, side) : onIgnore(block.id, side))}
    >
      {state === 'ignored' ? '↶' : '×'}
    </button>
  )

  return (
    <span className={`merge-block-actions is-${state}`}>
      {side === 'local' ? [ignoreButton, applyButton] : [applyButton, ignoreButton]}
    </span>
  )
}

export default function ConflictEditor({ conflict, index, total, saving, onSave, onAbort }: Props) {
  const localEditor = useRef<DecorationTarget | null>(null)
  const resultEditor = useRef<DecorationTarget | null>(null)
  const remoteEditor = useRef<DecorationTarget | null>(null)
  const [mobileSide, setMobileSide] = useState<'local' | 'result' | 'remote'>('result')
  const [decorationError, setDecorationError] = useState<string | null>(null)
  const [model, setModel] = useState<MergeModel>(() =>
    buildMergeModel(conflict.base ?? '', conflict.ours ?? '', conflict.theirs ?? ''),
  )

  const language = useMemo(() => languageForFile(conflict.path, 'yaml'), [conflict.path])

  useEffect(() => {
    setModel(buildMergeModel(conflict.base ?? '', conflict.ours ?? '', conflict.theirs ?? ''))
    setMobileSide('result')
    setDecorationError(null)
  }, [conflict])

  const applySide = useCallback((id: string, side: BlockSide) => {
    setModel((current) => applyBlockSide(current, id, side))
  }, [])

  const ignoreSide = useCallback((id: string, side: BlockSide) => {
    setModel((current) => ignoreBlockSide(current, id, side))
  }, [])

  const resetSide = useCallback((id: string, side: BlockSide) => {
    setModel((current) => resetBlockSide(current, id, side))
  }, [])

  const keepAutomaticMerge = () =>
    setModel(buildMergeModel(conflict.base ?? '', conflict.ours ?? '', conflict.theirs ?? ''))

  const keepWholeSide = (side: BlockSide) => {
    const automatic = buildMergeModel(
      conflict.base ?? '',
      conflict.ours ?? '',
      conflict.theirs ?? '',
    )
    setModel({
      ...automatic,
      result: (side === 'local' ? conflict.ours : conflict.theirs) ?? '',
      blocks: automatic.blocks.map((block) => ({
        ...block,
        localState: side === 'local' ? 'applied' : 'ignored',
        remoteState: side === 'remote' ? 'applied' : 'ignored',
      })),
      unresolvedCount: 0,
    })
  }

  const chooseBinaryFile = (value: string | null) =>
    setModel({
      result: value ?? '',
      blocks: [],
      changes: { local: [], remote: [] },
      unresolvedCount: 0,
    })

  const mountDecoratedEditor = (
    targetRef: MutableRefObject<DecorationTarget | null>,
    text: string,
    changes: Array<MergeChange & { visualKind: VisualChangeKind }>,
  ) => {
    return (editor: any, monaco: any) => {
      targetRef.current = { editor, monaco, ids: [] }
      updateDecorations(targetRef.current, text, changes, setDecorationError)
      return {
        dispose: () => {
          if (targetRef.current?.editor === editor) targetRef.current = null
        },
      }
    }
  }

  useEffect(() => {
    updateDecorations(
      localEditor.current,
      conflict.ours ?? '',
      sideChanges(model, 'local'),
      setDecorationError,
    )
    updateDecorations(resultEditor.current, model.result, resultChanges(model), setDecorationError)
    updateDecorations(
      remoteEditor.current,
      conflict.theirs ?? '',
      sideChanges(model, 'remote'),
      setDecorationError,
    )
  }, [conflict.ours, conflict.theirs, model])

  return (
    <section className={styles['conflict-editor-shell']}>
      <header className={styles['conflict-editor-header']}>
        <strong>{conflict.path}</strong>
        {!conflict.binary && (
          <div className={styles['conflict-editor-file-actions']}>
            <Button size="sm" variant="secondary" onClick={keepAutomaticMerge}>
              保留两者
            </Button>
            <Button size="sm" variant="secondary" onClick={() => keepWholeSide('local')}>
              保留本地
            </Button>
            <Button size="sm" variant="secondary" onClick={() => keepWholeSide('remote')}>
              保留远程
            </Button>
          </div>
        )}
        <span className={styles['conflict-editor-count']}>
          文件 {index + 1}/{total}
        </span>
      </header>

      {decorationError && (
        <div className={styles['conflict-editor-error']} role="alert">
          {decorationError}
        </div>
      )}

      {conflict.binary ? (
        <div className={styles['conflict-binary']}>
          <p>二进制文件不能在线编辑，请选择保留的版本。</p>
          <div>
            <Button size="sm" variant="secondary" onClick={() => chooseBinaryFile(conflict.ours)}>
              使用本地
            </Button>
            <Button size="sm" variant="secondary" onClick={() => chooseBinaryFile(conflict.theirs)}>
              使用远程
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className={styles['conflict-mobile-tabs']}>
            {(['local', 'result', 'remote'] as const).map((side) => (
              <button
                key={side}
                data-active={mobileSide === side}
                onClick={() => setMobileSide(side)}
              >
                {side.toUpperCase()}
              </button>
            ))}
          </div>
          <div className={styles['conflict-three-way']}>
            <div className={styles['conflict-pane']} data-mobile-active={mobileSide === 'local'}>
              <div className={styles['conflict-pane-label']}>LOCAL</div>
              <div className={styles['conflict-pane-body']}>
                <MonacoTextEditor
                  className={styles['conflict-pane-editor']}
                  value={conflict.ours ?? ''}
                  onChange={() => undefined}
                  language={language}
                  ariaLabel="Sync LOCAL"
                  readOnly
                  options={{ lineNumbers: 'on' }}
                  onEditorMount={mountDecoratedEditor(
                    localEditor,
                    conflict.ours ?? '',
                    sideChanges(model, 'local'),
                  )}
                />
                <div className="merge-action-rail" aria-label="本地冲突操作">
                  {model.blocks.map((block, blockIndex) => (
                    <ActionButtons
                      key={block.id}
                      block={block}
                      side="local"
                      number={blockIndex + 1}
                      onApply={applySide}
                      onIgnore={ignoreSide}
                      onReset={resetSide}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div
              className={cn(styles['conflict-pane'], styles['is-result'])}
              data-mobile-active={mobileSide === 'result'}
            >
              <div className={styles['conflict-pane-label']}>
                <span>RESULT</span>
                <span>{model.unresolvedCount} 个待处理冲突</span>
              </div>
              <MonacoTextEditor
                className={styles['conflict-pane-editor']}
                value={model.result}
                onChange={(result) =>
                  setModel((current) => {
                    const blocks = mapResultBlocks(current.blocks, current.result, result)
                    return {
                      ...current,
                      result,
                      blocks,
                      unresolvedCount: unresolvedCount(blocks),
                    }
                  })
                }
                language={language}
                ariaLabel="Sync RESULT"
                onEditorMount={mountDecoratedEditor(
                  resultEditor,
                  model.result,
                  resultChanges(model),
                )}
              />
            </div>
            <div className={styles['conflict-pane']} data-mobile-active={mobileSide === 'remote'}>
              <div className={styles['conflict-pane-label']}>REMOTE</div>
              <div className={styles['conflict-pane-body']}>
                <div className="merge-action-rail" aria-label="远程冲突操作">
                  {model.blocks.map((block, blockIndex) => (
                    <ActionButtons
                      key={block.id}
                      block={block}
                      side="remote"
                      number={blockIndex + 1}
                      onApply={applySide}
                      onIgnore={ignoreSide}
                      onReset={resetSide}
                    />
                  ))}
                </div>
                <MonacoTextEditor
                  className={styles['conflict-pane-editor']}
                  value={conflict.theirs ?? ''}
                  onChange={() => undefined}
                  language={language}
                  ariaLabel="Sync REMOTE"
                  readOnly
                  options={{ lineNumbers: 'on' }}
                  onEditorMount={mountDecoratedEditor(
                    remoteEditor,
                    conflict.theirs ?? '',
                    sideChanges(model, 'remote'),
                  )}
                />
              </div>
            </div>
          </div>
        </>
      )}

      <footer className={styles['conflict-editor-footer']}>
        <Button size="sm" variant="secondary" onClick={onAbort} disabled={saving}>
          放弃合并
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() => onSave(conflict.path, model.result)}
          disabled={saving || model.unresolvedCount > 0}
        >
          {saving ? '保存中…' : total > 1 ? '保存并继续' : '保存并完成合并'}
        </Button>
      </footer>
    </section>
  )
}
