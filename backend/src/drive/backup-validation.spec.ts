import { backupFileName, isNotuxBackup, isPlausibleDriveId } from './backup-validation';

describe('backup validation', () => {
  it('accepts a Notux backup and ignores the rest of its content', () => {
    expect(isNotuxBackup({ app: 'notux', format: 1 })).toBe(true);
    expect(
      isNotuxBackup({ app: 'notux', format: 1, dbVersion: 5, exportedAt: '2026-11-23T10:00:00Z', tasks: [{ id: 1 }] }),
    ).toBe(true);
  });

  it.each([
    null,
    undefined,
    'notux',
    42,
    [],
    [{ app: 'notux', format: 1 }],
    {},
    { app: 'notux' },
    { format: 1 },
    { app: 'other', format: 1 },
    { app: 'notux', format: 2 },
    { app: 'notux', format: '1' },
    { app: 'NOTUX', format: 1 },
  ])('rejects %p', (body) => {
    expect(isNotuxBackup(body)).toBe(false);
  });

  it('names files after the UTC date and time', () => {
    expect(backupFileName(new Date('2026-11-23T15:30:59Z'))).toBe('notux-respaldo-2026-11-23-1530.json');
    expect(backupFileName(new Date('2026-01-05T04:07:00Z'))).toBe('notux-respaldo-2026-01-05-0407.json');
  });

  it('only accepts id-shaped strings as Drive ids', () => {
    expect(isPlausibleDriveId('1AbC-dEf_GhIjKlMnOp')).toBe(true);
    expect(isPlausibleDriveId('short')).toBe(false);
    expect(isPlausibleDriveId("abc' or name contains 'x")).toBe(false);
    expect(isPlausibleDriveId('../../etc/passwd')).toBe(false);
  });
});
