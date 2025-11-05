// index.js — Background Worker (Render pago)
// - Chrome via puppeteer.executablePath() (obrigatório no Render)
// - Cron diário + execução imediata opcional
// - Assiste 15min, tenta marcar concluído e processa testes

import puppeteer from "puppeteer";
import cron from "node-cron";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

/* ====== ENV VARS ====== */
const EMAIL = process.env.ESTACIO_EMAIL;
const SENHA = process.env.ESTACIO_SENHA;
const COURSE_URL = process.env.COURSE_URL || "https://estudante.estacio.br/disciplinas";
const COOKIES_BASE64 = process.env.COOKIES_BASE64 || null; // opcional
const RUN_IMMEDIATELY = process.env.RUN_IMMEDIATELY === "true";
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 7 * * *"; // 07:00 todos os dias
const TIMEZONE = process.env.TIMEZONE || "America/Sao_Paulo";
const HEADLESS = process.env.HEADLESS !== "false";

/* ====== COOKIES (opcional) ====== */
if (COOKIES_BASE64) {
  try {
    const buff = Buffer.from(COOKIES_BASE64, "base64");
    fs.writeFileSync("./cookies.json", buff);
    console.log("✅ cookies.json criado a partir de COOKIES_BASE64.");
  } catch (e) {
    console.warn("⚠️ Falha ao criar cookies.json a partir de COOKIES_BASE64:", e.message);
  }
}

/* ====== BROWSER ====== */
async function launchBrowser() {
  return await puppeteer.launch({
    headless: HEADLESS,
    executablePath: puppeteer.executablePath(), // ESSENCIAL no Render
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--no-first-run",
      "--single-process"
    ]
  });
}

/* ====== LOGIN ====== */
async function ensureLoggedIn(page) {
  // usa cookies se existirem
  try {
    if (fs.existsSync("./cookies.json")) {
      const cookies = JSON.parse(fs.readFileSync("./cookies.json", "utf8"));
      if (Array.isArray(cookies) && cookies.length) {
        await page.setCookie(...cookies);
        console.log("✅ Cookies carregados.");
      }
    }
  } catch (e) {
    console.warn("⚠️ Erro ao carregar cookies:", e.message);
  }

  await page.goto(COURSE_URL, { waitUntil: "domcontentloaded" });
  if (!page.url().includes("login")) {
    console.log("✅ Sessão já autenticada.");
    return;
  }

  if (!EMAIL || !SENHA) {
    console.error("❌ Sem credenciais e sem sessão ativa.");
    throw new Error("Credenciais ausentes");
  }

  console.log("🔑 Fazendo login por credenciais…");
  await page.goto("https://estudante.estacio.br", { waitUntil: "domcontentloaded" });

  await page.waitForSelector("input[type='email'], input#email, input[name='email']", { timeout: 12000 });
  await page.type("input[type='email'], input#email, input[name='email']", EMAIL, { delay: 40 });
  await page.type("input[type='password'], input[name='password'], input[name='senha']", SENHA, { delay: 40 });

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 25000 }).catch(() => {}),
    page.click("button[type='submit']").catch(() => {})
  ]);

  // salva cookies
  try {
    const cookies = await page.cookies();
    fs.writeFileSync("./cookies.json", JSON.stringify(cookies, null, 2));
    console.log("✅ Cookies salvos.");
  } catch (e) {
    console.warn("⚠️ Falha ao salvar cookies:", e.message);
  }
}

/* ====== AULA: assistir 15min e marcar concluída ====== */
async function waitMinimumWatchTime(page, minutes = 15) {
  const ms = minutes * 60 * 1000;
  const step = 30 * 1000;
  let waited = 0;
  console.log(`⏳ Aguardando ${minutes} minutos…`);
  while (waited < ms) {
    await page.waitForTimeout(Math.min(step, ms - waited));
    try { await page.evaluate(() => window.scrollBy(0, 200)); } catch {}
    waited += Math.min(step, ms - waited);
  }
}

async function markLessonCompleted(page) {
  const xps = [
    "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'concluir')]",
    "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'finalizar')]",
    "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'completo')]"
  ];
  for (const xp of xps) {
    const [btn] = await page.$x(xp);
    if (btn) {
      try { await btn.click(); console.log("✅ Aula marcada como concluída."); return true; } catch {}
    }
  }
  console.log("⚠️ Botão de concluir não encontrado.");
  return false;
}

/* ====== TESTES: localizar e submeter ====== */
async function findAndDoModuleTests(page) {
  console.log("🔎 Buscando testes/atividades…");
  const kws = ["teste", "atividade", "avaliação", "quiz", "prova", "múltipla escolha"];
  const els = await page.$$("a, button, div, span");
  const targets = [];

  for (const el of els) {
    try {
      const txt = (await (await el.getProperty("innerText")).jsonValue() || "").toLowerCase();
      if (kws.some(k => txt.includes(k))) targets.push(el);
    } catch {}
  }

  if (targets.length === 0) { console.log("ℹ️ Nenhuma atividade encontrada."); return; }
  console.log(`📌 ${targets.length} atividade(s) encontrada(s).`);

  for (const el of targets) {
    try {
      await el.click();
      await page.waitForTimeout(1500);

      // responder perguntas (heurística simples)
      const questionBlocks = await page.$$(".question, .questao, .q-item, .enunciado, fieldset, .form-group");
      if (questionBlocks.length) {
        for (const qb of questionBlocks) {
          const labels = await qb.$$("label, .option, .alternativa, .answer");
          if (labels.length) {
            const pick = Math.floor(Math.random() * labels.length);
            try { await labels[pick].click(); } catch {}
          }
        }
      } else {
        // fallback por radios
        const radios = await page.$$("input[type='radio']");
        const byName = {};
        for (const r of radios) {
          const n = await r.evaluate(e => e.name || "");
          if (!byName[n]) byName[n] = [];
          byName[n].push(r);
        }
        for (const name in byName) {
          const opts = byName[name];
          const pick = Math.floor(Math.random() * opts.length);
          try { await opts[pick].click(); } catch {}
        }
      }

      // submeter
      const submitXps = [
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'enviar')]",
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'finalizar')]",
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'submeter')]",
        "//button[@type='submit']"
      ];
      let submitted = false;
      for (const xp of submitXps) {
        const [btn] = await page.$x(xp);
        if (btn) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {}),
            btn.click().catch(() => {})
          ]);
          submitted = true;
          break;
        }
      }
      console.log(submitted ? "✅ Teste enviado." : "⚠️ Não foi possível enviar o teste.");

      // screenshot
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        await page.screenshot({ path: `./testshot_${ts}.png`, fullPage: false });
      } catch {}
    } catch (e) {
      console.warn("⚠️ Erro ao processar atividade:", e.message);
    }
  }
}

/* ====== EXECUÇÃO ÚNICA ====== */
async function processCourseOnce() {
  console.log("=== Início de execução:", new Date().toLocaleString("pt-BR", { timeZone: TIMEZONE }), "===");
  const browser = await launchBrowser();
  const page = await browser.newPage();

  try {
    await ensureLoggedIn(page);

    // ir para página principal de disciplinas
    await page.goto(COURSE_URL, { waitUntil: "networkidle2" });

    // encontrar link de aula/conteúdo
    let lessonHref = null;
    const anchors = await page.$$("a");
    for (const a of anchors) {
      const href = await a.evaluate(el => el.getAttribute("href"));
      if (!href) continue;
      const low = href.toLowerCase();
      if (low.includes("conteudo") || low.includes("conteúdos") || low.includes("aula") || low.includes("video") || low.includes("vídeo")) {
        lessonHref = new URL(href, page.url()).toString();
        break;
      }
    }

    if (!lessonHref) { console.log("ℹ️ Nenhuma aula encontrada nesta execução."); await browser.close(); return; }

    // abre aula
    console.log("🔗 Abrindo aula:", lessonHref);
    await page.goto(lessonHref, { waitUntil: "networkidle2" });

    // tenta iniciar vídeo (se houver)
    try {
      await page.evaluate(() => {
        const v = document.querySelector("video");
        if (v) v.play().catch(() => {});
      });
    } catch {}

    // assiste 15min
    await waitMinimumWatchTime(page, 15);

    // marcar concluída
    await markLessonCompleted(page);

    // processar testes do módulo
    await findAndDoModuleTests(page);

    // screenshot final (opcional)
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      await page.screenshot({ path: `./screenshot_${ts}.png` });
    } catch {}
  } catch (e) {
    console.error("❌ Erro durante execução:", e.message);
  }

  await browser.close();
  console.log("=== Fim de execução ===");
}

/* ====== SCHEDULER ====== */
function startScheduler() {
  console.log(`🔁 Agendando com CRON "${CRON_SCHEDULE}" (tz: ${TIMEZONE}).`);
  cron.schedule(CRON_SCHEDULE, async () => {
    try { await processCourseOnce(); }
    catch (e) { console.error("❌ Execução agendada falhou:", e.message); }
  }, { timezone: TIMEZONE });
}

/* ====== MAIN ====== */
(async () => {
  if (RUN_IMMEDIATELY) {
    console.log("⚡ RUN_IMMEDIATELY=true → executando agora…");
    await processCourseOnce();
  }
  startScheduler();
})();
