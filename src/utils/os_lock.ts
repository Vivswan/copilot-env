// The OS advisory lock under src/utils/file_lock.ts, through bun:ffi: flock from the system libc,
// LockFileEx from kernel32; no package, nothing compiled. A lock lives on an open handle (a bun fd
// on POSIX, a native HANDLE on Windows) that `release` alone lets go. `unsupported` is ONE thing:
// the library would not load (decided once per process, so the same for every process of this
// binary on the machine); a lock call the filesystem refuses (ENOLCK, EOPNOTSUPP, ENOSYS, ...)
// throws as the lock's own I/O, never a fallback. `busy` is another handle's hold. On Windows a
// LockFileEx range is mandatory (another handle's read of a locked byte fails EBUSY, even on an
// empty file), so the locked byte sits at 2^62 (WIN32_LOCK_OFFSET_HIGH): past any end of file a
// sidecar will have, inside the whole-file range the deno release's daemon holds on its sidecar.
import { dlopen, FFIType, type Pointer, ptr, read } from "bun:ffi";
import { closeSync, constants as fsConstants, openSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { toNamespacedPath } from "node:path";
import { isEnoentOrNotdir } from "./fs.ts";

export type OsLockHandle =
  | { readonly kind: "fd"; readonly fd: number }
  | { readonly kind: "win32"; readonly handle: bigint };

type OsLockExclusive =
  | { readonly kind: "locked"; readonly handle: OsLockHandle }
  | { readonly kind: "busy" }
  | { readonly kind: "unsupported"; readonly cause: unknown };

/** `absent` is a path with no file: the shared probe never creates one. */
type OsLockShared = OsLockExclusive | { readonly kind: "absent" };

/** The seam src/utils/file_lock.ts injects for a test that needs a machine whose libc will not
 *  load, or a filesystem that refuses the lock call, which no scratch directory can play. */
export interface OsLock {
  /** Opens the file (created when absent) read-write and try-locks it exclusively; a refused lock
   *  call throws. */
  tryExclusive(path: string): OsLockExclusive;
  /** Opens the file read-only and try-locks it shared: granted means nobody holds it exclusively;
   *  a refused lock call throws. */
  tryShared(path: string): OsLockShared;
  /** Unlocks and closes; a handle already closed is no error. */
  release(handle: OsLockHandle): void;
}

export type Loaded<T> =
  | { readonly kind: "loaded"; readonly symbols: T }
  | { readonly kind: "failed"; readonly cause: unknown };

function loadOnce<T>(load: () => T): () => Loaded<T> {
  let loaded: Loaded<T> | undefined;
  return () => {
    if (loaded === undefined) {
      try {
        loaded = { kind: "loaded", symbols: load() };
      } catch (cause) {
        loaded = { kind: "failed", cause };
      }
    }
    return loaded;
  };
}

// --- POSIX ---------------------------------------------------------------------------------

const LOCK_SH = 1;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

const ERRNO = osConstants.errno;
const ERRNO_NAMES = new Map(Object.entries(ERRNO).map(([name, value]) => [value, name]));
/** EWOULDBLOCK and EAGAIN share a number on Linux and macOS alike; both are kept so a platform
 *  where they differ still reads a holder as busy. */
const POSIX_BUSY = new Set([ERRNO.EWOULDBLOCK, ERRNO.EAGAIN]);

/** The two libc calls the POSIX adapter makes; exported so a test can drive the real adapter with
 *  a table whose `flock` fails the way a filesystem refuses the call. */
export interface PosixSymbols {
  flock(fd: number, operation: number): number;
  /** The calling thread's errno, read right after a failed call and before any other. */
  errno(): number;
}

const FLOCK = { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } as const;
const ERRNO_CELL = { args: [], returns: FFIType.ptr } as const;

/** glibc and musl spell the errno accessor `__errno_location`; darwin spells it `__error`. */
const posixSymbols = loadOnce((): PosixSymbols => {
  const cell = (location: () => Pointer | bigint | null) => () => {
    const address = location();
    return address === null ? 0 : read.i32(address, 0);
  };
  if (process.platform === "darwin") {
    const lib = dlopen("libSystem.B.dylib", { flock: FLOCK, __error: ERRNO_CELL });
    return { flock: lib.symbols.flock, errno: cell(lib.symbols.__error) };
  }
  const lib = dlopen("libc.so.6", { flock: FLOCK, __errno_location: ERRNO_CELL });
  return { flock: lib.symbols.flock, errno: cell(lib.symbols.__errno_location) };
});

/** EINTR is retried; anything that is not a holder's refusal is this filesystem refusing to lock
 *  this file, thrown as the lock's own failure (the caller's `unavailable`). */
function posixLockFd(symbols: PosixSymbols, fd: number, operation: number): OsLockExclusive {
  for (;;) {
    if (symbols.flock(fd, operation | LOCK_NB) === 0) {
      return { kind: "locked", handle: { kind: "fd", fd } };
    }
    const errno = symbols.errno();
    if (errno === ERRNO.EINTR) continue;
    closeQuietly(fd);
    if (POSIX_BUSY.has(errno)) return { kind: "busy" };
    const name = ERRNO_NAMES.get(errno) ?? String(errno);
    throw Object.assign(new Error(`flock refused with ${name}`), { code: name });
  }
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
}

/** The POSIX adapter over a symbol table (the memoized libc in production, a fake in a test).
 *  Every fd bun opens is close-on-exec and every HANDLE CreateFileW makes here is non-inheritable,
 *  so a child the holder spawns (the daemon, under the CLI's start lock) never carries the lock
 *  past the holder's death. */
export function createPosixOsLock(symbols: () => Loaded<PosixSymbols>): OsLock {
  return {
    tryExclusive(path) {
      const loaded = symbols();
      if (loaded.kind === "failed") return { kind: "unsupported", cause: loaded.cause };
      const fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_CREAT, 0o644);
      return posixLockFd(loaded.symbols, fd, LOCK_EX);
    },
    tryShared(path) {
      const loaded = symbols();
      if (loaded.kind === "failed") return { kind: "unsupported", cause: loaded.cause };
      let fd: number;
      try {
        fd = openSync(path, fsConstants.O_RDONLY);
      } catch (cause) {
        if (isEnoentOrNotdir(cause)) return { kind: "absent" };
        throw cause;
      }
      return posixLockFd(loaded.symbols, fd, LOCK_SH);
    },
    release(handle) {
      if (handle.kind !== "fd") return;
      const loaded = symbols();
      if (loaded.kind === "loaded") loaded.symbols.flock(handle.fd, LOCK_UN);
      closeQuietly(handle.fd);
    },
  };
}

const posixOsLock = createPosixOsLock(posixSymbols);

// --- Windows -------------------------------------------------------------------------------

const GENERIC_READ = 0x8000_0000;
const GENERIC_WRITE = 0x4000_0000;
const FILE_SHARE_READ_WRITE_DELETE = 0x1 | 0x2 | 0x4;
const OPEN_EXISTING = 3;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn;
const LOCKFILE_FAIL_IMMEDIATELY = 0x1;
const LOCKFILE_EXCLUSIVE_LOCK = 0x2;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_LOCK_VIOLATION = 33;
/** sizeof(OVERLAPPED) on 64-bit Windows; its Offset and OffsetHigh words sit at bytes 16 and 20
 *  and name where the locked range starts. */
const OVERLAPPED_BYTES = 32;
const OVERLAPPED_OFFSET_LOW_AT = 16;
const OVERLAPPED_OFFSET_HIGH_AT = 20;
/** The one locked byte: offset 2^62 (OffsetHigh 0x4000_0000, Offset 0), past any end of file a
 *  sidecar will have, inside the deno release's whole-file range. */
const WIN32_LOCK_OFFSET_HIGH = 0x4000_0000;
const WIN32_LOCK_OFFSET_LOW = 0;
const WIN32_LOCK_BYTES = 1;

function lockRangeOverlapped(): Uint8Array {
  const overlapped = new Uint8Array(OVERLAPPED_BYTES);
  const view = new DataView(overlapped.buffer);
  view.setUint32(OVERLAPPED_OFFSET_LOW_AT, WIN32_LOCK_OFFSET_LOW, true);
  view.setUint32(OVERLAPPED_OFFSET_HIGH_AT, WIN32_LOCK_OFFSET_HIGH, true);
  return overlapped;
}

const win32Symbols = loadOnce(
  () =>
    dlopen("kernel32.dll", {
      CreateFileW: {
        args: [
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
        ],
        returns: FFIType.u64,
      },
      LockFileEx: {
        args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
      UnlockFileEx: {
        args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
      GetLastError: { args: [], returns: FFIType.u32 },
    }).symbols,
);

type Win32Symbols = Extract<ReturnType<typeof win32Symbols>, { kind: "loaded" }>["symbols"];

function win32Error(call: string, code: number): Error {
  return new Error(`${call} failed with Win32 error ${code}`);
}

/** A failed CreateFileW is returned as its Win32 error code; the caller decides which codes are
 *  an answer (`absent` under OPEN_EXISTING) and which are the lock's own I/O. The path takes the
 *  `\\?\` prefix node:fs gives every path, so a long home that node opens opens here too. */
function win32CreateFile(
  symbols: Win32Symbols,
  path: string,
  access: number,
  disposition: number,
): bigint | { readonly code: number } {
  const widePath = Buffer.from(`${toNamespacedPath(path)}\0`, "utf16le");
  const handle = symbols.CreateFileW(
    ptr(widePath),
    access,
    FILE_SHARE_READ_WRITE_DELETE,
    null,
    disposition,
    FILE_ATTRIBUTE_NORMAL,
    null,
  );
  return handle === INVALID_HANDLE_VALUE ? { code: symbols.GetLastError() } : handle;
}

function win32LockHandle(symbols: Win32Symbols, handle: bigint, flags: number): OsLockExclusive {
  const overlapped = lockRangeOverlapped();
  const locked = symbols.LockFileEx(
    handle,
    flags | LOCKFILE_FAIL_IMMEDIATELY,
    0,
    WIN32_LOCK_BYTES,
    0,
    ptr(overlapped),
  );
  if (locked !== 0) return { kind: "locked", handle: { kind: "win32", handle } };
  const code = symbols.GetLastError();
  symbols.CloseHandle(handle);
  if (code === ERROR_LOCK_VIOLATION) return { kind: "busy" };
  throw win32Error("LockFileEx", code);
}

const win32OsLock: OsLock = {
  tryExclusive(path) {
    const loaded = win32Symbols();
    if (loaded.kind === "failed") return { kind: "unsupported", cause: loaded.cause };
    const opened = win32CreateFile(loaded.symbols, path, GENERIC_READ | GENERIC_WRITE, OPEN_ALWAYS);
    if (typeof opened !== "bigint") throw win32Error(`CreateFileW(${path})`, opened.code);
    return win32LockHandle(loaded.symbols, opened, LOCKFILE_EXCLUSIVE_LOCK);
  },
  tryShared(path) {
    const loaded = win32Symbols();
    if (loaded.kind === "failed") return { kind: "unsupported", cause: loaded.cause };
    const opened = win32CreateFile(loaded.symbols, path, GENERIC_READ, OPEN_EXISTING);
    if (typeof opened === "bigint") return win32LockHandle(loaded.symbols, opened, 0);
    if (opened.code === ERROR_FILE_NOT_FOUND || opened.code === ERROR_PATH_NOT_FOUND) {
      return { kind: "absent" };
    }
    throw win32Error(`CreateFileW(${path})`, opened.code);
  },
  release(handle) {
    if (handle.kind !== "win32") return;
    const loaded = win32Symbols();
    if (loaded.kind !== "loaded") return;
    const overlapped = lockRangeOverlapped();
    loaded.symbols.UnlockFileEx(handle.handle, 0, WIN32_LOCK_BYTES, 0, ptr(overlapped));
    loaded.symbols.CloseHandle(handle.handle);
  },
};

export const osLock: OsLock = process.platform === "win32" ? win32OsLock : posixOsLock;

/** Whether this machine runs the OS layer: the libc or kernel32 loaded. False is the marker layer
 *  for every process of this binary here, with the load failure as the cause. */
export function osLockSupported(): { supported: true } | { supported: false; cause: unknown } {
  const loaded = process.platform === "win32" ? win32Symbols() : posixSymbols();
  return loaded.kind === "loaded" ? { supported: true } : { supported: false, cause: loaded.cause };
}
