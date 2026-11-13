import { describe, expect, it } from 'vitest';
import { PasswordHasher } from '../src/security/password.js';

const cheap = new PasswordHasher({ N: 1024, r: 8, p: 1 });

describe('PasswordHasher', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await cheap.hash('correct horse battery staple');
    expect(await cheap.verify('correct horse battery staple', stored)).toBe(true);
    expect(await cheap.verify('wrong password here', stored)).toBe(false);
  });

  it('salts every hash and records the parameters in it', async () => {
    const a = await cheap.hash('same password 123');
    const b = await cheap.hash('same password 123');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$1024$8$1$')).toBe(true);
    expect(a).not.toContain('same password');
  });

  it('verifies with the parameters stored in the hash, not the current ones', async () => {
    const stored = await cheap.hash('another password 12');
    const stronger = new PasswordHasher({ N: 2048, r: 8, p: 1 });
    expect(await stronger.verify('another password 12', stored)).toBe(true);
  });

  it('treats equivalent Unicode forms of a password as the same', async () => {
    const stored = await cheap.hash('caf\u00e9 password 123');
    expect(await cheap.verify('cafe\u0301 password 123', stored)).toBe(true);
  });

  it('rejects malformed or unsafe stored hashes instead of throwing', async () => {
    for (const bad of [
      '',
      'plaintext',
      'scrypt$1$2$3',
      'bcrypt$1024$8$1$c2FsdA==$aGFzaA==',
      'scrypt$1000$8$1$c2FsdA==$aGFzaA==',
      `scrypt$${2 ** 25}$8$1$c2FsdA==$aGFzaA==`,
      'scrypt$1024$8$1$c2FsdA==$aGFzaA==',
    ]) {
      expect(await cheap.verify('whatever password', bad)).toBe(false);
    }
  });

  it('dummyVerify completes without error', async () => {
    await expect(cheap.dummyVerify('some password 123')).resolves.toBeUndefined();
  });
});
