/**
 * Simple Logger Utility
 * Provides consistent logging across services
 */

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  public info(message: string, ...args: any[]): void {
    console.log(`[INFO] [${this.context}] ${message}`, ...args);
  }

  public debug(message: string, ...args: any[]): void {
    console.log(`[DEBUG] [${this.context}] ${message}`, ...args);
  }

  public warn(message: string, ...args: any[]): void {
    console.warn(`[WARN] [${this.context}] ${message}`, ...args);
  }

  public error(message: string, ...args: any[]): void {
    console.error(`[ERROR] [${this.context}] ${message}`, ...args);
  }
}

/**
 * Shared logger instance.
 *
 * `logger.utils.ts` re-exports this as the canonical `logger`, which 187 modules
 * import. Without it every `import { logger }` resolves to `undefined` and the
 * first `logger.info(...)` throws at runtime.
 */
export const logger = new Logger('app');
