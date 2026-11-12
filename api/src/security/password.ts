import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** OWASP-listed scrypt setting: N=2^15 (32 MiB), r=8, p=3. */
export const DEFAULT_PARAMS: ScryptParams = { N: 32_768, r: 8, p: 3 };

const KEY_LEN = 64;
const SALT_LEN = 16;

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LEN,
      { ...params, maxmem: 256 * params.N * params.r },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

function saneParams(p: ScryptParams): boolean {
  const power = p.N >= 2 && (p.N & (p.N - 1)) === 0;
  return power && p.N <= 2 ** 20 && p.r >= 1 && p.r <= 32 && p.p >= 1 && p.p <= 16;
}

/** Stored format: scrypt$N$r$p$salt$hash (base64). Parameters travel with each hash. */
export class PasswordHasher {
  constructor(private readonly params: ScryptParams = DEFAULT_PARAMS) {}

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LEN);
    const key = await derive(password, salt, this.params);
    const { N, r, p } = this.params;
    return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
    const params = { N: Number(n), r: Number(r), p: Number(p) };
    if (!saneParams(params)) return false;
    const expected = Buffer.from(hashB64, 'base64');
    if (expected.length !== KEY_LEN) return false;
    const actual = await derive(password, Buffer.from(saltB64, 'base64'), params);
    return timingSafeEqual(actual, expected);
  }

  private dummy: Promise<string> | undefined;

  /** Burns the same time as a real check, so unknown emails cannot be told apart by timing. */
  async dummyVerify(password: string): Promise<void> {
    this.dummy ??= this.hash('dummy-password-for-timing');
    await this.verify(password, await this.dummy);
  }
}
