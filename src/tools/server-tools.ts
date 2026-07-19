import { json, type Tool } from './tool.js';

const listServers: Tool = {
  name: 'list_servers',
  title: 'List servers',
  description:
    'List configured accounts/servers and their mail/calDav/cardDav sections (hosts, users, auth types). Never returns secrets.',
  readOnly: true,
  inputSchema: {},
  async execute(_args, ctx) {
    const def = ctx.resolver.defaultServerId;
    const sectionInfo = (s?: { server: string; auth: { type: string; user: string } }) =>
      s ? { server: s.server || undefined, user: s.auth.user || undefined, authType: s.auth.type } : undefined;
    return json(
      ctx.resolver.getServers().map((s) => ({
        id: s.id,
        label: s.label,
        isDefault: s.id === def,
        mail: sectionInfo(s.mail),
        calDav: sectionInfo(s.calDav),
        cardDav: sectionInfo(s.cardDav),
      })),
    );
  },
};

export const serverTools: Tool[] = [listServers];
