import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// Merges conditional class names, resolving Tailwind conflicts last-write-wins.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
