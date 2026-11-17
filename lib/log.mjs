// Логи в файл: дублирует console.* в data/logs/app-YYYY-MM-DD.log.
import fs from "node:fs";
import path from "node:path";

const pad = (n) => String(n).padStart(2, "0");

function stamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatArg(a) {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function cleanup(dir, retainDays) {
  try {
    const cutoff = Date.now() - retainDays * 86400_000;
    for (const f of fs.readdirSync(dir)) {
      if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const full = path.join(dir, f);
      if (fs.statSync(full).mtimeMs < cutoff) {
        try {
          fs.unlinkSync(full);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

export function attachFileLog(dir, { retainDays = 14 } = {}) {
  fs.mkdirSync(dir, { recursive: true });

  let stream = null;
  let current = null;

  const openFor = (date) => {
    const file = path.join(dir, `app-${stamp(date)}.log`);
    if (file === current && stream) return;
    try {
      if (stream) stream.end();
    } catch {
      /* ignore */
    }
    current = file;
    stream = fs.createWriteStream(file, { flags: "a" });
    stream.on("error", () => {
      stream = null;
    });
  };

  const write = (level, args) => {
    const now = new Date();
    openFor(now);
    const line = `${now.toISOString()} [${level}] ${args.map(formatArg).join(" ")}\n`;
    try {
      stream.write(line);
    } catch {
      /* ignore */
    }
  };

  const original = {};
  for (const level of ["log", "info", "warn", "error"]) {
    original[level] = console[level].bind(console);
    console[level] = (...args) => {
      write(level, args);
      original[level](...args);
    };
  }

  process.on("uncaughtException", (err) => {
    write("fatal", [err instanceof Error ? err.stack : String(err)]);
    original.error(err);
    process.exitCode = 1;
  });
  process.on("unhandledRejection", (err) => {
    write("fatal", [`unhandledRejection: ${err instanceof Error ? err.stack : String(err)}`]);
  });

  cleanup(dir, retainDays);
  return path.join(dir, `app-${stamp()}.log`);
}
