/**
 * Dependency-injection identifiers (Inversify `serviceIdentifier`s).
 *
 * Every binding in the container is keyed by one of these symbols. Grouped by
 * module so it is obvious which ContainerModule provides which binding.
 */
export const TYPES = {
  // core
  Logger: Symbol.for('Logger'),

  // platform (OS-capability)
  PathProvider: Symbol.for('PathProvider'),
  SecureFs: Symbol.for('SecureFs'),

  // config
  ConfigLoader: Symbol.for('ConfigLoader'),
  ConfigResolver: Symbol.for('ConfigResolver'),
  ConfigPathOverride: Symbol.for('ConfigPathOverride'),
  ResolvedConfig: Symbol.for('ResolvedConfig'),
  Env: Symbol.for('Env'),

  // auth
  AuthProviderFactory: Symbol.for('AuthProviderFactory'),
  TokenManager: Symbol.for('TokenManager'),

  // mail
  ImapClientFactory: Symbol.for('ImapClientFactory'),
  SmtpClientFactory: Symbol.for('SmtpClientFactory'),
  SieveClientFactory: Symbol.for('SieveClientFactory'),
  OxSessionManager: Symbol.for('OxSessionManager'),

  // calendar
  CalDavClientFactory: Symbol.for('CalDavClientFactory'),
  FreeBusyClient: Symbol.for('FreeBusyClient'),

  // contacts
  CardDavClientFactory: Symbol.for('CardDavClientFactory'),

  // tools
  Tool: Symbol.for('Tool'),
  ToolRegistry: Symbol.for('ToolRegistry'),

  // server
  McpServer: Symbol.for('McpServer'),
} as const;
