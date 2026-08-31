import { Telegraf } from 'telegraf';
import { log, warn } from '../config';
import { connectWallet, getUser, disconnectWallet, platformStats } from './users';
import { getOrCreateAgent, getAgent, setTelegramNotifier } from './user-agent';
import { pnlSummary } from './pnl';
import { findClaimable } from './settlement';

let bot: Telegraf | null = null;

export function getBot(): Telegraf | null {
  return bot;
}

export function startTelegramBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log('Telegram bot not started — TELEGRAM_BOT_TOKEN not set');
    return;
  }
  bot = new Telegraf(token);
  setTelegramNotifier(async (chatId, text) => {
    try { await bot!.telegram.sendMessage(chatId, text); } catch {}
  });

  bot.start(async (ctx) => {
    const name = ctx.from?.first_name ?? 'there';
    await ctx.reply(
      `🌙 *Somnus* — your DreamDEX trading bot on Somnia testnet\n\n` +
        `Hi ${name}! I trade 5m/15m Event Contracts via your own wallet.\n\n` +
        `*Setup (once):*\n` +
        `1. /connect \\<privateKey\\> — paste your testnet private key (funded with tUSDC + 0.02 STT)\n` +
        `2. /trade5 — trade $5  (or /trade50 for $50, /trade \\<amount\\>)\n` +
        `3. I stay on until edge, auto-claim wins, and DM you win/loss\n\n` +
        `*Commands:*\n` +
        `/trade5 /trade50 /trade \\— one-tap trade\n` +
        `/trade1000 — up to $1000 cap\n` +
        `/positions — open + claimable\n` +
        `/pnl — realized + win rate\n` +
        `/status — wallet + loop\n` +
        `/stop — stop BG loop\n` +
        `/disconnect — revoke\n\n` +
        `Your key never leaves this server — per-user session wallet like Paybox. Use a testnet burner.`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('connect', async (ctx) => {
    const parts = ctx.message.text.split(/\s+/);
    const key = parts[1];
    if (!key || !key.startsWith('0x') && key.length < 64) {
      await ctx.reply('Usage: /connect 0xYOUR_PRIVATE_KEY\nUse a testnet burner funded with tUSDC + STT (faucet.somnia.network).');
      return;
    }
    try {
      const user = connectWallet(ctx.chat.id, key, ctx.from?.username, ctx.from?.first_name);
      await ctx.reply(`✅ Connected wallet \`${user.address.slice(0, 6)}...${user.address.slice(-4)}\`\nMode: ${user.config.mode} | Max $${user.config.maxTradeSize}\n\nTry /trade5`, { parse_mode: 'Markdown' });
    } catch (e) {
      await ctx.reply(`Connect failed: ${(e as Error).message}`);
    }
  });

  bot.command('disconnect', async (ctx) => {
    const ok = disconnectWallet(ctx.chat.id);
    const agent = getAgent(ctx.chat.id);
    agent?.stop();
    await ctx.reply(ok ? 'Disconnected — loop stopped, key removed.' : 'No wallet to disconnect.');
  });

  bot.command('status', async (ctx) => {
    const user = getUser(ctx.chat.id);
    if (!user) return ctx.reply('Not connected. /connect 0x... first.');
    const agent = getAgent(ctx.chat.id);
    const addr = user.address;
    await ctx.reply(
      `Wallet: \`${addr.slice(0, 6)}...${addr.slice(-4)}\`\n` +
        `Loop: ${agent?.isRunning ? 'running' : 'stopped'} (${agent?.cycleCount ?? 0} cycles)\n` +
        `Trades: ${user.totalTrades} (${user.totalWins} wins)\n` +
        `Max: $${user.config.maxTradeSize} | Edge ${(user.config.minEdge * 100).toFixed(1)}% | ${user.config.symbols.join(',')}`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('pnl', async (ctx) => {
    try {
      const s = pnlSummary();
      await ctx.reply(`P&L: ${s.realizedPnl >= 0 ? 'up' : 'down'} $${Math.abs(s.realizedPnl).toFixed(2)} over ${s.closedTrades} closed (win ${(s.winRate * 100).toFixed(1)}%, open $${s.openCost.toFixed(2)})\nClaimed: $${s.claimedPayout.toFixed(2)}`);
    } catch (e) {
      await ctx.reply(`P&L error: ${(e as Error).message}`);
    }
  });

  bot.command('positions', async (ctx) => {
    try {
      const scan = await findClaimable();
      const lines = [
        `Scanned ${scan.scanned} positions`,
        scan.claimable.length ? `Claimable: ${scan.claimable.length} winner(s) ~$${scan.totalEstPayoutHuman.toFixed(2)}` : 'Claimable: none',
        scan.settledLosers.length ? `Settled losers: ${scan.settledLosers.length}` : 'Losers: none',
      ];
      await ctx.reply(lines.join('\n'));
    } catch (e) {
      await ctx.reply(`Positions error: ${(e as Error).message}`);
    }
  });

  // One-tap trades: /trade, /trade5, /trade50, /trade1000
  const tradeHandler = async (ctx: import('telegraf').Context, amount: number) => {
    const user = getUser(ctx.chat!.id);
    if (!user) {
      await ctx.reply('Not connected. /connect 0x... first.');
      return;
    }
    if (amount > 1000) amount = 1000;
    const agent = getOrCreateAgent(user);
    // Update size for this trade
    agent.setConfig({ budget: amount });
    await ctx.reply(`Hunting 5m/15m edge with $${amount}... staying on until signal (up to $1000 cap).`);
    // Trigger one cycle via agent, not via main loop — user-agent has its own loop
    // For one-tap we run a single cycle and report; BG loop via /start remains separate
    try {
      // Start loop if not running — stays on until edge
      if (!agent.isRunning) await agent.start();
      await ctx.reply(`Agent running — I'll DM you win/loss + profit when it settles and auto-claim if you win. /stop to pause.`);
    } catch (e) {
      await ctx.reply(`Trade failed: ${(e as Error).message}`);
    }
  };

  bot.command('trade', async (ctx) => {
    const m = ctx.message.text.match(/\/trade\s*(\d+(?:\.\d+)?)?/);
    const amt = m?.[1] ? Number(m[1]) : 5;
    await tradeHandler(ctx, Number.isFinite(amt) && amt > 0 ? amt : 5);
  });
  bot.hears(/^\/trade(\d+(?:\.\d+)?)$/, async (ctx) => {
    const amt = Number(ctx.match[1]);
    await tradeHandler(ctx as never, amt);
  });

  bot.command('trade5', (ctx) => tradeHandler(ctx as never, 5));
  bot.command('trade50', (ctx) => tradeHandler(ctx as never, 50));
  bot.command('trade1000', (ctx) => tradeHandler(ctx as never, 1000));

  bot.command('start', async (ctx) => {
    const user = getUser(ctx.chat.id);
    if (!user) return ctx.reply('Not connected. /connect 0x... first.');
    const agent = getOrCreateAgent(user);
    await agent.start();
    await ctx.reply('BG loop started — hunting every 60s at $' + user.config.maxTradeSize + '. /stop to pause.');
  });

  bot.command('stop', async (ctx) => {
    const agent = getAgent(ctx.chat.id);
    if (!agent) return ctx.reply('No agent.');
    agent.stop();
    await ctx.reply('Stopped — staying on paused. /start to resume.');
  });

  bot.command('stats', async (ctx) => {
    const s = platformStats();
    await ctx.reply(`Users: ${s.totalUsers} | Active bots: ${s.activeBots} | Total trades: ${s.totalTrades}`);
  });

  bot.launch().then(() => log('Telegram bot started')).catch((e) => warn('Telegram bot failed', e.message));

  // Graceful stop
  process.once('SIGINT', () => bot?.stop('SIGINT'));
  process.once('SIGTERM', () => bot?.stop('SIGTERM'));
}

export function stopTelegramBot(): void {
  try { bot?.stop(); } catch {}
  bot = null;
}
