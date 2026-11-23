import { hashPassword, normalizeUsername, verifyPassword } from './password';

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correcto-caballo-bateria');
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
    await expect(verifyPassword('correcto-caballo-bateria', hash)).resolves.toBe(true);
    await expect(verifyPassword('correcto-caballo-bateriA', hash)).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([hashPassword('misma-clave'), hashPassword('misma-clave')]);
    expect(a).not.toBe(b);
  });

  it('treats malformed stored hashes as a mismatch', async () => {
    for (const stored of [
      '',
      'plain-text',
      'bcrypt$1$2$3$4$5',
      'scrypt$x$8$1$AAAA$BBBB',
      'scrypt$32768$8$1$AAAA$BBBB',
    ]) {
      await expect(verifyPassword('anything', stored)).resolves.toBe(false);
    }
  });

  it('normalizes usernames', () => {
    expect(normalizeUsername('  Ana ')).toBe('ana');
  });
});
