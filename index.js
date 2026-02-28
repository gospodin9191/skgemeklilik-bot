const { Telegraf } = require("telegraf");
const fs = require("fs");
const http = require("http");

const bot = new Telegraf(process.env.BOT_TOKEN);
const rules = JSON.parse(fs.readFileSync("sgk_rules.json"));

const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      step: 0,
      data: {},
      pending: null,        // { key, value, nextStep }
      awaitingConfirm: false
    });
  }
  return sessions.get(id);
}

function askConfirm(ctx, label, key, value, nextStep) {
  const s = getSession(ctx.from.id);
  s.pending = { key, value, nextStep, label };
  s.awaitingConfirm = true;
  ctx.reply(`${label}: "${value}"\nDoğru mu? (evet / hayır)`);
}

function normalizeYesNo(text) {
  const t = (text || "").trim().toLowerCase();
  if (["evet", "e", "yes", "y"].includes(t)) return "yes";
  if (["hayır", "hayir", "h", "no", "n"].includes(t)) return "no";
  return null;
}

bot.start((ctx) => {
  const s = getSession(ctx.from.id);
  s.step = 1;
  s.data = {};
  s.pending = null;
  s.awaitingConfirm = false;
  ctx.reply("SGK statünüz nedir? (4A / 4B / 4C)");
});

bot.on("text", (ctx) => {
  const s = getSession(ctx.from.id);
  const msg = ctx.message.text.trim();

  // Onay bekleniyorsa
  if (s.awaitingConfirm) {
    const yn = normalizeYesNo(msg);
    if (!yn) return ctx.reply('Lütfen "evet" ya da "hayır" yaz.');

    if (yn === "no") {
      // aynı soruyu tekrar sor
      s.awaitingConfirm = false;
      s.pending = null;
      if (s.step === 1) return ctx.reply("Tekrar yazalım: SGK statünüz nedir? (4A / 4B / 4C)");
      if (s.step === 2) return ctx.reply("Tekrar yazalım: Cinsiyetiniz? (Kadın / Erkek)");
      if (s.step === 3) return ctx.reply("Tekrar yazalım: Doğum yılınız? (örn 1988)");
      if (s.step === 4) return ctx.reply("Tekrar yazalım: İlk sigorta giriş yılınız? (örn 2008)");
      if (s.step === 5) return ctx.reply("Tekrar yazalım: Toplam prim gününüz? (örn 5400)");
    }

    // evet ise kaydet ve ilerle
    s.data[s.pending.key] = s.pending.value;
    s.awaitingConfirm = false;
    s.step = s.pending.nextStep;
    s.pending = null;

    // sonraki soruyu sor
    if (s.step === 2) return ctx.reply("Cinsiyetiniz? (Kadın / Erkek)");
    if (s.step === 3) return ctx.reply("Doğum yılınız? (örn 1988)");
    if (s.step === 4) return ctx.reply("İlk sigorta giriş yılınız? (örn 2008)");
    if (s.step === 5) return ctx.reply("Toplam prim gününüz? (örn 5400)");

    if (s.step === 6) {
      // şimdilik hesap yok: sadece özet
      return ctx.reply(
`✅ Onaylandı, bilgiler toplandı:
• Statü: ${s.data.status}
• Cinsiyet: ${s.data.gender}
• Doğum yılı: ${s.data.birthYear}
• Giriş yılı: ${s.data.entryYear}
• Prim: ${s.data.prim}

📌 Sıradaki adım: Detaylı SGK raporu + yorumlu sonuç motoru.`
      );
    }
  }

  // normal akış
  if (s.step === 0) return ctx.reply("Başlamak için /start yaz 🙂");

  if (s.step === 1) {
    const v = msg.toUpperCase();
    if (!["4A", "4B", "4C"].includes(v)) return ctx.reply("Lütfen 4A / 4B / 4C yaz.");
    return askConfirm(ctx, "SGK statüsü", "status", v, 2);
  }

  if (s.step === 2) {
    const t = msg.toLowerCase();
    const v = (t === "erkek") ? "Erkek" : (t === "kadın" || t === "kadin") ? "Kadın" : null;
    if (!v) return ctx.reply("Lütfen 'Kadın' ya da 'Erkek' yaz.");
    return askConfirm(ctx, "Cinsiyet", "gender", v, 3);
  }

  if (s.step === 3) {
    const v = Number(msg);
    if (!Number.isInteger(v) || v < 1900 || v > 2010) return ctx.reply("Doğum yılını 4 haneli yaz (örn 1988).");
    return askConfirm(ctx, "Doğum yılı", "birthYear", v, 4);
  }

  if (s.step === 4) {
    const v = Number(msg);
    if (!Number.isInteger(v) || v < 1950 || v > 2030) return ctx.reply("Giriş yılını sayı yaz (örn 2008).");
    return askConfirm(ctx, "İlk sigorta giriş yılı", "entryYear", v, 5);
  }

  if (s.step === 5) {
    const v = Number(msg);
    if (!Number.isFinite(v) || v < 0 || v > 20000) return ctx.reply("Prim gününü sayı yaz (örn 5400).");
    return askConfirm(ctx, "Toplam prim günü", "prim", v, 6);
  }
});

// Telegram bot + Render port için mini HTTP server
bot.launch();
console.log("Bot çalışıyor...");

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("OK");
}).listen(PORT, () => console.log("HTTP server port", PORT));