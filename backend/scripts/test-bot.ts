import { Telegraf } from 'telegraf';
const bot = new Telegraf('8901810812:AAHh2XzW6ZtlwG_hjjfoykq0mFDttZ5PXFs');
bot.on('message', (ctx) => {
  console.log('GOT MESSAGE:', ctx.message);
  ctx.reply('echo: ' + ('text' in ctx.message ? ctx.message.text : 'no text'));
});
bot.launch().then(() => console.log('BOT CONNECTED'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
