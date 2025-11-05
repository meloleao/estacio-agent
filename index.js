/**
 * ESTACIO AGENT — index.js
 * - Login com cookies
 * - Grid: tenta botões → fallback por TÍTULO com rolagem + XPath + scanner
 * - Aula: Acessar/Avançar → play → 15min → Marcar como estudado → Atividades
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

/** Disciplinas alvo (fallback por título) */
const COURSE_TITLES = (process.env.COURSE_TITLES || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

/** Local do Chrome baixado no build (Render) */
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
  const local = findChromeBinary(path.join(PUP_CACHE, "chrome"));
  if (local) return local;
  try {
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  for (const g of ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"]) {
    if (fs.existsSync(g)) return g;
  }
  return undefined;
}
async function launchBrowser() {
  const execPath = resolveChromePath();
  console.log("🧭 Chrome path:", execPath || "(default by Puppeteer)");
  return puppeteer.launch({
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

/* ==================== HELPERS ==================== */
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
/** Clique que espera a navegação SPA (URL muda ou some “Minhas Disciplinas”) */
async function clickAndWaitSPA(page, element, timeout = 10000) {
  const oldUrl = page.url();
  try { await element.evaluate(el => el.scrollIntoView({ block: "center" })); } catch {}
  await element.click({ delay: 50 });

  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (page.url() !== oldUrl) return true;
    const stillGrid = await page.evaluate(() => {
      const t = (document.body.innerText || "").toLowerCase();
      return t.includes("minhas disciplinas") || t.includes("continue de onde parou");
    }).catch(() => false);
    if (!stillGrid) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/* ==================== LOGIN ==================== */
async function ensureLoggedIn(page) {
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

  console.log("🔑 Efetuando login…");
  await page.goto("https://estudante.estacio.br", { waitUntil: "domcontentloaded" });

  await page.waitForSelector("input[type='email'], input[name='email']", { timeout: 15000 });
  await page.type("input[type='email'], input[name='email']", EMAIL, { delay: 40 });
  await page.type("input[type='password'], input[name='senha'], input[name='password']", SENHA, { delay: 40 });

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
    page.click("button[type='submit']").catch(() => {})
  ]);

  try {
    const cookies = await page.cookies();
    fs.writeFileSync("./cookies.json", JSON.stringify(cookies, null, 2));
    console.log("✅ Cookies salvos após login.");
  } catch (e) {
    console.warn("⚠️ Falha ao salvar cookies:", e.message);
  }
}

/* ================ Tempo mínimo da aula ================ */
async function waitMinimumWatchTime(page, minutes = 15) {
  const totalMs = minutes * 60 * 1000;
  const step = 30000;
  let waited = 0;
  console.log(`⏳ Aguardando ${minutes} minutos…`);
  while (waited < totalMs) {
    const chunk = Math.min(step, totalMs - waited);
    await page.waitForTimeout(chunk);
    waited += chunk;
    try { await page.evaluate(() => window.scrollBy(0, 240)); } catch {}
  }
}

/* ================ Ações dentro da aula ================ */
async function clickPrimaryProgressButtons(page) {
  const keys = ["acessar conteúdo", "avançar", "próximo", "acessar conteudo"];
  const btn = await findElementByText(page, "button, a[role='button']", keys);
  if (!btn) return false;
  try { await btn.click(); await page.waitForTimeout(800); return true; } catch {}
  return false;
}
async function markLessonCompleted(page) {
  const key = "marcar como estudado";
  let tries = 20;
  while (tries--) {
    const el = await findElementByText(page, "button, a[role='button'], div", [key]);
    if (el) {
      const txt = (await (await el.getProperty("innerText")).jsonValue() || "").toLowerCase();
      const locked = /\(\d+:\d+\)/.test(txt);
      if (!locked) {
        try { await el.click(); console.log("✅ Aula marcada como estudada."); return true; } catch {}
      }
    }
    await page.waitForTimeout(6000);
  }
  console.log("⚠️ Não consegui marcar como estudada (tempo não liberou?).");
  return false;
}
async function findAndDoModuleTests(page) {
  console.log("🔎 Procurando testes/atividades…");
  const kws = ["atividade", "teste", "avaliação", "quiz", "prova", "múltipla escolha"];
  const entries = await findAllByText(page, "a, button, div, span", kws);
  for (const el of entries) { try { await el.click(); await page.waitForTimeout(800); } catch {} }

  const blocks = await page.$$(".question, .questao, .q-item, .enunciado, fieldset, .form-group");
  if (blocks.length) {
    for (const b of blocks) {
      const opts = await b.$$("label, .option, .alternativa, .answer, input[type='radio'] + label, li");
      if (opts.length) { const pick = Math.floor(Math.random() * opts.length); try { await opts[pick].click(); } catch {} }
    }
  } else {
    const radios = await page.$$("input[type='radio']");
    const groups = {};
    for (const r of radios) {
      const n = await r.evaluate(e => e.name || "");
      if (!groups[n]) groups[n] = [];
      groups[n].push(r);
    }
    for (const n in groups) {
      const opts = groups[n], pick = Math.floor(Math.random() * opts.length);
      try { await opts[pick].click(); } catch {}
    }
  }
  const send = await findElementByText(page, "button, a[role='button']", ["responda", "enviar", "finalizar", "submeter", "concluir"]);
  if (send) { try { await send.click(); await page.waitForTimeout(1000); console.log("✅ Teste/atividade enviado(a)."); } catch {} }
}

/* ================== GRID ================== */
async function getOpenCourseButtons(page) {
  const containers = await page.$$("article, section, div");
  const buttons = [];
  for (const c of containers) {
    let isCard = false;
    try {
      const txt = (await (await c.getProperty("innerText")).jsonValue() || "").toLowerCase();
      if (!txt) continue;
      if (txt.includes("digital (ead)") || txt.includes("continue de onde parou")) isCard = true;
    } catch {}
    if (!isCard) continue;

    const btns = await c.$$("button");
    if (!btns.length) continue;

    const circle = [];
    for (const b of btns) {
      const ok = await b.evaluate((el) => {
        try {
          const r = el.getBoundingClientRect();
          if (!r || r.width < 40 || r.height < 40) return false;
          const approxSquare = Math.abs(r.width - r.height) <= 16;
          const hasIcon = !!el.querySelector("svg");
          return approxSquare && hasIcon;
        } catch { return false; }
      });
      if (ok) circle.push(b);
    }
    const chosen = circle.length ? circle[circle.length - 1] : btns[btns.length - 1];
    if (chosen) buttons.push(chosen);
  }
  // dedup
  const uniq = [];
  for (const b of buttons) {
    let dup = false;
    for (const u of uniq) {
      const same = await page.evaluate((a, b2) => a === b2, u, b).catch(() => false);
      if (same) { dup = true; break; }
    }
    if (!dup) uniq.push(b);
  }
  return uniq;
}

/* ====== Fallback por título: rolagem + XPath translate + scanner ====== */
async function openDisciplineByTitle(page, title) {
  await page.goto(COURSE_URL, { waitUntil: "networkidle2" });

  // 0) garantir que a grid carregou algo de conteúdo
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

  // função que tenta localizar e clicar no card/título no contexto da página
  const tryOpen = async () => {
    return page.evaluate((titleIn) => {
      const title = titleIn;

      const norm = (s) => (s || "")
        .toString()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase();

      const isBigBox = (el) => {
        const r = el.getBoundingClientRect();
        return r && r.width >= 280 && r.height >= 160;
      };
      const hasDigitalEad = (el) => {
        const t = norm(el.innerText || "");
        return t.includes("digital (ead)") || t.includes("continue de onde parou");
      };
      const isArrowButton = (btn) => {
        try {
          const r = btn.getBoundingClientRect();
          if (!r || r.width < 36 || r.height < 36) return false;
          const approxSquare = Math.abs(r.width - r.height) <= 20;
          const hasIcon = !!btn.querySelector("svg");
          return approxSquare && hasIcon;
        } catch { return false; }
      };
      const click = (el) => { el.scrollIntoView({ block: "center" }); el.click(); return true; };

      // a) XPath/translate sem acento
      const AC1 = "ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇç";
      const AC2 = "AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCc";
      const xTitle = `
        //*[contains(
          translate(normalize-space(string(.)),
            '${AC1}', '${AC2}'
          ),
          translate('${title}', '${AC1}', '${AC2}')
        )]
      `;
      const xp = document.evaluate(xTitle, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const nodes = [];
      for (let i = 0; i < xp.snapshotLength; i++) {
        const el = xp.snapshotItem(i);
        const r = el.getBoundingClientRect();
        if (r && (r.width || r.height)) nodes.push(el);
      }

      // b) Scanner por nós de texto (caso XPath falhe em algum shadow/normalize)
      if (!nodes.length) {
        const all = Array.from(document.querySelectorAll("body *")).filter(e => {
          try {
            const t = norm(e.textContent || "");
            const r = e.getBoundingClientRect();
            return t.includes(norm(title)) && r && (r.width || r.height);
          } catch { return false; }
        });
        nodes.push(...all);
      }
      if (!nodes.length) return false;

      // c) Subir ao card e procurar seta
      const candidates = [];
      for (const el of nodes) {
        let card = el;
        for (let j = 0; j < 10 && card; j++) {
          if (card.matches && (card.matches("article, section") || isBigBox(card) || hasDigitalEad(card))) break;
          card = card.parentElement;
        }
        if (!card) continue;
        candidates.push({ el, card });
      }
      if (!candidates.length) return false;

      // seta no card
      for (const { card } of candidates) {
        const btns = Array.from(card.querySelectorAll("button"));
        let arrow = null;
        for (const b of btns) if (isArrowButton(b)) arrow = b;
        if (arrow) return click(arrow);
      }
      // clique no card
      for (const { card } of candidates) return click(card);

      // d) Seta mais próxima do texto
      const arrows = Array.from(document.querySelectorAll("button")).filter(isArrowButton);
      if (!arrows.length) return false;
      const dist = (a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const ax = ra.left + ra.width / 2, ay = ra.top + ra.height / 2;
        const bx = rb.left + rb.width / 2, by = rb.top + rb.height / 2;
        return Math.hypot(ax - bx, ay - by);
      };
      let best = null, bestD = Infinity;
      for (const { el } of candidates) {
        for (const ar of arrows) {
          const d = dist(el, ar);
          if (d < bestD) { bestD = d; best = ar; }
        }
      }
      if (best) return click(best);
      return false;
    }, title);
  };

  // 1) esperar o título estar no DOM (sem acentos) — com timeout pequeno
  const seen = await page.waitForFunction(
    (t) => {
      const n = s => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
      return n(document.body.innerText || "").includes(n(t));
    },
    { timeout: 6000 }
  , title).catch(() => null);

  // 2) varredura com rolagem: topo → várias telas para forçar lazy-load/virtualização
  const maxSteps = 12; // ~6 telas completas
  for (let step = -1; step < maxSteps; step++) {
    if (step === -1) { await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {}); }
    else { await page.evaluate(() => window.scrollBy(0, window.innerHeight / 2)).catch(() => {}); }

    await page.waitForTimeout(350);
    const opened = await tryOpen();
    if (opened) {
      // aguarda transição SPA
      const ok = await new Promise(resolve => {
        const oldUrl = page.url();
        const start = Date.now();
        const loop = async () => {
          if (page.url() !== oldUrl) return resolve(true);
          const stillGrid = await page.evaluate(() => {
            const t = (document.body.innerText || "").toLowerCase();
            return t.includes("minhas disciplinas") || t.includes("continue de onde parou");
          }).catch(() => false);
          if (!stillGrid) return resolve(true);
          if (Date.now() - start > 10000) return resolve(false);
          setTimeout(loop, 250);
        };
        loop();
      });
      return ok;
    }
  }
  return false;
}

async function gotoHome(page) { await page.goto(COURSE_URL, { waitUntil: "networkidle2" }); }
async function openDisciplineByIndex(page, idx) {
  await gotoHome(page);
  const btns = await getOpenCourseButtons(page);
  if (!btns.length || idx >= btns.length) return false;
  return clickAndWaitSPA(page, btns[idx], 10000);
}

/* ================== Processamento de uma disciplina ================== */
async function processSingleDiscipline(page, maxItemsPerDiscipline = 5) {
  let processed = 0;
  while (processed < maxItemsPerDiscipline) {
    await clickPrimaryProgressButtons(page);
    try { await page.evaluate(() => { const v = document.querySelector("video"); if (v) v.play().catch(() => {}); }); } catch {}
    await waitMinimumWatchTime(page, 15);
    await markLessonCompleted(page);
    await findAndDoModuleTests(page);
    processed++;

    const backBtn = await findElementByText(page, "a, button", ["voltar", "retornar"]);
    if (backBtn) { try { await backBtn.click(); await page.waitForTimeout(900); } catch {} }
    else { try { await gotoHome(page); } catch {} break; }
  }
  console.log(`✅ Itens processados nesta disciplina: ${processed}`);
}

/* ================== Orquestrador ================== */
async function processAllDisciplines(page, maxDisciplines = 12) {
  console.log("🗂  Varredura das disciplinas…");
  await gotoHome(page);

  const btns = await getOpenCourseButtons(page);
  const total = Math.min(maxDisciplines, btns.length);

  if (!total && COURSE_TITLES.length) {
    console.log("ℹ️ Nenhum botão detectado — usando fallback por TÍTULO…");
    for (const title of COURSE_TITLES) {
      console.log(`\n=== 🎯 Tentando abrir por título: ${title} ===`);
      const opened = await openDisciplineByTitle(page, title);
      if (!opened) { console.log(`↷ Não consegui abrir "${title}". Pulando…`); continue; }
      try { await processSingleDiscipline(page, 5); } catch (e) { console.warn("⚠️ Erro na disciplina:", e.message); }
      try { await gotoHome(page); } catch {}
    }
    console.log("\n✅ Varredura concluída (fallback por título).");
    return;
  }

  if (!total) { console.log("ℹ️ Nenhum botão de abrir disciplina encontrado no grid."); return; }

  console.log(`📦 Detectados ${btns.length} cards • Processando até ${total}.`);
  for (let i = 0; i < total; i++) {
    console.log(`\n=== 📚 Disciplina ${i + 1}/${total} ===`);
    const opened = await openDisciplineByIndex(page, i);
    if (!opened) { console.log(`↷ Clique não abriu a disciplina ${i + 1}. Pulando…`); continue; }
    try { await processSingleDiscipline(page, 5); } catch (e) { console.warn("⚠️ Erro na disciplina:", e.message); }
    try { await gotoHome(page); } catch {}
  }
  console.log("\n✅ Varredura concluída.");
}

/* ================== Execução/Scheduler ================== */
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
    async () => { try { await processCourseOnce(); } catch (e) { console.error("Erro no agendamento:", e.message); } },
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
