import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// node-pty 1.1.0's public write discards transport completion. Keep its normal
// API intact and add a callback entry point for Passport's bounded input queue.
export async function patchPtyInput(root) {
  const { version } = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  assert.equal(version, "1.1.0", "Review the node-pty input completion patch");
  const patches = {
    "unixTerminal.js": [
      [
        "    UnixTerminal.prototype._write = function (data) {",
        `    UnixTerminal.prototype.passportWrite = function (data, callback) {
        this._writeStream.write(data, callback);
    };
    UnixTerminal.prototype._write = function (data) {`,
      ],
      [
        `        clearImmediate(this._writeImmediate);
        this._writeImmediate = undefined;
    };`,
        `        this._disposed = true;
        clearImmediate(this._writeImmediate);
        this._writeImmediate = undefined;
        var error = new Error('PTY input closed');
        this._writeQueue.splice(0).forEach(function (task) {
            if (task.callback) task.callback(error);
        });
    };`,
      ],
      [
        "    CustomWriteStream.prototype.write = function (data) {",
        `    CustomWriteStream.prototype.write = function (data, callback) {
        if (this._disposed) {
            if (callback) callback(new Error('PTY input closed'));
            return;
        }`,
      ],
      [
        "            this._writeQueue.push({ buffer: buffer, offset: 0 });",
        "            this._writeQueue.push({ buffer: buffer, offset: 0, callback: callback });",
      ],
      [
        `                this._processWriteQueue();
            }
        }
    };`,
        `                this._processWriteQueue();
            }
        } else if (callback) callback();
    };`,
      ],
      [
        "        fs.write(this._fd, task.buffer, task.offset, function (err, written) {",
        `        fs.write(this._fd, task.buffer, task.offset, function (err, written) {
            if (_this._disposed) return;`,
      ],
      [
        `                    _this._writeQueue.length = 0;
                    console.error('Unhandled pty write error', err);`,
        `                    _this._disposed = true;
                    _this._writeQueue.splice(0).forEach(function (pending) {
                        if (pending.callback) pending.callback(err);
                    });`,
      ],
      [
        "                _this._writeQueue.shift();",
        "                _this._writeQueue.shift();\n                if (task.callback) task.callback();",
      ],
    ],
    "windowsTerminal.js": [
      [
        "    WindowsTerminal.prototype._write = function (data) {",
        `    WindowsTerminal.prototype.passportWrite = function (data, callback) {
        this._deferNoArgs(function () { this._agent.inSocket.write(data, callback); });
    };
    WindowsTerminal.prototype._write = function (data) {`,
      ],
    ],
  };
  for (const [file, replacements] of Object.entries(patches)) {
    const filename = path.join(root, "lib", file);
    const original = (await fs.readFile(filename, "utf8")).replaceAll(
      "\r\n",
      "\n",
    );
    let source = original;
    const patched = source.includes("prototype.passportWrite =");
    for (const [before, after] of replacements) {
      if (patched)
        assert.ok(source.includes(after), `Review PTY input patch in ${file}`);
      if (source.includes(after)) {
        assert.equal(
          source.split(after).length,
          2,
          `Duplicate PTY input patch in ${file}`,
        );
        continue;
      }
      assert.equal(
        source.split(before).length,
        2,
        `Review PTY input patch in ${file}`,
      );
      source = source.replace(before, after);
    }
    if (source !== original) await fs.writeFile(filename, source);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await patchPtyInput(path.resolve("node_modules/node-pty"));
