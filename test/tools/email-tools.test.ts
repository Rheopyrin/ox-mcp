import { beforeEach, describe, expect, it } from 'vitest';
import { makeFakes, makeRegistry, originalMessage, type Fakes } from './harness.js';
import type { ToolRegistry } from '../../src/tools/registry.js';

let fakes: Fakes;
let reg: ToolRegistry;

beforeEach(() => {
  fakes = makeFakes();
  reg = makeRegistry(fakes);
});

const filterArgs = {
  name: 'Spam rule',
  conditions: [{ field: 'from', contains: 'spam@' }],
  action: { type: 'fileinto', folder: 'Junk' },
};

describe('email tool dispatch', () => {
  const cases: [string, Record<string, unknown>, (f: Fakes) => unknown][] = [
    ['email_list_folders', {}, (f) => f.imap.listFolders],
    ['email_list', { folder: 'INBOX', limit: 10 }, (f) => f.imap.listMessages],
    ['email_read', { uid: 1 }, (f) => f.imap.readMessage],
    ['email_search', { subject: 'hi' }, (f) => f.imap.search],
    ['email_filter_list', {}, (f) => f.sieve.listFilters],
    ['email_send', { to: 'x@example.com', subject: 's', text: 'b' }, (f) => f.smtp.send],
    ['email_save_draft', { subject: 's', text: 'b' }, (f) => f.imap.saveDraft],
    ['email_reply', { uid: 1, text: 'thanks' }, (f) => f.smtp.send],
    ['email_reply_all', { uid: 1, text: 'thanks all' }, (f) => f.smtp.send],
    ['email_delete', { uid: 1 }, (f) => f.imap.deleteMessage],
    ['email_move', { uid: 1, destination: 'Archive' }, (f) => f.imap.moveMessage],
    ['email_flag', { uid: 1, flagged: true }, (f) => f.imap.setFlags],
    ['email_mark_read', { uid: 1 }, (f) => f.imap.setFlags],
    ['email_mark_unread', { uid: 1 }, (f) => f.imap.setFlags],
    ['email_mark_spam', { uid: 1 }, (f) => f.imap.moveToSpecialFolder],
    ['email_archive', { uid: 1 }, (f) => f.imap.moveToSpecialFolder],
    ['email_create_folder', { path: 'Projects/Acme' }, (f) => f.imap.createFolder],
    ['email_delete_folder', { path: 'Projects/Acme' }, (f) => f.imap.deleteFolder],
    ['email_filter_create', filterArgs, (f) => f.sieve.createFilter],
    ['email_filter_update', { id: 'f1', ...filterArgs }, (f) => f.sieve.updateFilter],
  ];

  it.each(cases)('%s dispatches to the right client method', async (name, args, getSpy) => {
    const res = await reg.dispatch(name, args);
    expect(res.isError, res.content[0]?.text).toBeFalsy();
    expect(getSpy(fakes)).toHaveBeenCalled();
  });

  it('email_read returns a friendly message when not found', async () => {
    fakes.imap.readMessage.mockResolvedValueOnce(null as never);
    const res = await reg.dispatch('email_read', { uid: 999 });
    expect(res.content[0].text).toMatch(/No message with UID 999/);
  });

  it('email_save_draft composes then appends', async () => {
    await reg.dispatch('email_save_draft', { to: 'x@example.com', subject: 's', text: 'b' });
    expect(fakes.smtp.buildRaw).toHaveBeenCalled();
    expect(fakes.imap.saveDraft).toHaveBeenCalledWith('raw-mime', 'Drafts');
  });

  it('email_mark_read sets and email_mark_unread clears the Seen flag', async () => {
    await reg.dispatch('email_mark_read', { uid: 5 });
    await reg.dispatch('email_mark_unread', { uid: 5 });
    expect(fakes.imap.setFlags).toHaveBeenNthCalledWith(1, 'INBOX', 5, { seen: true });
    expect(fakes.imap.setFlags).toHaveBeenNthCalledWith(2, 'INBOX', 5, { seen: false });
  });

  it('email_mark_spam and email_archive target the right special folders', async () => {
    await reg.dispatch('email_mark_spam', { uid: 5 });
    await reg.dispatch('email_archive', { uid: 5, folder: 'Newsletters' });
    expect(fakes.imap.moveToSpecialFolder).toHaveBeenNthCalledWith(1, 'INBOX', 5, 'junk');
    expect(fakes.imap.moveToSpecialFolder).toHaveBeenNthCalledWith(2, 'Newsletters', 5, 'archive');
  });

  it('email_reply answers only the sender with threading headers', async () => {
    await reg.dispatch('email_reply', { uid: 1, text: 'thanks' });
    expect(fakes.smtp.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['alice@example.com'],
        cc: undefined,
        subject: 'Re: Question',
        inReplyTo: '<orig@example.com>',
        references: '<orig@example.com>',
      }),
    );
  });

  it('email_reply_all includes To/Cc but excludes self', async () => {
    await reg.dispatch('email_reply_all', { uid: 1, text: 'thanks all' });
    expect(fakes.smtp.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['alice@example.com', 'bob@example.com'],
        cc: ['carol@example.com'],
        subject: 'Re: Question',
      }),
    );
  });

  it('reply does not double the Re: prefix', async () => {
    fakes.imap.readMessage.mockResolvedValueOnce({ ...originalMessage, subject: 'Re: Question' } as never);
    await reg.dispatch('email_reply', { uid: 1, text: 'x' });
    expect(fakes.smtp.send).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Re: Question' }));
  });

  it('reply errors cleanly when the original is missing', async () => {
    fakes.imap.readMessage.mockResolvedValueOnce(null as never);
    const res = await reg.dispatch('email_reply', { uid: 404, text: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/No message with UID 404/);
  });
});
