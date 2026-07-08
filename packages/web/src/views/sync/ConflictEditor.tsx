import { useEffect, useRef, useState } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { EditorState, RangeSetBuilder } from '@codemirror/state'
import { Decoration, GutterMarker, gutter } from '@codemirror/view'
import { yaml } from '@codemirror/lang-yaml'
import { Button } from '@/components/ui/button'
import type { GitConflictFile } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  applyBlockSide,
  buildMergeModel,
  ignoreBlockSide,
  resetBlockSide,
  type BlockSide,
  type BlockDecision,
  type MergeChange,
  type MergeBlock,
  type MergeModel,
} from './merge-model'
import styles from './ConflictEditor.module.css'

interface Props {
  conflict: GitConflictFile
  index: number
  total: number
  saving: boolean
  onSave: (path: string, result: string) => void
  onAbort: () => void
}

const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--text)', fontSize: '12px' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-content': { fontFamily: "'JetBrains Mono', monospace", minHeight: '260px' },
  '.cm-gutters': { backgroundColor: 'var(--card)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
})

function extensions(readOnly = false) {
  return [
    basicSetup,
    yaml(),
    editorTheme,
    ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
  ]
}

type VisualChangeKind = 'stable' | 'conflict' | 'applied' | 'ignored'

class BlockActionsMarker extends GutterMarker {
  elementClass = 'merge-action-gutter-cell'

  constructor(
    private block: MergeBlock,
    private side: BlockSide,
    private number: number,
    private apply: (id: string, side: BlockSide) => void,
    private ignore: (id: string, side: BlockSide) => void,
    private reset: (id: string, side: BlockSide) => void,
  ) {
    super()
  }

  eq(other: GutterMarker) {
    return (
      other instanceof BlockActionsMarker && other.block === this.block && other.side === this.side
    )
  }

  toDOM() {
    const label = this.side === 'local' ? '本地' : '远程'
    const state = this.side === 'local' ? this.block.localState : this.block.remoteState
    const host = document.createElement('span')
    host.className = 'merge-line-number-action'

    const actions = document.createElement('span')
    actions.className = `merge-block-actions is-${state}`

    const applyButton = document.createElement('button')
    applyButton.type = 'button'
    applyButton.className = 'merge-block-action'
    applyButton.ariaLabel =
      state === 'applied'
        ? `${label}变更 ${this.number}：撤回应用`
        : `${label}变更 ${this.number}：应用到结果`
    applyButton.title = applyButton.ariaLabel
    applyButton.textContent = state === 'applied' ? '↶' : this.side === 'local' ? '→' : '←'
    applyButton.disabled = state === 'ignored'
    applyButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (state === 'applied') {
        this.reset(this.block.id, this.side)
      } else {
        this.apply(this.block.id, this.side)
      }
    })

    const ignoreButton = document.createElement('button')
    ignoreButton.type = 'button'
    ignoreButton.className = 'merge-block-action'
    ignoreButton.ariaLabel =
      state === 'ignored'
        ? `${label}变更 ${this.number}：撤回忽略`
        : `${label}变更 ${this.number}：忽略变更`
    ignoreButton.title = ignoreButton.ariaLabel
    ignoreButton.textContent = state === 'ignored' ? '↶' : '×'
    ignoreButton.disabled = state === 'applied'
    ignoreButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (state === 'ignored') {
        this.reset(this.block.id, this.side)
      } else {
        this.ignore(this.block.id, this.side)
      }
    })

    if (this.side === 'local') {
      actions.append(ignoreButton, applyButton)
    } else {
      actions.append(applyButton, ignoreButton)
    }
    host.append(actions)
    return host
  }
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

function visualKind(change: MergeChange, blocks: MergeBlock[], side: BlockSide): VisualChangeKind {
  if (change.kind === 'stable') return 'stable'
  const block = blocks.find((candidate) => {
    const range = sideRange(candidate, side)
    return overlaps(change.from, change.to, range.from, range.to)
  })
  const state = block ? sideState(block, side) : 'pending'
  return state === 'applied' || state === 'ignored' ? state : 'conflict'
}

function sideDecorations(
  changes: MergeChange[],
  blocks: MergeBlock[],
  side: BlockSide,
  apply: (id: string, side: BlockSide) => void,
  ignore: (id: string, side: BlockSide) => void,
) {
  return EditorView.decorations.compute([], (state) => {
    const decorations = changes.flatMap((change) => {
      const kind = visualKind(change, blocks, side)
      const firstLine = state.doc.lineAt(Math.min(change.from, state.doc.length)).number
      const lastPosition = change.to > change.from ? change.to : change.from
      const lastLine = state.doc.lineAt(Math.min(lastPosition, state.doc.length)).number
      const lines = []
      for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
        lines.push(
          Decoration.line({ class: `merge-change merge-change-${kind}` }).range(
            state.doc.line(lineNumber).from,
          ),
        )
      }
      return lines
    })
    return Decoration.set(decorations, true)
  })
}

function actionGutter(
  blocks: MergeBlock[],
  side: BlockSide,
  apply: (id: string, side: BlockSide) => void,
  ignore: (id: string, side: BlockSide) => void,
  reset: (id: string, side: BlockSide) => void,
) {
  return gutter({
    class: 'merge-action-gutter',
    side: side === 'local' ? 'after' : 'before',
    markers: (view) => {
      const builder = new RangeSetBuilder<GutterMarker>()
      blocks.forEach((block, index) => {
        const position = Math.min(
          side === 'local' ? block.localTo : block.remoteTo,
          view.state.doc.length,
        )
        const line = view.state.doc.lineAt(position)
        builder.add(
          line.from,
          line.from,
          new BlockActionsMarker(block, side, index + 1, apply, ignore, reset),
        )
      })
      return builder.finish()
    },
  })
}

export default function ConflictEditor({ conflict, index, total, saving, onSave, onAbort }: Props) {
  const localHost = useRef<HTMLDivElement>(null)
  const resultHost = useRef<HTMLDivElement>(null)
  const remoteHost = useRef<HTMLDivElement>(null)
  const resultView = useRef<EditorView | null>(null)
  const syncingResult = useRef(false)
  const [mobileSide, setMobileSide] = useState<'local' | 'result' | 'remote'>('result')
  const [model, setModel] = useState<MergeModel>(() =>
    buildMergeModel(conflict.base ?? '', conflict.ours ?? '', conflict.theirs ?? ''),
  )

  useEffect(() => {
    setModel(buildMergeModel(conflict.base ?? '', conflict.ours ?? '', conflict.theirs ?? ''))
    setMobileSide('result')
  }, [conflict])

  const applySide = (id: string, side: BlockSide) => {
    setModel((current) => applyBlockSide(current, id, side))
  }

  const ignoreSide = (id: string, side: BlockSide) => {
    setModel((current) => ignoreBlockSide(current, id, side))
  }

  const resetSide = (id: string, side: BlockSide) => {
    setModel((current) => resetBlockSide(current, id, side))
  }

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

  useEffect(() => {
    if (conflict.binary || !localHost.current || !remoteHost.current) return
    const local = new EditorView({
      doc: conflict.ours ?? '',
      parent: localHost.current,
      extensions: [
        ...extensions(true),
        sideDecorations(model.changes.local, model.blocks, 'local', applySide, ignoreSide),
        actionGutter(model.blocks, 'local', applySide, ignoreSide, resetSide),
      ],
    })
    const remote = new EditorView({
      doc: conflict.theirs ?? '',
      parent: remoteHost.current,
      extensions: [
        ...extensions(true),
        sideDecorations(model.changes.remote, model.blocks, 'remote', applySide, ignoreSide),
        actionGutter(model.blocks, 'remote', applySide, ignoreSide, resetSide),
      ],
    })
    return () => {
      local.destroy()
      remote.destroy()
    }
  }, [conflict, model.blocks])

  useEffect(() => {
    if (!resultHost.current || conflict.binary) return
    const view = new EditorView({
      doc: model.result,
      parent: resultHost.current,
      extensions: [
        ...extensions(),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || syncingResult.current) return
          setModel((current) => ({
            ...current,
            result: update.state.doc.toString(),
            blocks: current.blocks.map((block) => ({
              ...block,
              resultFrom: update.changes.mapPos(block.resultFrom, 1),
              resultTo: update.changes.mapPos(block.resultTo, -1),
            })),
          }))
        }),
      ],
    })
    resultView.current = view
    return () => {
      resultView.current = null
      view.destroy()
    }
  }, [conflict])

  useEffect(() => {
    const view = resultView.current
    if (!view || view.state.doc.toString() === model.result) return
    syncingResult.current = true
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: model.result } })
    syncingResult.current = false
  }, [model.result])

  const chooseBinaryFile = (value: string | null) =>
    setModel({
      result: value ?? '',
      blocks: [],
      changes: { local: [], remote: [] },
      unresolvedCount: 0,
    })

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
              <div ref={localHost} className={styles['conflict-pane-editor']} />
            </div>
            <div
              className={cn(styles['conflict-pane'], styles['is-result'])}
              data-mobile-active={mobileSide === 'result'}
            >
              <div className={styles['conflict-pane-label']}>
                <span>RESULT</span>
                <span>{model.unresolvedCount} 个待处理冲突</span>
              </div>
              <div ref={resultHost} className={styles['conflict-pane-editor']} />
            </div>
            <div className={styles['conflict-pane']} data-mobile-active={mobileSide === 'remote'}>
              <div className={styles['conflict-pane-label']}>REMOTE</div>
              <div ref={remoteHost} className={styles['conflict-pane-editor']} />
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
          onClick={() =>
            onSave(conflict.path, resultView.current?.state.doc.toString() ?? model.result)
          }
          disabled={saving || model.unresolvedCount > 0}
        >
          {saving ? '保存中…' : total > 1 ? '保存并继续' : '保存并完成合并'}
        </Button>
      </footer>
    </section>
  )
}
