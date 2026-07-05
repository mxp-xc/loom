import { Braces, MousePointer2, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useVars } from '../../hooks/useVars'
import Modal from '../../components/Modal'
import Toast from '../../components/Toast'
import { Button } from '../../components/ui/button'
import EnvironmentSidebar from './EnvironmentSidebar'
import VariableList from './VariableList'
import VariableEditor from './VariableEditor'
import { ApiError, api } from '../../lib/api'
import type { DeleteImpact, VarEntryInput } from '../../lib/vars'
import DeleteVariableDialog from './DeleteVariableDialog'
import './vars.css'

export default function Vars({ repoPath }: { repoPath: string }) {
  const vars = useVars(repoPath)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [environmentName, setEnvironmentName] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [creatingVariable, setCreatingVariable] = useState(false)
  const [savingVariable, setSavingVariable] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameKey, setRenameKey] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [renameDiagnostics, setRenameDiagnostics] = useState<
    import('../../lib/vars').VarsDiagnostic[]
  >([])
  const [actionPending, setActionPending] = useState(false)
  const [deleteImpact, setDeleteImpact] = useState<DeleteImpact | null>(null)
  const [deleteChanged, setDeleteChanged] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  useEffect(() => {
    setSelectedKey(null)
    setCreatingVariable(false)
  }, [vars.selectedEnvironment])

  const saveVariable = async (key: string, entry: VarEntryInput) => {
    if (!vars.selectedEnvironment) return
    setSavingVariable(true)
    try {
      await api.vars.setVariable(repoPath, vars.selectedEnvironment, key, entry)
      await vars.refreshCurrent()
      setSelectedKey(key)
      setCreatingVariable(false)
      setToast(`变量 ${key} 已保存`)
    } finally {
      setSavingVariable(false)
    }
  }
  const validateDraft = useCallback(
    (key: string, entry: VarEntryInput) => {
      if (!vars.selectedEnvironment) return Promise.reject(new Error('未选择变量环境'))
      return api.vars.validateDraft(
        repoPath,
        vars.previewChain,
        vars.selectedEnvironment,
        key,
        entry,
      )
    },
    [repoPath, vars.previewChain, vars.selectedEnvironment],
  )

  const openDelete = async () => {
    if (!selectedKey || !vars.selectedEnvironment) return
    setDeleteImpact(null)
    setDeleteChanged(false)
    setDeleteError(null)
    try {
      const result = await api.vars.inspectVariableDelete(
        repoPath,
        vars.selectedEnvironment,
        selectedKey,
      )
      setDeleteImpact(result.impact)
    } catch (cause) {
      console.error('Failed to inspect variable delete', cause)
      setDeleteError('删除影响检查失败')
      setToast('删除失败：删除影响检查失败')
    }
  }
  const confirmDelete = async () => {
    if (!selectedKey || !vars.selectedEnvironment || !deleteImpact) return
    setActionPending(true)
    setDeleteError(null)
    try {
      await api.vars.deleteVariable(repoPath, vars.selectedEnvironment, selectedKey, {
        confirmed: true,
        impactToken: deleteImpact.impactToken,
      })
      const deletedKey = selectedKey
      setDeleteImpact(null)
      setSelectedKey(null)
      setToast(`变量 ${deletedKey} 已删除`)
      try {
        await vars.refreshCurrent()
      } catch (refreshError) {
        console.error('Failed to refresh vars after deleting variable', refreshError)
        setToast(`变量 ${deletedKey} 已删除，刷新失败`)
      }
    } catch (cause) {
      console.error('Failed to delete variable', cause)
      if (cause instanceof ApiError && cause.code === 'impact_changed') {
        const impact = cause.details?.deleteImpact as DeleteImpact | undefined
        if (impact) setDeleteImpact(impact)
        else
          try {
            setDeleteImpact(
              (
                await api.vars.inspectVariableDelete(
                  repoPath,
                  vars.selectedEnvironment,
                  selectedKey,
                )
              ).impact,
            )
          } catch (refreshError) {
            console.error('Failed to refresh variable delete impact', refreshError)
          }
        setDeleteChanged(true)
        setDeleteError(cause.diagnostics?.map((item) => item.message).join('；') ?? null)
        setToast('删除失败：依赖已变化，请重新确认')
      } else {
        const message = cause instanceof ApiError ? cause.message : '变量删除失败'
        setDeleteError(
          cause instanceof ApiError && cause.diagnostics?.length
            ? cause.diagnostics.map((item) => item.message).join('；')
            : message,
        )
        setToast(`删除失败：${message}`)
      }
    } finally {
      setActionPending(false)
    }
  }
  const confirmRename = async (event: FormEvent) => {
    event.preventDefault()
    if (!selectedKey || !vars.selectedEnvironment) return
    const next = renameKey.trim()
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(next)) {
      setRenameError('变量名格式无效')
      return
    }
    setActionPending(true)
    setRenameError(null)
    setRenameDiagnostics([])
    try {
      await api.vars.renameVariable(repoPath, vars.selectedEnvironment, selectedKey, next)
      const previousKey = selectedKey
      setSelectedKey(next)
      setRenameOpen(false)
      setToast(`变量 ${previousKey} 已重命名为 ${next}`)
      try {
        await vars.refreshCurrent()
      } catch (refreshError) {
        console.error('Failed to refresh vars after renaming variable', refreshError)
        setToast(`变量 ${previousKey} 已重命名为 ${next}，刷新失败`)
      }
    } catch (cause) {
      console.error('Failed to rename variable', cause)
      setRenameError(
        cause instanceof ApiError && cause.code === 'variable_conflict'
          ? `变量 ${next} 已存在`
          : cause instanceof Error
            ? cause.message
            : '变量重命名失败',
      )
      if (cause instanceof ApiError) setRenameDiagnostics(cause.diagnostics ?? [])
      setToast(`重命名失败：${cause instanceof Error ? cause.message : '变量重命名失败'}`)
    } finally {
      setActionPending(false)
    }
  }

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault()
    const name = environmentName.trim()
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) || name.includes('..')) {
      setValidationError('环境名称格式无效')
      return
    }
    setValidationError(null)
    if ((await vars.createEnvironment(name)) !== 'failed') {
      setCreateOpen(false)
      setEnvironmentName('')
      setToast(`环境 ${name} 已创建`)
    }
  }

  let content: ReactNode
  if (vars.loading)
    content = (
      <div className="vars-state" role="status">
        <RefreshCw className="vars-spin" size={20} />
        正在加载变量环境…
      </div>
    )
  else if (vars.error && vars.environments.length === 0)
    content = (
      <div className="vars-state vars-error" role="alert">
        <strong>{vars.error}</strong>
        <span>请检查服务连接后重试。</span>
        <button type="button" onClick={() => void vars.reload()}>
          重试
        </button>
      </div>
    )
  else if (vars.environments.length === 0)
    content = (
      <div className="vars-state">
        <Braces size={22} />
        <strong>还没有变量环境</strong>
        <span>新建环境后即可组织多层配置。</span>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          新建环境
        </Button>
      </div>
    )
  else {
    const selectedEntry = selectedKey ? vars.environment?.entries[selectedKey] : undefined
    content = (
      <div className="vars-page">
        {vars.error && (
          <div className="vars-banner" role="alert">
            <span>{vars.error}</span>
            <button type="button" onClick={() => void vars.reload()}>
              重试
            </button>
          </div>
        )}
        {vars.resolutionError && (
          <div className="vars-banner" role="alert">
            <span>{vars.resolutionError}</span>
          </div>
        )}
        <div className="vars-grid">
          <EnvironmentSidebar
            environments={vars.environments}
            selected={vars.selectedEnvironment}
            previewChain={vars.previewChain}
            pending={vars.pending}
            onSelect={(name) => void vars.select(name)}
            onRemoveFromChain={vars.removeFromChain}
            onCreate={() => setCreateOpen(true)}
          />
          <VariableList
            entries={vars.environment?.entries ?? {}}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            diagnostics={vars.diagnostics.filter(
              (item) => item.environment === vars.selectedEnvironment,
            )}
          />
          <section className="vars-detail" aria-labelledby="vars-detail-title">
            <div className="vars-pane-heading">
              <div>
                <span className="vars-eyebrow">详情</span>
                <h2 id="vars-detail-title">变量配置</h2>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  setSelectedKey(null)
                  setCreatingVariable(true)
                }}
              >
                <Plus size={15} /> 新建变量
              </Button>
            </div>
            {creatingVariable || (selectedKey && selectedEntry) ? (
              <VariableEditor
                key={creatingVariable ? 'new' : (selectedKey ?? 'new')}
                initialKey={creatingVariable ? '' : (selectedKey ?? '')}
                entry={creatingVariable ? undefined : selectedEntry}
                resolution={vars.resolution}
                pending={savingVariable}
                onSave={saveVariable}
                warnings={vars.diagnostics.filter(
                  (item) =>
                    item.environment === vars.selectedEnvironment && item.key === selectedKey,
                )}
                onRename={() => {
                  setRenameKey(selectedKey ?? '')
                  setRenameError(null)
                  setRenameDiagnostics([])
                  setRenameOpen(true)
                }}
                onDelete={() => void openDelete()}
                validateDraft={validateDraft}
                onReveal={
                  selectedKey && selectedEntry?.type === 'secret' && vars.selectedEnvironment
                    ? async () =>
                        String(
                          (
                            await api.vars.revealVariable(
                              repoPath,
                              vars.selectedEnvironment!,
                              selectedKey,
                            )
                          ).entry.value,
                        )
                    : undefined
                }
              />
            ) : (
              <div className="vars-detail-placeholder">
                <MousePointer2 size={22} />
                <strong>选择一个变量</strong>
                <span>在此查看来源、类型与覆盖关系。</span>
              </div>
            )}
          </section>
        </div>
      </div>
    )
  }
  return (
    <>
      {content}
      <Modal
        open={createOpen}
        onClose={() => !vars.pending && setCreateOpen(false)}
        title="新建变量环境"
        busy={vars.pending}
      >
        <form onSubmit={(event) => void submitCreate(event)} className="vars-create-form">
          <label htmlFor="vars-environment-name">环境名称</label>
          <input
            id="vars-environment-name"
            data-autofocus
            value={environmentName}
            onChange={(event) => setEnvironmentName(event.target.value)}
            autoComplete="off"
          />
          {validationError && <p role="alert">{validationError}</p>}
          {vars.error && <p role="alert">{vars.error}</p>}
          {vars.pending && <p aria-live="polite">正在创建环境…</p>}
          <div className="vars-form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCreateOpen(false)}
              disabled={vars.pending}
            >
              取消
            </Button>
            <Button type="submit" disabled={vars.pending}>
              创建环境
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={renameOpen}
        onClose={() => !actionPending && setRenameOpen(false)}
        title="重命名变量"
        busy={actionPending}
      >
        <form className="vars-create-form" onSubmit={(event) => void confirmRename(event)}>
          <p>这会更新所有环境中的同名定义与引用。</p>
          <label htmlFor="vars-rename-key">新变量名</label>
          <input
            id="vars-rename-key"
            data-autofocus
            value={renameKey}
            disabled={actionPending}
            onChange={(event) => setRenameKey(event.target.value)}
          />
          {renameError && <p role="alert">{renameError}</p>}
          {renameDiagnostics.map((item, index) => (
            <p role="alert" key={`${item.code}-${index}`}>
              {item.message}
            </p>
          ))}
          <div className="vars-form-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={actionPending}
              onClick={() => setRenameOpen(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={actionPending}>
              {actionPending ? '正在重命名…' : '确认重命名'}
            </Button>
          </div>
        </form>
      </Modal>
      <DeleteVariableDialog
        variableKey={selectedKey ?? ''}
        open={deleteImpact !== null || deleteError !== null}
        impact={deleteImpact}
        pending={actionPending}
        changed={deleteChanged}
        error={deleteError}
        onClose={() => {
          setDeleteImpact(null)
          setDeleteError(null)
        }}
        onConfirm={() => void confirmDelete()}
      />
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </>
  )
}
