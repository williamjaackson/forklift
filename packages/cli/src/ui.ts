const useColor =
  process.stdout.isTTY &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb";

const ansi = (code: string, text: string): string =>
  useColor ? `\x1b[${code}m${text}\x1b[0m` : text;

export const ui = {
  bold: (s: string) => ansi("1", s),
  dim: (s: string) => ansi("2", s),
  yellow: (s: string) => ansi("33", s),
  green: (s: string) => ansi("32", s),
  red: (s: string) => ansi("31", s),
  cyan: (s: string) => ansi("36", s),
  badge: (label: string) => ansi("1;30;43", ` ${label} `),
  ok: (s: string) => `${ansi("32", "✓")} ${s}`,
  warn: (s: string) => `${ansi("33", "!")} ${s}`,
  fail: (s: string) => `${ansi("31", "×")} ${s}`,
  step: (s: string) => `${ansi("33", "→")} ${s}`,
  lift: (s: string) => `${ansi("33", "⚡")} ${s}`,
};
