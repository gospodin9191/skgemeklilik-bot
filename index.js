const { Telegraf } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply("Merhaba 🙂 SGK emeklilik botuna hoş geldiniz.\nBaşlamak için hazırız.");
});

bot.launch();
console.log("Bot çalışıyor...");