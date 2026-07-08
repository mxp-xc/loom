import { RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useToast } from '@/hooks/useToast'
import { AGENTS, agentColor, agentShort } from '../../lib/agents'
import type { VarsProfileId, VarsProfileEntry } from './profile-model'
import { useProfileVars } from './useProfileVars'
import VarsConfigModal, { type VarsModalState } from './VarsConfigModal'
import VarsProfileList from './VarsProfileList'
import VarsProfileTable from './VarsProfileTable'
import VarsResolvedView from './VarsResolvedView'
import './vars.css'

type VarsView = 'definitions' | 'resolved'

export default function Vars({ repoPath }: { repoPath: string }) {
  const vars = useProfileVars(repoPath)
  const [activeProfileId, setActiveProfileId] = useState<VarsProfileId>('local')
  const [view, setView] = useState<VarsView>('definitions')
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState<VarsModalState | null>(null)
  const { showToast } = useToast()

  const state = vars.state

  useEffect(() => {
    if (!state) return
    if (!state.profiles.some((profile) => profile.id === activeProfileId)) {
      setActiveProfileId(state.profiles[0]?.id ?? 'local')
    }
  }, [activeProfileId, state])

  const activeProfile = useMemo(() => {
    if (!state) return null
    return (
      state.profiles.find((profile) => profile.id === activeProfileId) ??
      state.profiles.find((profile) => profile.id === 'local') ??
      state.profiles[0] ??
      null
    )
  }, [activeProfileId, state])

  if (vars.loading)
    return (
      <div className="vars-page">
        <div className="vars-state" role="status">
          <RefreshCw className="vars-spin" size={20} />
          正在加载变量…
        </div>
      </div>
    )

  if (vars.error || !state || !activeProfile)
    return (
      <div className="vars-page">
        <div className="vars-state vars-error" role="alert">
          <strong>变量加载失败</strong>
          <span>{vars.error ?? '变量数据为空'}</span>
          <button type="button" onClick={() => void vars.reload()}>
            重试
          </button>
        </div>
      </div>
    )

  return (
    <div className="vars-page">
      <header className="vars-topbar">
        <div>
          <div className="vars-eyebrow">Vars</div>
          <h1>变量配置</h1>
        </div>
        <div className="vars-tabs" aria-label="Vars 视图">
          <button
            type="button"
            aria-pressed={view === 'definitions'}
            className={view === 'definitions' ? 'on' : ''}
            onClick={() => setView('definitions')}
          >
            配置管理
          </button>
          <button
            type="button"
            aria-pressed={view === 'resolved'}
            className={view === 'resolved' ? 'on' : ''}
            onClick={() => setView('resolved')}
          >
            最终结果
          </button>
        </div>
        <div className="cfg-chips" aria-label="目标 agent">
          {AGENTS.map((agent) => (
            <button
              key={agent}
              type="button"
              className={'achip' + (vars.activeAgent === agent ? ' on' : ' off')}
              data-a={agent === 'claude-code' ? 'cc' : agent === 'codex' ? 'cx' : 'oc'}
              style={{ ['--c' as string]: agentColor[agent] }}
              onClick={() => vars.setActiveAgent(agent)}
            >
              {agentShort[agent]}
            </button>
          ))}
        </div>
      </header>

      {view === 'definitions' ? (
        <div className="vars-shell">
          <VarsProfileList
            profiles={state.profiles}
            activeProfileId={activeProfile.id}
            onSelect={setActiveProfileId}
          />
          <main className="vars-main" aria-label="配置管理">
            <div className="vars-section-head">
              <div>
                <div className="vars-eyebrow">selected profile</div>
                <h2>{activeProfile.name}</h2>
                <p>{activeProfile.description}</p>
              </div>
              <div className="vars-toolbar">
                {activeProfile.id === 'local' && (
                  <button
                    type="button"
                    className="vars-ghost-action"
                    onClick={() => vars.setShowAvailable((current) => !current)}
                  >
                    {vars.showAvailable ? '隐藏可配置项' : '显示可配置项'}
                  </button>
                )}
                <button
                  type="button"
                  className="vars-primary-action"
                  disabled={activeProfile.id === 'builtin'}
                  onClick={() => setModal({ kind: 'add' })}
                >
                  {activeProfile.id === 'base' ? '新建变量' : '新建配置'}
                </button>
              </div>
            </div>
            <label className="vars-search">
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
