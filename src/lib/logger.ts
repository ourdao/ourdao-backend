// SPDX-License-Identifier: MIT

/**
 * Minimal structured logger that respects the LOG_LEVEL environment variable.
 *
 * Unlike `console.debug`, messages are only emitted when the configured level
 * is at least as verbose as the call level. Output is a single JSON line so it
 * can be consumed by log aggregators and filtering tools.
 */

import { logLevel } from '../config.js'

const LEVELS: Record<string, number> = {
  silent: 0,
  fatal: 1,
  error: 2,
  warn: 3,
  info: 4,
  debug: 5,
  trace: 6,
}

const configuredLevel = logLevel(process.env, 'LOG_LEVEL', 'info')
const currentLevel: number = LEVELS[configuredLevel] ?? LEVELS.info ?? 0

function log(level: string, message: string, extra: Record<string, unknown> = {}) {
  if ((LEVELS[level] ?? 0) > currentLevel) return
  console.log(
    JSON.stringify({
      level,
      message,
      time: new Date().toISOString(),
      ...extra,
    })
  )
}

export const logger = {
  fatal: (message: string, extra?: Record<string, unknown>) => log('fatal', message, extra),
  error: (message: string, extra?: Record<string, unknown>) => log('error', message, extra),
  warn: (message: string, extra?: Record<string, unknown>) => log('warn', message, extra),
  info: (message: string, extra?: Record<string, unknown>) => log('info', message, extra),
  debug: (message: string, extra?: Record<string, unknown>) => log('debug', message, extra),
  trace: (message: string, extra?: Record<string, unknown>) => log('trace', message, extra),
}

/**
 * Truncate a Stellar address for logging, keeping the first and last 4 chars.
 */
export function formatAddress(address: string): string {
  if (address.length <= 12) return address
  return `${address.slice(0, 4)}...${address.slice(-4)}`
}
