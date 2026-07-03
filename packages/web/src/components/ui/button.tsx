import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius)] text-sm font-medium transition-all duration-[var(--dur)] ease-[var(--ease)] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--ring)_25%,transparent)] disabled:pointer-events-none disabled:opacity-50',
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
      size: { default: 'h-9 px-4 py-2', sm: 'h-8 px-3', xs: 'h-7 px-2 text-xs', lg: 'h-10 px-6' },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    )
  },
)
Button.displayName = 'Button'

export { buttonVariants }
