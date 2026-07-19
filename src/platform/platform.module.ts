import { ContainerModule } from 'inversify';
import { TYPES } from '../core/types.js';
import { PosixPathProvider, WindowsPathProvider, type PathProvider } from './path-provider.js';
import { PosixSecureFs, WindowsSecureFs, type SecureFs } from './secure-fs.js';

/**
 * OS-capability module. Binds the platform-specific `PathProvider` and
 * `SecureFs` implementations chosen from `process.platform`. Bound as dynamic
 * values so the classes' defaulted constructor args are used rather than
 * injected.
 */
export const platformModule = new ContainerModule((bind) => {
  const isWindows = process.platform === 'win32';

  bind<PathProvider>(TYPES.PathProvider)
    .toDynamicValue(() => (isWindows ? new WindowsPathProvider() : new PosixPathProvider()))
    .inSingletonScope();

  bind<SecureFs>(TYPES.SecureFs)
    .toDynamicValue(() => (isWindows ? new WindowsSecureFs() : new PosixSecureFs()))
    .inSingletonScope();
});
