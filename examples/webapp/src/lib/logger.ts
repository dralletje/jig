export type Level = "debug" | "info" | "warn";

export default function createLogger(scope: string, level: Level) {
  return {
    info(message: string) {
      if (level !== "warn") console.log(`[${scope}] ${message}`);
    },
    warn(message: string) {
      console.warn(`[${scope}] ${message}`);
    },
  };
}
