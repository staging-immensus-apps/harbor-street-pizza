import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn's class combiner: conditional classes, Tailwind conflicts resolved. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
