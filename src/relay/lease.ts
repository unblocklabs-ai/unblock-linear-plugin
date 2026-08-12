import { open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export type RelayWriterLease = {
  release(): Promise<void>;
};

export class RelayLeaseError extends Error {
  constructor(readonly code: "held" | "unavailable") {
    super(code === "held" ? "Relay writer lease is already held" : "Relay writer lease is unavailable");
    this.name = "RelayLeaseError";
  }
}

type RelayLeaseOwner = Readonly<{
  v: 1;
  pid: number;
  token: string;
}>;

export type RelayWriterLeaseOptions = Readonly<{
  pid?: number;
  token?: string;
  isProcessAlive?: (pid: number) => boolean;
}>;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

function parseOwner(value: string): RelayLeaseOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    return record.v === 1 && typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0 &&
      typeof record.token === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(record.token)
      ? { v: 1, pid: record.pid, token: record.token }
      : undefined;
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/**
 * An exclusive local-host lease. Its creation is atomic across processes and
 * the open descriptor remains held for the service lifetime. A stale owner is
 * reclaimed only after same-host liveness proves its recorded PID is gone.
 */
async function readOwner(path: string): Promise<RelayLeaseOwner | undefined> {
  const handle = await open(path, "r");
  try {
    return parseOwner(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function acquireMutationGuard(
  guardPath: string,
  ownerText: string,
  ownerIsAlive: (pid: number) => boolean,
): Promise<FileHandle> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const guard = await open(guardPath, "wx", 0o600);
      await guard.writeFile(ownerText, "utf8");
      await guard.sync();
      return guard;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw new RelayLeaseError("unavailable");
      let prior: RelayLeaseOwner | undefined;
      try {
        prior = await readOwner(guardPath);
      } catch (readError) {
        if (errorCode(readError) === "ENOENT") continue;
        throw new RelayLeaseError("unavailable");
      }
      if (prior === undefined || ownerIsAlive(prior.pid)) throw new RelayLeaseError("held");
      try {
        await rename(guardPath, `${guardPath}.stale-${prior.pid}-${prior.token}`);
      } catch (renameError) {
        if (errorCode(renameError) === "ENOENT") continue;
        throw new RelayLeaseError("unavailable");
      }
    }
  }
  throw new RelayLeaseError("unavailable");
}

async function releaseMutationGuard(guard: FileHandle, guardPath: string): Promise<void> {
  try {
    await guard.close();
    await unlink(guardPath);
  } catch {
    throw new RelayLeaseError("unavailable");
  }
}

export async function acquireRelayWriterLease(
  path: string,
  options: RelayWriterLeaseOptions = {},
): Promise<RelayWriterLease> {
  const owner: RelayLeaseOwner = {
    v: 1,
    pid: options.pid ?? process.pid,
    token: options.token ?? `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(owner.token)) throw new RelayLeaseError("unavailable");
  const ownerText = JSON.stringify(owner);
  const ownerIsAlive = options.isProcessAlive ?? isProcessAlive;
  const guardPath = `${path}.guard`;
  const guard = await acquireMutationGuard(guardPath, ownerText, ownerIsAlive);
  let handle: FileHandle | undefined;
  try {
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(ownerText, "utf8");
      await handle.sync();
    } catch (error) {
      await handle?.close();
      handle = undefined;
      if (errorCode(error) !== "EEXIST") throw new RelayLeaseError("unavailable");
      let prior: RelayLeaseOwner | undefined;
      try {
        prior = await readOwner(path);
      } catch (readError) {
        if (errorCode(readError) === "ENOENT") throw new RelayLeaseError("unavailable");
        throw new RelayLeaseError("unavailable");
      }
      if (prior === undefined || ownerIsAlive(prior.pid)) throw new RelayLeaseError("held");

      try {
        await rename(path, `${path}.stale-${prior.pid}-${prior.token}`);
        handle = await open(path, "wx", 0o600);
        await handle.writeFile(ownerText, "utf8");
        await handle.sync();
      } catch {
        await handle?.close();
        handle = undefined;
        throw new RelayLeaseError("unavailable");
      }
    }
  } finally {
    await releaseMutationGuard(guard, guardPath);
  }
  if (handle === undefined) throw new RelayLeaseError("unavailable");

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      const releaseGuard = await acquireMutationGuard(guardPath, ownerText, ownerIsAlive);
      try {
        await handle.close();
        await unlink(path);
      } catch {
        throw new RelayLeaseError("unavailable");
      } finally {
        await releaseMutationGuard(releaseGuard, guardPath);
      }
    },
  };
}
