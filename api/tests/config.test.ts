import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const base = {
  MONGODB_URI: 'mongodb://localhost:27017',
  ENGINE_URL: 'http://127.0.0.1:8000',
  HALUDEC_SERVICE_KEY: 'k'.repeat(40),
};

describe('loadConfig', () => {
  it('applies secure defaults', () => {
    const config = loadConfig(base);
    expect(config.REGISTRATION_OPEN).toBe(false);
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.TRUST_PROXY).toBe(0);
    expect(config.ALLOWED_ORIGINS).toEqual(['http://localhost:5173']);
  });

  it('parses flags, lists and numbers', () => {
    const config = loadConfig({
      ...base,
      REGISTRATION_OPEN: '1',
      ALLOWED_ORIGINS: 'https://a.example, https://b.example',
      PORT: '4000',
    });
    expect(config.REGISTRATION_OPEN).toBe(true);
    expect(config.ALLOWED_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
    expect(config.PORT).toBe(4000);
  });

  it('rejects missing and weak settings without echoing their values', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({ ...base, HALUDEC_SERVICE_KEY: 'short-secret' });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).toContain('HALUDEC_SERVICE_KEY');
      expect(String(err)).not.toContain('short-secret');
    }
    expect(() => loadConfig({ ...base, PORT: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, REGISTRATION_OPEN: 'yes' })).toThrow(ConfigError);
  });
});
