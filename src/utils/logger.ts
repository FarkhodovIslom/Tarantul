
import pino, { type LoggerOptions } from "pino";

const opts: LoggerOptions = {
  name: "tarantul",
  level: process.env["LOG_LEVEL"] ?? "info",
};

if (process.env["NODE_ENV"] !== "production") {
  opts.transport = {
    target: "pino-pretty",
    options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
  };
}

export const logger = pino(opts);
