import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'loom-button inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius)] text-sm font-medium transition-all duration-[var(--dur)] ease-[var(--ease)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--primary)] text-[var(--primary-fg)] hover:-translate-y-px hover:shadow-[0_0_12px_rgba(16,185,129,0.25)]',
        secondary:
          'border border-[var(--border)] bg-[var(--card)] text-[var(--text)] hover:bg-[var(--accent)]',
        ghost: 'text-[var(--muted)] hover:bg-[var(--accent)] hover:text-[var(--text)]',
        destructive: 'bg-[var(--error)] text-white hover:opacity-90',
      },
      size: { default: '', sm: '', xs: 'text-xs', lg: '' },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const buttonSizeStyles = {
  default: { height: 36, padding: '8px 16px' },
  sm: { height: 32, paddingInline: 12 },
  xs: { height: 28, paddingInline: 8 },
  lg: { height: 40, paddingInline: 24 },
} satisfies Record<string, React.CSSProperties>

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, style, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    const resolvedSize = size ?? 'default'
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        style={{ ...buttonSizeStyles[resolvedSize], ...style }}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'

export { buttonVariants }
