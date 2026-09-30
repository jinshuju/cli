/**
 * Colour for the person at a terminal, and nothing for anyone else.
 *
 * A style exists only for a stream that is a terminal; a pipe gets none, so
 * what a script or an agent reads is byte-for-byte what it was. NO_COLOR
 * (https://no-color.org) keeps the terminal but drops the colour.
 *
 * The orange is the Jinshuju logo's, #FF8533. A terminal that does not say it
 * takes 24-bit colour gets the nearest of the 256.
 */
export type Style = {
  /** A section heading, and the name on the version line. */
  heading(text: string): string;
  /** What is there to be glanced at, not read: the version. */
  dim(text: string): string;
};

export const PLAIN: Style = { heading: (text) => text, dim: (text) => text };

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

export function styleFor(stream: { isTTY?: boolean }, env: Env = process.env): Style | undefined {
  if (!stream.isTTY) return undefined;
  if (env.NO_COLOR) return PLAIN;
  const orange = /^(truecolor|24bit)$/i.test(env.COLORTERM ?? '') ? '38;2;255;133;51' : '38;5;209';
  return {
    heading: (text) => `\x1b[${orange}m${text}\x1b[39m`,
    dim: (text) => `\x1b[90m${text}\x1b[39m`
  };
}
