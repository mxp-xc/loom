import { Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { VarsProfileId, VarsProfileSummary } from './profile-model'
import styles from './Vars.module.css'

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
    <aside className={styles['vars-profiles']} aria-label="Profiles">
      <div className={styles['vars-pane-head']}>
        <div>
          <div className={styles['vars-eyebrow']}>Profiles</div>
          <h2>配置范围</h2>
        </div>
        <button
          type="button"
          className={styles['vars-icon-button']}
          aria-label="新建 profile（稍后接入）"
          title="新建 profile（稍后接入）"
          disabled
        >
          <Plus size={15} />
        </button>
      </div>

      <div className={styles['vars-profile-list']}>
        {profiles.map((profile) => (
          <button
            key={profile.id}
            type="button"
            className={styles['vars-profile']}
            aria-current={profile.id === activeProfileId}
            onClick={() => onSelect(profile.id)}
          >
            <span className={styles['vars-profile-main']}>
              <span className={styles['vars-profile-title']}>
                <strong>{profile.name}</strong>
                <span className={cn(styles['vars-kind'], styles[profile.kindBadge])}>
                  {profile.kindBadge}
                </span>
              </span>
              <span className={styles['vars-profile-meta']}>{profile.description}</span>
            </span>
            <span className={styles['vars-count']}>{profile.configuredCount}</span>
          </button>
        ))}
      </div>

      {activeProfile && (
        <section className={styles['vars-profile-card']} aria-label="profile 操作">
          <div>
            <div className={styles['vars-eyebrow']}>profile 操作</div>
            <h3>{activeProfile.name}</h3>
            <p>{activeProfile.description}</p>
          </div>
          <div className={styles['vars-profile-actions']}>
            {activeProfile.locked ? (
              <span className={styles['vars-lock-state']}>
                <Lock size={13} />
                locked
              </span>
            ) : (
              <>
                <button
                  type="button"
                  className={styles['vars-icon-button']}
                  aria-label="重命名当前 profile"
                  title="重命名"
                  disabled
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className={styles['vars-icon-button']}
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
