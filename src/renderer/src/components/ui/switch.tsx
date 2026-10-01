import * as SwitchPrimitive from '@radix-ui/react-switch'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors duration-150',
        'bg-border data-[state=checked]:bg-primary disabled:opacity-50',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'block size-4 rounded-full transition-transform duration-150',
          'bg-muted data-[state=checked]:translate-x-4 data-[state=checked]:bg-primary-foreground'
        )}
      />
    </SwitchPrimitive.Root>
  )
}
