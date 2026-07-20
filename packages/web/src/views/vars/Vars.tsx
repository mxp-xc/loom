import { RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useToast } from '@/hooks/useToast'
import { AgentChip } from '@/components/ui/AgentChip'
import { ErrorState } from '@/components/ErrorFeedback'
import { cn } from '@/lib/utils'
import type { VarsProfileId } from './profile-model'
import { useProfileVars } from './useProfileVars'
import VarsConfigModal, { type VarsModalState } from './VarsConfigModal'
import VarsProfileList from './VarsProfileList'
import VarsProfileTable from './VarsProfileTable'
import VarsResolvedView from './VarsResolvedView'
import styles from './Vars.module.css'

type VarsView = 'definitions' | 'resolved'

const profileIds: VarsProfileId[] = ['builtin', 'base', 'local']

function readStoredProfileId(repoPath: string): VarsProfileId {
  try {
    const stored = localStorage.getItem(`loom.vars.activeProfileId:${repoPath}`)
    return profileIds.includes(stored as VarsProfileId) ? (stored as VarsProfileId) : 'base'
  } catch (err) {
    console.error({ err }, 'Failed to read vars active profile')
    return 'base'
  }
}

export default function Vars({ repoPath }: { repoPath: string }) {
  const vars = useProfileVars(repoPath)
  const [activeProfileId, setActiveProfileIdState] = useState<VarsProfileId>(() =>
    readStoredProfileId(repoPath),
  )
  const [view, setView] = useState<VarsView>('definitions')
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState<VarsModalState | null>(null)
  const { showErrorToast } = useToast()

  const state = vars.state

  const setActiveProfileId = useCallback(
    (profileId: VarsProfileId) => {
      setActiveProfileIdState(profileId)
      try {
        localStorage.setItem(`loom.vars.activeProfileId:${repoPath}`, profileId)
      } catch (err) {
        console.error({ err }, 'Failed to store vars active profile')
      }
    },
    [repoPath],
  )

  useEffect(() => {
    if (!state) return
    if (!state.profiles.some((profile) => profile.id === activeProfileId)) {
      setActiveProfileId(
        state.profiles.some((profile) => profile.id === 'base')
          ? 'base'
          : (state.profiles[0]?.id ?? 'base'),
      )
    }
  }, [activeProfileId, setActiveProfileId, state])

  const activeProfile = useMemo(() => {
    if (!state) return null
    return (
      state.profiles.find((profile) => profile.id === activeProfileId) ??
      state.profiles.find((profile) => profile.id === 'base') ??
      state.profiles[0] ??
      null
    )
  }, [activeProfileId, state])

  if (vars.loading)
    return (
      <div className={styles['vars-page']}>
        <div className={styles['vars-state']} role="status">
          <RefreshCw className={styles['vars-spin']} size={20} />
          正在加载变量…
        </div>
      </div>
    )

  if (vars.error || !state || !activeProfile)
    return (
      <div className={styles['vars-page']}>
        <ErrorState
          title="变量加载失败"
          message="请检查变量配置后重试"
          detail={vars.error ?? (!state ? '变量数据为空' : undefined)}
          action={{ label: '重试', run: vars.reload }}
        />
      </div>
    )

  return (
    <div className={styles['vars-page']}>
      <header className={styles['vars-topbar']}>
        <div>
          <div className={styles['vars-eyebrow']}>Vars</div>
          <h1>变量配置</h1>
        </div>
        <div className={styles['vars-tabs']} aria-label="Vars 视图">
          <button
            type="button"
            aria-pressed={view === 'definitions'}
            className={view === 'definitions' ? styles.on : undefined}
            onClick={() => setView('definitions')}
          >
            配置管理
          </button>
          <button
            type="button"
            aria-pressed={view === 'resolved'}
            className={view === 'resolved' ? styles.on : undefined}
            onClick={() => setView('resolved')}
          >
            最终结果
          </button>
        </div>
        <div className={styles['vars-agent-view']}>
          <span className={styles['vars-agent-label']}>查看范围</span>
          <AgentChip
            state={vars.viewScope === 'default' ? 'on' : 'off'}
            color="var(--primary)"
            label="default"
            onClick={() => vars.setViewScope('default')}
          >
            default
          </AgentChip>
          <div className="agent-chips" aria-label="目标 agent">
            {vars.configuredAgents.map((agent) => (
              <AgentChip
                key={agent}
                agent={agent}
                state={vars.viewScope === agent ? 'on' : 'off'}
                disabled={Boolean(vars.matrixErrorsByAgent[agent])}
                tooltip={vars.matrixErrorsByAgent[agent]}
                onClick={() => {
                  vars.setActiveAgent(agent)
                  vars.setViewScope(agent)
                }}
              />
            ))}
          </div>
        </div>
      </header>

      {view === 'definitions' ? (
        <div className={styles['vars-shell']}>
          <VarsProfileList
            profiles={state.profiles}
            activeProfileId={activeProfile.id}
            onSelect={setActiveProfileId}
          />
          <main className={styles['vars-main']} aria-label="配置管理">
            <div className={styles['vars-section-head']}>
              <div>
                <div className={styles['vars-eyebrow']}>selected profile</div>
                <h2>{activeProfile.name}</h2>
                <p>{activeProfile.description}</p>
              </div>
              <div className={styles['vars-toolbar']}>
                {activeProfile.id === 'local' && (
                  <button
                    type="button"
                    className={styles['vars-ghost-action']}
                    onClick={() => vars.setShowAvailable((current) => !current)}
                  >
                    {vars.showAvailable ? '隐藏可配置项' : '显示可配置项'}
                  </button>
                )}
                <button
                  type="button"
                  className={styles['vars-primary-action']}
                  disabled={activeProfile.id === 'builtin'}
                  onClick={() => setModal({ kind: 'add' })}
                >
                  {activeProfile.id === 'base' ? '新建变量' : '新建配置'}
                </button>
              </div>
            </div>
            <label className={styles['vars-search']}>
              <Search size={14} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索当前列表"
              />
            </label>
            <VarsProfileTable
              entries={activeProfile.entries}
              search={search}
              showAgentSlots={vars.configuredAgents.length > 0}
              onView={(entry) => setModal({ kind: 'view', entry })}
              onEdit={(entry) => setModal({ kind: 'edit', entry })}
              onAdd={(entry) => setModal({ kind: 'add', entry })}
              onClear={(entry) => {
                setModal({ kind: 'edit', entry })
              }}
            />
          </main>
        </div>
      ) : (
        <VarsResolvedView rows={state.resolvedRows} />
      )}

      {modal && (
        <VarsConfigModal
          repoPath={repoPath}
          modal={modal}
          profile={activeProfile}
          baseEntries={state.profiles.find((profile) => profile.id === 'base')?.entries ?? []}
          viewScope={vars.viewScope}
          definitionMatrix={state.definitionMatrix}
          matricesByAgent={vars.matricesByAgent}
          agents={vars.configuredAgents.filter((agent) => !vars.matrixErrorsByAgent[agent])}
          onClose={() => setModal(null)}
          onSaved={vars.reload}
          onError={(message) =>
            showErrorToast(new Error(message), {
              title: '变量配置操作失败',
              message: '请检查输入后重试',
            })
          }
        />
      )}
    </div>
  )
}
