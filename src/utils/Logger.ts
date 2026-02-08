export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.ERROR]: "ERROR",
  [LogLevel.WARN]: "WARN",
  [LogLevel.INFO]: "INFO",
  [LogLevel.DEBUG]: "DEBUG",
};

class Logger {
  private level: LogLevel = LogLevel.INFO;

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private log(level: LogLevel, context: string, message: string, ...args: unknown[]): void {
    if (level > this.level) return;

    var levelName = LOG_LEVEL_NAMES[level];
    var tick = Game.time;

    var formattedMessage = "[" + tick + "] [" + levelName + "] [" + context + "] " + message;

    if (args.length > 0) {
      formattedMessage += " " + args.map(function(a) { return JSON.stringify(a); }).join(" ");
    }

    console.log(formattedMessage);
  }

  error(context: string, message: string, ...args: unknown[]): void {
    this.log(LogLevel.ERROR, context, message, ...args);
  }

  warn(context: string, message: string, ...args: unknown[]): void {
    this.log(LogLevel.WARN, context, message, ...args);
  }

  info(context: string, message: string, ...args: unknown[]): void {
    this.log(LogLevel.INFO, context, message, ...args);
  }

  debug(context: string, message: string, ...args: unknown[]): void {
    this.log(LogLevel.DEBUG, context, message, ...args);
  }
}

export const logger = new Logger();
