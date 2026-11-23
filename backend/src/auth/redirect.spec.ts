import { isAllowedRedirect, withParams } from './redirect';

describe('redirect allow-list', () => {
  const allowed = ['http://localhost:8080', 'https://usuario.github.io/notux/'];

  it.each([
    'http://localhost:8080',
    'http://localhost:8080/',
    'http://localhost:8080/index.html?view=tasks#today',
    'https://usuario.github.io/notux/',
    'https://usuario.github.io/notux',
    'https://usuario.github.io/notux/index.html',
  ])('allows %s', (url) => {
    expect(isAllowedRedirect(url, allowed)).toBe(true);
  });

  it.each([
    undefined,
    '',
    'not a url',
    '/relative/path',
    'http://localhost:8081/',
    'https://localhost:8080/',
    'http://localhost:8080.evil.com/',
    'http://evil.com/?http://localhost:8080',
    'http://user:pass@localhost:8080/',
    'https://usuario.github.io/',
    'https://usuario.github.io/notux-evil/',
    'https://usuario.github.io/other/',
    'javascript:alert(1)',
    `http://localhost:8080/${'a'.repeat(3000)}`,
  ])('rejects %s', (url) => {
    expect(isAllowedRedirect(url, allowed)).toBe(false);
  });

  it('adds params while keeping query and hash', () => {
    expect(withParams('http://localhost:8080/?view=tasks#x', { login_code: 'abc' })).toBe(
      'http://localhost:8080/?view=tasks&login_code=abc#x',
    );
  });
});
