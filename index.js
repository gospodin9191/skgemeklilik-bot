const { Telegraf } = require("telegraf");
const fs = require("fs");

const bot = new Telegraf(process.env.BOT_TOKEN);
const rules = JSON.parse(fs.readFileSync("sgk_rules.json"));

const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, { step: 0, data: {} });
  }
  return sessions.get(id);
}

bot.start((ctx) => {
  const s = getSession(ctx.from.id);
  s.step = 1;
  ctx.reply("SGK statünüz nedir? (4A / 4B / 4C)");
});

bot.on("text", (ctx) => {
  const s = getSession(ctx.from.id);
  const msg = ctx.message.text.trim();

  if (s.step === 1) {
    s.data.status = msg.toUpperCase();
    s.step = 2;
    return ctx.reply("Cinsiyetiniz? (Kadın / Erkek)");
  }

  if (s.step === 2) {
    s.data.gender = msg;
    s.step = 3;
    return ctx.reply("Doğum yılınız?");
  }

  if (s.step === 3) {
    s.data.birthYear = Number(msg);
    s.step = 4;
    return ctx.reply("İlk sigorta giriş yılınız?");
  }

  if (s.step === 4) {
    s.data.entryYear = Number(msg);
    s.step = 5;
    return ctx.reply("Toplam prim gününüz?");
  }

  if (s.step === 5) {
    s.data.prim = Number(msg);

    const userRules = rules[s.data.status] || [];

    if (userRules.length === 0) {
      ctx.reply("Bu statü için kural bulunamadı.");
      s.step = 0;
      return;
    }

    ctx.reply("Bilgiler alındı. Hesaplama motoru yakında aktif olacak 🙂");
    s.step = 0;
  }
});

bot.launch();
console.log("Bot çalışıyor..."); 
const http = require("http");

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot çalışıyor");
}).listen(PORT, () => {
  console.log("HTTP server port", PORT);
});