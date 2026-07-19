import { injectable } from 'inversify';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Filesystem capability with secure-by-default semantics for credential files.
 * On POSIX the config file is written `0600` and its directory `0700`; on
 * Windows those chmod calls are no-ops (NTFS ACLs from the user profile apply).
 */
export interface SecureFs {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  /** Create a directory (recursively) with restrictive permissions. */
  ensureDir(path: string): Promise<void>;
  /** Write a file with owner-only permissions, creating parent dirs. */
  writeFileSecure(path: string, data: string): Promise<void>;
}

abstract class BaseSecureFs implements SecureFs {
  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }

  abstract ensureDir(path: string): Promise<void>;
  abstract writeFileSecure(path: string, data: string): Promise<void>;
}

@injectable()
export class PosixSecureFs extends BaseSecureFs {
  override async ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    // mkdir's mode is subject to umask; enforce explicitly.
    await chmod(path, 0o700).catch(() => undefined);
  }

  override async writeFileSecure(path: string, data: string): Promise<void> {
    await this.ensureDir(dirname(path));
    await writeFile(path, data, { mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
  }
}

@injectable()
export class WindowsSecureFs extends BaseSecureFs {
  override async ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  override async writeFileSecure(path: string, data: string): Promise<void> {
    await this.ensureDir(dirname(path));
    await writeFile(path, data);
  }
}
