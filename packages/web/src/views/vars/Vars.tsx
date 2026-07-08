import { RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useToast } from '@/hooks/useToast'
import { AGENTS, agentColor, agentShort } from '../../lib/agents'
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
  const { showToast } = useToast()

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
        <div className={cn(styles['vars-state'], styles['vars-error'])} role="alert">
          <strong>变量加载失败</strong>
          <span>{vars.error ?? '变量数据为空'}</span>
          <button type="button" onClick={() => void vars.reload()}>
            重试
          </button>
        </div>
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
        <div className="target-chips" aria-label="目标 agent">
          {AGENTS.map((agent) => (
            <button
              key={agent}
              type="button"
              className="target-chip"
              data-state={vars.activeAgent === agent ? 'on' : 'off'}
              style={{ ['--c' as string]: agentColor[agent] }}
              onClick={() => vars.setActiveAgent(agent)}
            >
              {agentShort[agent]}
            </button>
          ))}
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
        <VarsResolvedView
          rows={state.resolvedRows}
          activeAgent={vars.activeAgent}
          onAgentChange={vars.setActiveAgent}
        />
      )}

      {modal && (
        <VarsConfigModal
          repoPath={repoPath}
          modal={modal}
          profile={activeProfile}
          baseEntries={state.profiles.find((profile) => profile.id === 'base')?.entries ?? []}
          activeAgent={vars.activeAgent}
          activeMatrix={state.activeMatrix}
          matricesByAgent={vars.matricesByAgent!}
          setPending={vars.setPending}
          onClose={() => setModal(null)}
          onSaved={vars.reload}
          onError={showToast}
        />
      )}
    </div>
  )
}
