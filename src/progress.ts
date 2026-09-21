/**
 * Progress for the person watching, and nothing for anyone else.
 *
 * It writes to stderr and only when stderr is a terminal. That is what lets a
 * command say "uploading…" to someone waiting at a prompt while `--output json
 * | jq` stays byte-for-byte what it was, and while an agent reading the pipe
 * sees no decoration it would have to strip.
 *
 * A step overwrites the line before it, so a long run stays one line rather
 * than a scroll of near-identical ones. done() clears whatever is left.
 */
export interface Progress {
  step(message: string): void;
  done(): void;
}

const SILENT: Progress = { step: () => {}, done: () => {} };

export function progress(stream: NodeJS.WriteStream = process.stderr): Progress {
  if (!stream.isTTY) return SILENT;

  let width = 0;
  return {
    step(message: string) {
      stream.write(`\r${' '.repeat(width)}\r${message}`);
      width = message.length;
    },
    done() {
      if (width > 0) stream.write(`\r${' '.repeat(width)}\r`);
      width = 0;
    }
  };
}
