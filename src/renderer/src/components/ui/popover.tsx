import * as PopoverPrimitive from '@radix-ui/react-popover'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
/** Positions the popover against an element without making it a toggle (for a text box). */
export const PopoverAnchor = PopoverPrimitive.Anchor

export function PopoverContent({ className, align = 'end', sideOffset = 6, ...props }: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-lg border border-border bg-surface p-1 text-sm shadow-[0_2px_8px_rgba(0,0,0,0.08)] outline-none',
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}
