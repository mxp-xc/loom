import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type PageLayoutVariant = 'content' | 'workbench' | 'fullHeight'

const variantClassName = {
  content: 'page-layout--content',
  workbench: 'page-layout--workbench',
  fullHeight: 'page-layout--full-height',
} satisfies Record<PageLayoutVariant, string>

export function PageLayout({
  variant,
  className,
  children,
}: {
  variant: PageLayoutVariant
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn('page-layout', variantClassName[variant], className)}
      data-page-layout={variant}
    >
      {children}
    </div>
  )
}
