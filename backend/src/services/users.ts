import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { DATA_DIR, log, warn } from '../config';

const USERS_DIR = join(DATA_DIR, 'users');

export interface SomnusUser {
  chatId: number;
  username?: string;
  firstName?: string;
  /** User's private key for trading. Encrypted in production; plaintext for hackathon. */
  privateKey: string;
  /** Derived wallet address. */
  address: string;
  /** Whether the user has connected a wallet. */
  connected: boolean;
  /** Per-user agent config overrides. */
  config: {
    minEdge: number;
    maxTradeSize: number;
    maxOpenPositions: number;
    symbols: string[];
    mode: 'dry-run' | 'live';
  };
  /** Whether the user's trading loop is running. */
  loopRunning: boolean;
  /** Total P&L in human units. */
  totalPnl: number;
  /** Number of trades placed. */
  totalTrades: number;
  /** Number of wins. */
  totalWins: number;
  /** When the user first connected. */
  connectedAt: number;
  /** Last activity timestamp. */
  lastActivityAt: number;
}

function userFile(chatId: number): string {
  return join(USERS_DIR, `${chatId}.json`);
}

function defaultConfig(): SomnusUser['config'] {
  return {
    minEdge: 0.03,
    maxTradeSize: 25,
    maxOpenPositions: 3,
    symbols: ['BTC', 'ETH'],
    mode: 'live',
  };
}

export function getUser(chatId: number): SomnusUser | undefined {
  const file = userFile(chatId);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SomnusUser;
  } catch {
    return undefined;
  }
}

export function saveUser(user: SomnusUser): void {
  mkdirSync(USERS_DIR, { recursive: true });
  user.lastActivityAt = Date.now();
  writeFileSync(userFile(user.chatId), JSON.stringify(user, null, 2), 'utf8');
}

export function listUsers(): SomnusUser[] {
  if (!existsSync(USERS_DIR)) return [];
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const files = readdirSync(USERS_DIR).filter((f: string) => f.endsWith('.json'));
  const users: SomnusUser[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(USERS_DIR, f), 'utf8'));
      if (data?.chatId) users.push(data);
    } catch { /* skip corrupt files */ }
  }
  return users;
}

export function connectWallet(chatId: number, privateKey: string, username?: string, firstName?: string): SomnusUser {
  const normalized = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
  const address = privateKeyToAccount(normalized).address;

  const existing = getUser(chatId);
  const user: SomnusUser = {
    chatId,
    username,
    firstName,
    privateKey: normalized,
    address,
    connected: true,
    config: existing?.config ?? defaultConfig(),
    loopRunning: false,
    totalPnl: existing?.totalPnl ?? 0,
    totalTrades: existing?.totalTrades ?? 0,
    totalWins: existing?.totalWins ?? 0,
    connectedAt: existing?.connectedAt ?? Date.now(),
    lastActivityAt: Date.now(),
  };
  saveUser(user);
  log(`user ${chatId} (${firstName ?? username}) connected wallet ${address.slice(0, 6)}...${address.slice(-4)}`);
  return user;
}

export function updateUserConfig(chatId: number, patch: Partial<SomnusUser['config']>): SomnusUser | undefined {
  const user = getUser(chatId);
  if (!user) return undefined;
  user.config = { ...user.config, ...patch };
  saveUser(user);
  return user;
}

export function disconnectWallet(chatId: number): boolean {
  const user = getUser(chatId);
  if (!user) return false;
  user.connected = false;
  user.loopRunning = false;
  saveUser(user);
  return true;
}

/** Statistics for the landing page / admin. */
export function platformStats(): { totalUsers: number; activeBots: number; totalTrades: number } {
  const users = listUsers();
  return {
    totalUsers: users.length,
    activeBots: users.filter((u) => u.loopRunning).length,
    totalTrades: users.reduce((sum, u) => sum + u.totalTrades, 0),
  };
}
