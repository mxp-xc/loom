export type LogContext = Record<string, unknown>

export interface LoggerPort {
  error(message: string, context?: LogContext): void
  warn?(message: string, context?: LogContext): void
  info?(message: string, context?: LogContext): void
}
