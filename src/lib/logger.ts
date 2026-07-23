import pino from "pino";

export type Logger = pino.Logger;

const isDev = process.env.NODE_ENV !== "production";

/** Centralized logger (AGENTS.md): all server-side logging goes through this module. */
export const logger: Logger = pino(
  isDev
    ? {
        level: "debug",
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }
    : { level: "info" },
);

/** Child logger tagged with a module name, e.g. `createLogger("quota")`. */
export function createLogger(module: string): Logger {
  return logger.child({ module });
}
