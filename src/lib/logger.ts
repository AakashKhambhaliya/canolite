type LogArgs = Parameters<typeof console.log>;

export const logger = {
  debug: (...args: LogArgs) => console.debug(...args),
  info: (...args: LogArgs) => console.log(...args),
  warn: (...args: LogArgs) => console.warn(...args),
  error: (...args: LogArgs) => console.error(...args),
};
