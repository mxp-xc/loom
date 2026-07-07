import { Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import type { VarsProfileId, VarsProfileSummary } from './profile-model'

type VarsProfileListProps = {
  profiles: VarsProfileSummary[]
  activeProfileId: VarsProfileId
  onSelect: (profileId: VarsProfileId) => void
}

export default function VarsProfileList({
  profiles,
  activeProfileId,
  onSelect,
}: VarsProfileListProps) {
  const activeProfile =
    profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0] ?? null

  return (
    <aside className="vars-profiles" aria-label="Profiles">
      <div className="vars-pane-head">
        <div>
          <div className="vars-eyebrow">Profiles</div>
          <h2>配置范围</h2>
        </div>
        <button
          type="button"
          className="vars-icon-button"
          aria-label="新建 profile（稍后接入）"
          title="新建 profile（稍后接入）"
          disabled
        >
          <Plus size={15} />
        </button>
      </div>

      <div className="vars-profile-list">
        {profiles.map((profile) => (
          <button
            key={profile.id}
            type="button"
            className="vars-profile"
            aria-current={profile.id === activeProfileId}
            onClick={() => onSelect(profile.id)}
          >
            <span className="vars-profile-main">
              <span className="vars-profile-title">
                <strong>{profile.name}</strong>
                <span className={'vars-kind ' + profile.kindBadge}>{profile.kindBadge}</span>
              </span>
              <span className="vars-profile-meta">{profile.description}</span>
            </span>
            <span className="vars-count">{profile.configuredCount}</span>
          </button>
        ))}
      </div>

      {activeProfile && (
        <section className="vars-profile-card" aria-label="profile 操作">
          <div>
            <div className="vars-eyebrow">profile 操作</div>
            <h3>{activeProfile.name}</h3>
            <p>{activeProfile.description}</p>
          </div>
          <div className="vars-profile-actions">
            {activeProfile.locked ? (
              <span className="vars-lock-state">
                <Lock size={13} />
                locked
              </span>
            ) : (
              <>
                <button
                  type="button"
                  className="vars-icon-button"
                  aria-label="重命名当前 profile"
                  title="重命名"
                  disabled
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="vars-icon-button"
                  aria-label="删除当前 profile"
                  title="删除"
                  disabled
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </div>
        </section>
      )}
    </aside>
  )
}
