import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-md border border-border bg-surface px-3 text-sm placeholder:text-muted',
        'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-primary',
        className
      )}
      {...props}
    />
  )
}
