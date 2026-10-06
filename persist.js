// The server's files on disk (D57): what it saves is split into pieces, and each piece is
// written on its own a moment after it changed, without holding up the event loop. A write
// goes to a .tmp file that is then renamed, so a file is always whole.
const fs = require('fs');
const path = require('path');

// delay: how long after a change its piece is written (more changes in that time ride along).
// onError(what, err): a write failed; the piece stays marked and goes out with the next write.
function createPersist({ delay = 500, onError = () => {} } = {}) {
  const pending = new Map(); // file -> { get, what }: changed and not written yet
  const busy = new Map(); // file -> the same, while it is being written
  const dirs = new Set(); // folders made already
  let timer = null;
  let epoch = 0; // goes up with every flushSync(): a write that began before one leaves the file to it
  let waiting = []; // idle() callers

  async function writeOne(file, entry) {
    const began = epoch;
    const value = entry.get();
    if (value === undefined) return fs.promises.rm(file, { force: true });
    const dir = path.dirname(file);
    if (!dirs.has(dir)) {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      dirs.add(dir);
    }
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    if (began !== epoch) return fs.promises.rm(tmp, { force: true });
    await fs.promises.rename(tmp, file);
  }

  function flush() {
    timer = null;
    for (const [file, entry] of pending) {
      if (busy.has(file)) continue; // it goes again once that write is done
      pending.delete(file);
      busy.set(file, entry);
      writeOne(file, entry)
        .catch((err) => {
          if (!pending.has(file)) pending.set(file, entry); // not rescheduled: a full disk would spin
          onError(entry.what, err);
        })
        .then(() => {
          const failed = pending.get(file) === entry;
          busy.delete(file);
          if (pending.has(file) && !failed) schedule();
          if (!busy.size) for (const done of waiting.splice(0)) done();
        });
    }
  }
  const schedule = () => (timer ||= setTimeout(flush, delay));

  // `file` changed. get() is called when it is written and returns what to store as JSON, or
  // undefined to remove the file. `what` names it in an error.
  function write(file, get, what) {
    pending.set(file, { get, what });
    schedule();
  }

  // Write everything that is waiting or under way, now and blocking: for shutdown, a crash and
  // the migration. A write still under way may land after this one with what it had (a moment
  // older); close() waits for idle() first, so only a crash can see that. strict: throw on the
  // first failure instead of reporting it.
  function flushSync({ strict = false } = {}) {
    clearTimeout(timer);
    timer = null;
    epoch++;
    const all = new Map([...busy, ...pending]);
    pending.clear();
    for (const [file, entry] of all) {
      try {
        const value = entry.get();
        if (value === undefined) {
          fs.rmSync(file, { force: true });
          continue;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = file + '.sync.tmp'; // not the name a write under way is using
        fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch (err) {
        if (strict) throw err;
        onError(entry.what, err);
      }
    }
  }

  // Resolves once no write is under way
  const idle = () => (busy.size ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve());

  return { write, flushSync, idle };
}

module.exports = { createPersist };
