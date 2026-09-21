import test from 'node:test';
import assert from 'node:assert/strict';

import { progress } from './progress.js';

function fakeStream(isTTY: boolean) {
  const written: string[] = [];
  return {
    written,
    stream: { isTTY, write: (chunk: string) => { written.push(chunk); return true; } } as unknown as NodeJS.WriteStream
  };
}

test('progress says nothing at all when the stream is not a terminal', () => {
  const { written, stream } = fakeStream(false);
  const watching = progress(stream);

  watching.step('uploading…');
  watching.step('importing 1/3 rows…');
  watching.done();

  // Not "writes something harmless" — writes nothing, so a pipe carries
  // exactly the bytes it would have without any of this.
  assert.deepEqual(written, []);
});

test('progress overwrites its own line and clears after itself', () => {
  const { written, stream } = fakeStream(true);
  const watching = progress(stream);

  watching.step('read 1 page…');
  watching.step('read 2 pages…');
  watching.done();

  // Nothing shown yet, so the first step blanks nothing and just writes.
  assert.equal(written[0], '\r\rread 1 page…');
  // The second step blanks the first before writing, so the terminal never
  // shows the tail of a longer previous line.
  assert.ok(written[1].startsWith('\r' + ' '.repeat('read 1 page…'.length) + '\r'));
  assert.ok(written[1].endsWith('read 2 pages…'));
  // done() leaves the line empty rather than stranding the last step on screen.
  assert.equal(written[2], '\r' + ' '.repeat('read 2 pages…'.length) + '\r');
});

test('done does nothing when no step was ever shown', () => {
  const { written, stream } = fakeStream(true);

  progress(stream).done();

  assert.deepEqual(written, []);
});
