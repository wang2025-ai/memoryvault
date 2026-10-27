import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type EmbeddingConfig =
  | { provider: 'none' }
  | { provider: 'openai'; model?: string; apiKey?: string; baseUrl?: string }
  | { provider: 'ollama'; model?: string; baseUrl?: string };

export interface VaultConfig {
  embedding: EmbeddingConfig;
}

export function vaultHome(): string {
  return process.env.MEMORYVAULT_HOME || join(homedir(), '.memoryvault');
}

export function dbPath(): string {
  return join(vaultHome(), 'vault.db');
}

export function configPath(): string {
  return join(vaultHome(), 'config.json');
}

export function defaultConfig(): VaultConfig {
  return { embedding: { provider: 'none' } };
}

export function loadConfig(): VaultConfig {
  const path = configPath();
  if (!existsSync(path)) return defaultConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return defaultConfig();
  }
  const embedding = (raw as { embedding?: Record<string, unknown> }).embedding ?? {};
  const provider = typeof embedding.provider === 'string' ? embedding.provider : 'none';
  const str = (key: string): string | undefined =>
    typeof embedding[key] === 'string' ? (embedding[key] as string) : undefined;
  if (provider === 'openai') {
    return {
      embedding: {
        provider: 'openai',
        model: str('model') ?? 'text-embedding-3-small',
        apiKey: str('apiKey'),
        baseUrl: str('baseUrl'),
      },
    };
  }
  if (provider === 'ollama') {
    return {
      embedding: {
        provider: 'ollama',
        model: str('model') ?? 'nomic-embed-text',
        baseUrl: str('baseUrl') ?? 'http://localhost:11434',
      },
    };
  }
  return defaultConfig();
}

export function saveConfig(cfg: VaultConfig): void {
  mkdirSync(vaultHome(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

export function initVault(): { created: boolean } {
  const home = vaultHome();
  const existed = existsSync(dbPath());
  mkdirSync(home, { recursive: true });
  if (!existsSync(configPath())) saveConfig(defaultConfig());
  return { created: !existed };
}
