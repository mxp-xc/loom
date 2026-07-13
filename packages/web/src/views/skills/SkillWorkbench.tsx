import { useState, type ReactNode } from 'react'
import styles from './SkillWorkbench.module.css'

interface SkillWorkbenchProps {
  configuration: ReactNode
  results: ReactNode
  footer: ReactNode
  resultCount?: number
  className?: string
}

export default function SkillWorkbench({
  configuration,
  results,
  footer,
  resultCount = 0,
  className = '',
}: SkillWorkbenchProps) {
  const [mobilePane, setMobilePane] = useState<'configuration' | 'skills'>('configuration')

  return (
    <div className={`${styles.workbench} ${className}`} data-testid="skills-workbench">
      <div className={styles.mobileTabs} role="tablist" aria-label="Workbench pane">
        <button
          type="button"
          role="tab"
          aria-selected={mobilePane === 'configuration'}
          onClick={() => setMobilePane('configuration')}
        >
          Configuration
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mobilePane === 'skills'}
          onClick={() => setMobilePane('skills')}
        >
          Skills <span>{resultCount}</span>
        </button>
      </div>
      <div className={styles.body}>
        <section
          className={styles.configuration}
          data-testid="skills-config-pane"
          data-mobile-visible={mobilePane === 'configuration'}
        >
          {configuration}
        </section>
        <section
          className={styles.results}
          data-testid="skills-results-pane"
          data-mobile-visible={mobilePane === 'skills'}
        >
          {results}
        </section>
      </div>
      <footer className={styles.footer}>{footer}</footer>
    </div>
  )
}

export function SkillWorkbenchTitle({
  icon,
  eyebrow,
  title,
}: {
  icon: ReactNode
  eyebrow: string
  title: string
}) {
  return (
    <span className={styles.title}>
      <span className={styles.titleIcon}>{icon}</span>
      <span>
        <small>{eyebrow}</small>
        <h1>{title}</h1>
      </span>
    </span>
  )
}
