import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const alertVariants = cva('rounded-lg p-3 text-sm', {
  variants: {
    variant: {
      default: 'bg-secondary text-secondary-foreground',
      destructive: 'border border-destructive/50 text-destructive',
    },
  },
  defaultVariants: { variant: 'default' },
})

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant, className }))} {...props} />
))
Alert.displayName = 'Alert'

export { Alert, alertVariants }
