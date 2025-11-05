/**
 * ESTACIO AGENT — index.js (sem XPath + SPA-safe)
 * - Varre TODAS as disciplinas do grid
 * - Abre cada card clicando no botão circular de "seta"
 * - Assiste 15min, tenta concluir e faz testes
 * - Compatível com Render (Chrome em .puppeteer)
 */

import puppeteer from "puppeteer";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

/* ==================== ENV ==================== */
const EMAIL = process.env.ESTACIO_EMAIL;
const SENHA = process.env.ESTACIO_SENHA;
const COURSE_URL = process.env.COURSE_URL || "https://estudante.estacio.br/disciplinas";
const COOKIES_BASE64 = process.env.COOKIES_BASE64 || null;

const RUN_IMMEDIATELY = process.env.RUN_IMMEDIATELY === "true";
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 7 * * *";
const TIMEZONE = process.env.TIMEZONE || "America/Sao_Paulo";
const HEADLESS = process.env.HEADLESS !== "false";

/** Diretório onde o Chrome foi instalado no build */
const PUP_CACHE = process.env.PUPPETEER_CACHE_DIR || path.join(process.cwd(), ".puppeteer");

/* ================= Cookies opcionais ================= */
if (COOKIES_BASE64) {
  try {
    const buff = Buffer.from(COOKIES_BASE64, "base64");
    fs.writeFileSync("./cookies.json", buff);
    console.log("✅ cookies.json criado a partir de COOKIES_BASE64.");
  } catch (e) {
    console.warn("⚠️ Falha ao gravar cookies.json:", e.message);
  }
}

/* ============= Chrome path resolver (Render) ============= */
function findChromeBinary(startDir) {
  try {
    const stack = [startDir];
    while (stack.length) {
      const dir = stack.pop();
      if (!dir || !fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(fp);
        else if (e.isFile() && e.name === "chrome") return fp;
      }
    }
  } catch {}
  return null;
}

function resolveChromePath() {
  // 1) .puppeteer (empacotado no projeto)
  const localChrome = findChromeBinary(path.join(PUP_CACHE, "chrome"));
  if (localChrome) return localChrome;

  // 2) API do Puppeteer
  try {
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}

  // 3) Palpites do SO
  for (const g of ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"]) {
    if (fs.existsSync(g)) return g;
  }
  return undefined;
}

async function launchBrowser() {
  const execPath = resolveChromePath();
  console.log("🧭 Chrome path:", execPath || "(default by Puppeteer)");
  return await puppeteer.launch({
    headless: HEADLESS,
    executablePath: execPath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote"
    ]
  });
}

/* ==================== HELPERS (sem XPath) ==================== */

/** Primeiro elemento cujo texto inclui um dos termos (case-insensitive). */
async function findElementByText(pageOrRoot, selector, keywords) {
  const els = await pageOrRoot.$$(selector);
  for (const el of els) {
    try {
      const txt = (await (await el.getProperty("innerText")).jsonValue() || "").toLowerCase();
      if (keywords.some(k => txt.includes(k.toLowerCase()))) return el;
    } catch {}
  }
  return null;
}

/** Todos os elementos do selector cujo texto contém algum termo. */
async function findAllByText(pageOrRoot, selector, keywords) {
  const out = [];
  const els = await pageOrRoot.$$(selector);
  for (const el of els) {
    try {
      const txt = (await (await el.getProperty("innerText")).jsonValue() || "").toLowerCase();
      if (keywords.some(k => txt.includes(k.toLowerCase()))) out.push(el);
    } catch {}
  }
  return out;
}

/** Clique com suporte a SPA: tenta detectar mudança de URL OU sumiço do texto “Minhas Disciplinas”. */
async function clickAndWaitSPA(page, element, timeout = 8000) {
  const oldUrl = page.url();
  try { await element.evaluate(el => el.scrollIntoView({ block: "center", inline: "center" })); } catch {}
  await element.click({ delay: 40 });

  const start = Date.now();
  while (Date.now() - start < timeout) {
    const urlChanged = page.url() !== oldUrl;
    if (urlChanged) return true;

    // se a página é SPA, a URL pode não mudar — nesse caso esperamos o texto de cabeçalho desaparecer
    const stillOnGrid = await page.evaluate(() => {
      const text = (document.body.innerText || "").toLowerCase();
      return text.includes("minhas disciplinas");
    }).catch(() => false);

    if (!stillOnGrid) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/* ==================== LOGIN ==================== */
async function ensureLoggedIn(page) {
  // cookies
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

  // login
  console.log("🔑 Efetuando login…");
  await page.goto("https://estudante.estacio.br", { waitUntil: "domcontentloaded" });

  await page.waitForSelector("input[type='email'], input[name='email']", { timeout: 15000 });
  await page.type("input[type='email'], input[name='email']", EMAIL, { delay: 50 });
  await page.type("input[type='password'], input[name='senha'], input[name='password']", SENHA, { delay: 50 });

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
    page.click("button[type='submit']").catch(() => {})
  ]);

  // salva cookies
  try {
    const cookies = await page.cookies();
    fs.writeFileSync("./cookies.json", JSON.stringify(cookies, null, 2));
    console.log("✅ Cookies salvos após login.");
  } catch (e) {
    console.warn("⚠️ Falha ao salvar cookies:", e.message);
  }
}

/* ================ AULA: aguardar 15 minutos ================ */
async function waitMinimumWatchTime(page, minutes = 15) {
  const totalMs = minutes * 60 * 1000;
  const step = 30 * 1000;
  let waited = 0;
  console.log(`⏳ Aguardando ${minutes} minutos de aula…`);
  while (waited < totalMs) {
    const chunk = Math.min(step, totalMs - waited);
    await page.waitForTimeout(chunk);
    waited += chunk;
    try { await page.evaluate(() => window.scrollBy(0, 240)); } catch {}
  }
}

/* ================= Marcar aula concluída (sem XPath) ================= */
async function markLessonCompleted(page) {
  const keys = ["concluir", "finalizar", "completo", "concluída", "concluido"];
  const btn = await findElementByText(page, "button, a[role='button']", keys);
  if (btn) {
    try {
      await btn.click();
      console.log("✅ Aula marcada como concluída.");
      return true;
    } catch {}
  }
  console.log("⚠️ Botão de concluir não encontrado.");
  return false;
}

/* ================== Testes/Atividades (sem XPath) ================== */
async function findAndDoModuleTests(page) {
  console.log("🔎 Procurando testes/atividades…");
  const kws = ["teste", "atividade", "avaliação", "quiz", "prova", "múltipla escolha"];

  const candidates = await findAllByText(page, "a, button, div, span", kws);
  if (!candidates.length) { console.log("ℹ️ Nenhuma atividade encontrada."); return; }
  console.log(`📌 ${candidates.length} atividade(s) encontrada(s).`);

  for (const el of candidates) {
    try {
      await el.click();
      await page.waitForTimeout(1200);

      // perguntas → escolhe uma opção por bloco ou por name
      const blocks = await page.$$(".question, .questao, .q-item, .enunciado, fieldset, .form-group");
      if (blocks.length) {
        for (const b of blocks) {
          const opts = await b.$$("label, .option, .alternativa, .answer, input[type='radio'] + label");
          if (opts.length) {
            const pick = Math.floor(Math.random() * opts.length);
            try { await opts[pick].click(); } catch {}
          }
        }
      } else {
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

      // enviar (busca por texto)
      const sent = await findElementByText(page, "button, a[role='button']", ["enviar", "finalizar", "submeter", "concluir"]);
      if (sent) {
        try {
          await sent.click();
          await page.waitForTimeout(1500);
          console.log("✅ Teste enviado.");
        } catch {}
      }
    } catch (e) {
      console.warn("⚠️ Erro ao processar atividade:", e.message);
    }
  }
}

/* ================== Grid → encontrar e abrir cada disciplina ================== */

/**
 * Retorna os botões circulares de "seta" presentes em cada card de disciplina.
 * Heurísticas:
 *  - botão dentro de um container que tenha porcentagem (%) ou “x/y”
 *  - botão aproximadamente quadrado (circular) e com SVG
 *  - tamanho entre 32 e 80px (para filtrar botões pequenos)
 */
async function getOpenCourseButtons(page) {
  const btns = await page.$$("button");
  const out = [];

  for (const b of btns) {
    const ok = await b.evaluate((el) => {
      try {
        const rect = el.getBoundingClientRect();
        if (!rect || !rect.width || !rect.height) return false;
        const approxSquare = Math.abs(rect.width - rect.height) <= 14;
        if (!approxSquare) return false;
        if (rect.width < 32 || rect.width > 80) return false;

        const hasIcon = !!el.querySelector("svg");
        // sobe no DOM procurando um "card" com % ou x/y
        let node = el;
        let score = 0;
        while (node && node !== document.body) {
          const txt = (node.innerText || "").toLowerCase();
          if (/%/.test(txt) || /\d+\s*\/\s*\d+/.test(txt)) { score++; break; }
          node = node.parentElement;
        }
        return hasIcon && score > 0;
      } catch { return false; }
    });
    if (ok) out.push(b);
  }
  return out;
}

async function gotoHome(page) {
  await page.goto(COURSE_URL, { waitUntil: "networkidle2" });
}

/** Abre uma disciplina clicando no N-ésimo botão de “seta” detectado no grid. */
async function openDisciplineByButtonIndex(page, idx) {
  await gotoHome(page);
  const btns = await getOpenCourseButtons(page);
  if (!btns.length || idx >= btns.length) {
    console.log("⚠️ Nenhum botão de abrir disciplina detectado.");
    return false;
  }

  const btn = btns[idx];

  // evita clicar no "i" (informações) — normalmente o "i" é pequeno e não passa nas heurísticas
  const ok = await clickAndWaitSPA(page, btn, 9000);
  return ok;
}

/* ================== Processar disciplina ================== */
async function processSingleDiscipline(page, maxItemsPerDiscipline = 5) {
  let processed = 0;
  while (processed < maxItemsPerDiscipline) {
    // localizar uma aula/conteúdo
    let lessonHref = null;
    const anchors = await page.$$("a[href]");
    for (const a of anchors) {
      const href = await a.evaluate(el => el.getAttribute("href"));
      if (!href) continue;
      const low = href.toLowerCase();
      if (
        low.includes("conteudo") || low.includes("conteúdos") ||
        low.includes("aula")     || low.includes("video") ||
        low.includes("vídeo")    || low.includes("material") ||
        low.includes("assistir")
      ) {
        lessonHref = new URL(href, page.url()).toString();
        break;
      }
    }

    if (lessonHref) {
      console.log("🔗 Abrindo aula:", lessonHref);
      await page.goto(lessonHref, { waitUntil: "networkidle2" });
      try { await page.evaluate(() => { const v = document.querySelector("video"); if (v) v.play().catch(() => {}); }); } catch {}
      await waitMinimumWatchTime(page, 15);
      await markLessonCompleted(page);
      await findAndDoModuleTests(page);
      processed += 1;
      try { await page.goBack({ waitUntil: "networkidle2" }); } catch {}
      continue;
    }

    // se não achou aula, tenta só atividades
    await findAndDoModuleTests(page);
    break;
  }
  console.log(`✅ Itens processados nesta disciplina: ${processed}`);
}

/* ================== Orquestrador: processar TODAS ================== */
async function processAllDisciplines(page, maxDisciplines = 12) {
  console.log("🗂  Varredura das disciplinas…");
  await gotoHome(page);

  const btns = await getOpenCourseButtons(page);
  const total = Math.min(maxDisciplines, btns.length);

  if (!total) {
    console.log("ℹ️ Nenhum botão de abrir disciplina encontrado no grid.");
    return;
  }

  console.log(`📦 Detectados ${btns.length} cards • Processando até ${total}.`);

  for (let i = 0; i < total; i++) {
    console.log(`\n=== 📚 Disciplina ${i + 1}/${total} ===`);
    const opened = await openDisciplineByButtonIndex(page, i);
    if (!opened) {
      console.log(`↷ Clique não abriu a disciplina ${i + 1}. Pulando…`);
      continue;
    }

    try {
      await processSingleDiscipline(page, 5); // até 5 itens por disciplina
    } catch (e) {
      console.warn("⚠️ Erro na disciplina:", e.message);
    }

    try { await gotoHome(page); } catch {}
  }

  console.log("\n✅ Varredura concluída.");
}

/* ================== Execução e Scheduler ================== */
async function processCourseOnce() {
  console.log("=== Início ===", new Date().toLocaleString("pt-BR", { timeZone: TIMEZONE }));
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await ensureLoggedIn(page);
    await processAllDisciplines(page, 12);
  } catch (e) {
    console.error("❌ Erro:", e.message);
  }
  await browser.close();
}

function startScheduler() {
  console.log(`🔁 CRON ativado: "${CRON_SCHEDULE}" tz:${TIMEZONE}`);
  cron.schedule(
    CRON_SCHEDULE,
    async () => {
      try { await processCourseOnce(); } catch (e) { console.error("Erro no agendamento:", e.message); }
    },
    { timezone: TIMEZONE }
  );
}

/* ================== Main ================== */
(async () => {
  if (RUN_IMMEDIATELY) {
    console.log("⚡ RUN_IMMEDIATELY=true → executando agora…");
    await processCourseOnce();
  }
  startScheduler();
})();
