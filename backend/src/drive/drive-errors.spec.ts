import { NotFoundException } from '@nestjs/common';
import { GoogleApiError, GoogleTokenRevokedError } from '../google/google-errors';
import { DriveClient } from './drive.client';
import { mapDriveError } from './drive-errors';

const body = (e: unknown) => (mapDriveError(e).getResponse() as { code?: string }).code;
const status = (e: unknown) => mapDriveError(e).getStatus();

describe('mapDriveError', () => {
  it('maps a revoked Google token (invalid_grant) to 403 DRIVE_NOT_AUTHORIZED', () => {
    expect(status(new GoogleTokenRevokedError())).toBe(403);
    expect(body(new GoogleTokenRevokedError())).toBe('DRIVE_NOT_AUTHORIZED');
    // Raw gaxios-style error, in case one slips through unwrapped.
    const gaxios = Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });
    expect(body(gaxios)).toBe('DRIVE_NOT_AUTHORIZED');
  });

  it('maps Drive 401 and permission 403s to DRIVE_NOT_AUTHORIZED', () => {
    expect(body(new GoogleApiError(401, 'authError', 'Invalid Credentials'))).toBe('DRIVE_NOT_AUTHORIZED');
    expect(body(new GoogleApiError(403, 'insufficientPermissions', 'scope'))).toBe('DRIVE_NOT_AUTHORIZED');
  });

  it('maps rate limits, 5xx and network failures to 502 DRIVE_UNAVAILABLE', () => {
    for (const err of [
      new GoogleApiError(403, 'userRateLimitExceeded', 'slow down'),
      new GoogleApiError(429, 'rateLimitExceeded', 'slow down'),
      new GoogleApiError(500, 'backendError', 'oops'),
      new GoogleApiError(503, 'unknown', 'down'),
      new GoogleApiError(0, 'network', 'ECONNRESET'),
      new Error('something else'),
    ]) {
      expect(status(err)).toBe(502);
      expect(body(err)).toBe('DRIVE_UNAVAILABLE');
    }
  });

  it('maps a Drive 404 to 404 and passes HttpExceptions through', () => {
    expect(status(new GoogleApiError(404, 'notFound', 'File not found'))).toBe(404);
    const own = new NotFoundException();
    expect(mapDriveError(own)).toBe(own);
  });
});

describe('DriveClient error parsing (fetch mocked)', () => {
  const client = new DriveClient();
  const fetchMock = jest.spyOn(global, 'fetch');
  afterAll(() => fetchMock.mockRestore());

  it('turns a Drive error body into GoogleApiError with its reason', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: 403, message: 'Rate', errors: [{ reason: 'rateLimitExceeded' }] } }),
        {
          status: 403,
        },
      ),
    );
    await expect(client.getFile('token', 'abcdefghijkl', 'id')).rejects.toMatchObject({
      status: 403,
      reason: 'rateLimitExceeded',
    });
  });

  it('turns network failures into status 0', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(client.getFile('token', 'abcdefghijkl', 'id')).rejects.toMatchObject({ status: 0, reason: 'network' });
  });

  it('sends the bearer token and a multipart body on upload', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'f1', name: 'n.json' }), { status: 200 }));
    await client.uploadFile('tok', { name: 'n.json', mimeType: 'application/json' }, Buffer.from('{"a":1}'), 'id');
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url as string).toContain('uploadType=multipart');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect((init!.body as Buffer).toString()).toContain('{"a":1}');
  });
});
