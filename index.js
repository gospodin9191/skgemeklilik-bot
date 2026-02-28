const { Telegraf } = require("telegraf");
const fs = require("fs");
const http = require("http");

const bot = new Telegraf(process.env.BOT_TOKEN);
const rules = JSON.parse(fs.readFileSync("sgk_rules.json", "utf8"));

const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      step: 0,
      data: {},
      pending: null,
      awaitingConfirm: false,
    });
  }
  return sessions.get(id);
}

function normalizeYesNo(text) {
  const t = (text || "").trim().toLowerCase();
  if (["evet", "e", "yes", "y"].includes(t)) return "yes";
  if (["hayır", "hayir", "h", "no", "n"].includes(t)) return "no";
  return null;
}

function askConfirm(ctx, label, key, value, nextStep) {
  const s = getSession(ctx.from.id);
  s.pending = { key, value, nextStep, label };
  s.awaitingConfirm = true;
  ctx.reply(`${label}: "${value}"\nDoğru mu? (evet / hayır)`);
}

function rowToArray(rowObj) {
  const keys = Object.keys(rowObj)
    .filter(k => /^\d+$/.test(k))
    .sort((a,b)=>Number(a)-Number(b));
  return keys.map(k => (rowObj[k] ?? "").toString().trim());
}

function parseEntryRange(text) {
  const t = (text || "").trim();

  const mRange = t.match(/(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})/);
  if (mRange) return { type:"range", start:mRange[1], end:mRange[2] };

  const mBefore = t.match(/(\d{2}\.\d{2}\.\d{4}).*(öncesi)/i);
  if (mBefore) return { type:"before", end:mBefore[1] };

  const mAfter = t.match(/(\d{2}\.\d{2}\.\d{4}).*(sonrası)/i);
  if (mAfter) return { type:"after", start:mAfter[1] };

  return null;
}

function dateToNumberTR(d){
  const m=d.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if(!m) return null;
  return Number(m[3]+m[2]+m[1]);
}

function entryYearToApproxDateNumber(y){
  return Number(`${y}0701`);
}

/* ==============================
   ANA EMEKLİLİK TABLO YAKALAMA
   ============================== */
function extractMainRetirementTable(statusRules) {

  const rowsArr = statusRules.map(rowToArray);
  let gender=null;
  const extracted=[];

  for(const rr of rowsArr){

    const joined=rr.join(" ").toLowerCase();
    if(joined.includes("kadın")||joined.includes("kadin")) gender="Kadın";
    if(joined.includes("erkek")) gender="Erkek";

    let range=null;
    for(const cell of rr){
      const r=parseEntryRange(cell);
      if(r){ range=r; break;}
    }
    if(!range) continue;

    const nums=rr
      .map(x=>x.replace(/\./g,""))
      .map(x=>x.match(/\d+/g)||[])
      .flat()
      .map(Number);

    const days=Math.max(...nums.filter(n=>n>=3000&&n<=20000));
    const age=Math.min(...nums.filter(n=>n>=38&&n<=80));

    if(!days||!age) continue;

    extracted.push({
      genderTag:gender,
      range,
      requiredDays:days,
      requiredAge:age
    });
  }

  return extracted;
}

function pickRuleByEntryYear(rulesExtracted, gender, entryYear){
  const entry=entryYearToApproxDateNumber(entryYear);

  const list=rulesExtracted.filter(r=>!r.genderTag||r.genderTag===gender);

  for(const r of list){
    if(r.range.type==="range"){
      const s=dateToNumberTR(r.range.start);
      const e=dateToNumberTR(r.range.end);
      if(entry>=s&&entry<=e) return r;
    }
    if(r.range.type==="before"){
      if(entry<=dateToNumberTR(r.range.end)) return r;
    }
    if(r.range.type==="after"){
      if(entry>=dateToNumberTR(r.range.start)) return r;
    }
  }
  return null;
}

/* ==============================
   KISMI EMEKLİLİK
   ============================== */
function extractPartialRetirementTable(statusRules){
  const rowsArr=statusRules.map(rowToArray);
  const extracted=[];
  let gender=null;

  for(const rr of rowsArr){

    const joined=rr.join(" ").toLowerCase();
    if(joined.includes("kadın")||joined.includes("kadin")) gender="Kadın";
    if(joined.includes("erkek")) gender="Erkek";

    if(!joined.includes("kısmi")&&!joined.includes("kismi")) continue;

    const nums=rr
      .map(x=>x.replace(/\./g,""))
      .map(x=>x.match(/\d+/g)||[])
      .flat()
      .map(Number);

    const age=Math.min(...nums.filter(n=>n>=38&&n<=80));
    const days=Math.max(...nums.filter(n=>n>=3000&&n<=20000));

    if(age&&days){
      extracted.push({
        genderTag:gender,
        requiredAge:age,
        requiredDays:days
      });
    }
  }
  return extracted;
}

/* ==============================
   RAPOR
   ============================== */
function buildReport(user, mainRule, partialRule){

  const now=2026;
  const age=now-user.birthYear;

  const lines=[];
  lines.push("🧾 SGK RAPORU");
  lines.push(`Statü: ${user.status}`);
  lines.push(`Yaş: ${age}`);
  lines.push(`Prim: ${user.prim}`);
  lines.push("");

  const missPrim=Math.max(0,mainRule.requiredDays-user.prim);
  const missAge=Math.max(0,mainRule.requiredAge-age);

  lines.push("ANA EMEKLİLİK");
  lines.push(`Gerekli yaş: ${mainRule.requiredAge}`);
  lines.push(`Gerekli prim: ${mainRule.requiredDays}`);

  if(!missPrim&&!missAge) lines.push("✅ Hak kazanmış görünüyorsun");
  else{
    if(missPrim) lines.push(`Eksik prim: ${missPrim}`);
    if(missAge) lines.push(`Eksik yaş: ${missAge}`);
  }

  if(partialRule){
    lines.push("");
    lines.push("KISMİ EMEKLİLİK");
    lines.push(`Gerekli yaş: ${partialRule.requiredAge}`);
    lines.push(`Gerekli prim: ${partialRule.requiredDays}`);
  }

  return lines.join("\n");
}

/* ==============================
   BOT AKIŞI
   ============================== */

bot.start(ctx=>{
  const s=getSession(ctx.from.id);
  s.step=1;
  ctx.reply("SGK statünüz nedir? (4A / 4B / 4C)");
});

bot.on("text",ctx=>{

  const s=getSession(ctx.from.id);
  const msg=ctx.message.text.trim();

  if(s.awaitingConfirm){
    const yn=normalizeYesNo(msg);
    if(!yn) return ctx.reply("evet / hayır");

    if(yn==="no"){
      s.awaitingConfirm=false;
      return ctx.reply("Tekrar yaz");
    }

    s.data[s.pending.key]=s.pending.value;
    s.awaitingConfirm=false;
    s.step=s.pending.nextStep;

    if(s.step===2) return ctx.reply("Cinsiyet?");
    if(s.step===3) return ctx.reply("Doğum yılı?");
    if(s.step===4) return ctx.reply("İlk sigorta yılı?");
    if(s.step===5) return ctx.reply("Prim günü?");

    if(s.step===6){

      const statusRules=rules[s.data.status]||[];

      const mainExtracted=extractMainRetirementTable(statusRules);
      const mainPicked=pickRuleByEntryYear(mainExtracted,s.data.gender,s.data.entryYear);

      const partialExtracted=extractPartialRetirementTable(statusRules);
      const partialPicked=partialExtracted[0]||null;

      const report=buildReport(s.data,mainPicked,partialPicked);

      s.step=0;
      return ctx.reply(report);
    }
  }

  if(s.step===1) return askConfirm(ctx,"Statü","status",msg.toUpperCase(),2);
  if(s.step===2) return askConfirm(ctx,"Cinsiyet","gender",msg,3);
  if(s.step===3) return askConfirm(ctx,"Doğum yılı","birthYear",Number(msg),4);
  if(s.step===4) return askConfirm(ctx,"Giriş yılı","entryYear",Number(msg),5);
  if(s.step===5) return askConfirm(ctx,"Prim","prim",Number(msg),6);

});

bot.launch();
console.log("bot çalışıyor");

const PORT=process.env.PORT||3000;
http.createServer((req,res)=>{
  res.writeHead(200);
  res.end("OK");
}).listen(PORT);