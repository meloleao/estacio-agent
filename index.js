// index.js
import puppeteer from "puppeteer";
import cron from "node-cron";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const EMAIL = process.env.ESTACIO_EMAIL;
const SENHA = process.env.ESTACIO_SENHA;
const COURSE_URL = process.env.COURSE_URL || "https://estudante.estacio.br/disciplinas";
const COOKIES_BASE64 = process.env.COOKIES_BASE64 || null;
const RUN_IMMEDIATELY = (process.env.RUN_IMMEDIATELY === "true");
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 7 * * *"; // every day 07:00
const TIMEZONE = process.env.TIMEZONE || "America/Sao_Paulo";
const HEADLESS = (process.env.HEADLESS !== "false");

if (!EMAIL || !SENHA) {
  console.warn("⚠️ ESTACIO_EMAIL e/ou ESTACIO_SENHA não definidos. Se estiver usando COOKIES_BASE64, tudo bem.");
}

// Se houver cookies base64 nas env vars, cria cookies.json localmente
if (COOKIES_BASE64) {
  try {
    const buff = Buffer.from(COOKIES_BASE64, "base64");
    fs.writeFileSync("./cookies.json", buff);
    console.log("✅ cookies.json criado a partir de COOKIES_BASE64.");
  } catch (err) {
    console.warn("⚠️ Falha ao gravar cookies a partir de COOKIES_BASE64:", err.message);
  }
}

async function ensureLoggedIn(page) {
  // tenta carregar cookies se existir arquivo
  try {
    if (fs.existsSync("./cookies.json")) {
      const cookies = JSON.parse(fs.readFileSync("./cookies.json", "utf8"));
      await page.setCookie(...cookies);
      console.log("✅ Cookies carregados de ./cookies.json");
    }
  } catch (err) {
    console.warn("⚠️ Erro ao carregar cookies:", err.message);
  }

  // vai para a página do curso e checa se já está logado
  await page.goto(COURSE_URL, { waitUntil: "domcontentloaded" });
  if (!page.url().includes("login")) {
    console.log("✅ Sessão aparentemente autenticada (URL:", page.url(), ")");
    return;
  }

  // se chegou aqui, precisa tentar login por credenciais (se fornecidas)
  if (!EMAIL || !SENHA) {
    console.log("❗ Não há credenciais e o usuário não está autenticado. Encerrando tentativa de login.");
    return;
  }

  console.log("🔑 Tentando login por credenciais...");
  await page.goto("https://estudante.estacio.br", { waitUntil: "domcontentloaded" });

  try {
    await page.waitForSelector("input[type='email'], input[name='email'], input#email", { timeout: 9000 });
    await page.type("input[type='email'], input[name='email'], input#email", EMAIL, { delay: 50 });
    await page.type("input[type='password'], input[name='password'], input[name='senha']", SENHA, { delay: 50 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(()=>{}),
      page.click("button[type='submit']").catch(()=>{})
    ]);

    // salva cookies após login se possível
    try {
      const cookies = await page.cookies();
      fs.writeFileSync("./cookies.json", JSON.stringify(cookies, null, 2));
      console.log("✅ Cookies salvos em ./cookies.json após login.");
    } catch (err) {
      console.warn("⚠️ Falha ao salvar cookies:", err.message);
    }

  } catch (err) {
    console.warn("⚠️ Login automático falhou:", err.message);
  }
}

async function waitMinimumWatchTime(page, minutes = 15) {
  const ms = minutes * 60 * 1000;
  console.log(`⏳ Aguardando ${minutes} minutos (tempo mínimo exigido)...`);
  // interação mínima periódica para evitar idle detection
  const step = 30 * 1000; // 30s
  let waited = 0;
  while (waited < ms) {
    await page.waitForTimeout(Math.min(step, ms - waited));
    try { await page.evaluate(() => { window.scrollBy(0, 100); }); } catch {}
    waited += Math.min(step, ms - waited);
  }
}

async function markLessonCompleted(page) {
  const [btn] = await page.$x("//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'concluir') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'finalizar')]");
  if (btn) {
    try {
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      console.log("✅ Botão 'Concluir/Finalizar' clicado.");
      return true;
    } catch (err) {
      console.warn("⚠️ Erro ao clicar no botão de concluir:", err.message);
      return false;
    }
  } else {
    console.log("⚠️ Botão de 'Concluir' não encontrado na página.");
    return false;
  }
}

// --- INÍCIO: Funções para localizar e responder testes ---
async function findAndDoModuleTests(page) {
  console.log("🔎 Procurando por testes/atividades no módulo...");
  const testKeywords = ['teste', 'atividade', 'avaliação', 'quiz', 'prova', 'múltipla escolha', 'atividade avaliativa'];

  const candidates = [];
  const els = await page.$$('a, button, span, div');
  for (const el of els) {
    try {
      const prop = await el.getProperty('innerText');
      const text = (await prop.jsonValue() || '').trim().toLowerCase();
      if (!text) continue;
      for (const kw of testKeywords) {
        if (text.includes(kw)) {
          let href = null;
          try { href = await el.getAttribute('href'); } catch {}
          candidates.push({ text: text.slice(0,200), href, elementHandle: el });
          break;
        }
      }
    } catch {}
  }

  // Deduplicate
  const unique = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = (c.href || '') + '|' + c.text;
    if (!seen.has(key)) { unique.push(c); seen.add(key); }
  }

  if (unique.length === 0) {
    console.log("ℹ️ Nenhuma atividade/teste encontrada nesta página.");
    return [];
  }

  console.log(`ℹ️ ${unique.length} potencial(ais) teste(s) encontrado(s).`);

  const results = [];
  for (const item of unique) {
    try {
      console.log("🔗 Abrindo atividade:", item.href || item.text.slice(0,60));
      if (item.href) {
        await page.goto(new URL(item.href, page.url()).toString(), { waitUntil: 'networkidle2' });
      } else {
        try { await item.elementHandle.click(); await page.waitForTimeout(1500); } catch {}
      }

      await page.waitForTimeout(1200);

      // localizar blocos de pergunta (heurística)
      let questionBlocks = await page.$$('.question, .questao, .q-item, .mcq, .enunciado, .question-block');
      if (!questionBlocks || questionBlocks.length === 0) {
        const allFieldsets = await page.$$('fieldset, .form-group, .Pergunta, .pergunta');
        questionBlocks = allFieldsets;
      }

      const radioInputs = await page.$$('input[type="radio"]');
      let answeredCount = 0;

      if (questionBlocks && questionBlocks.length > 0) {
        for (const qb of questionBlocks) {
          try {
            let qtext = '';
            try { qtext = (await (await qb.getProperty('innerText')).jsonValue() || '').trim(); } catch {}
            const optionLabels = await qb.$$('label, .option, .alternativa, .answer');
            const opts = [];
            for (const lab of optionLabels) {
              try {
                const labtxt = (await (await lab.getProperty('innerText')).jsonValue() || '').trim();
                opts.push({ el: lab, text: labtxt });
              } catch {}
            }

            let chosen = false;
            const qwords = qtext.toLowerCase().split(/\W+/).filter(w => w.length > 3).slice(0,6);
            if (qwords.length > 0 && opts.length > 0) {
              let best = { score: 0, idx: -1 };
              for (let i = 0; i < opts.length; i++) {
                const ot = opts[i].text.toLowerCase();
                let score = 0;
                for (const w of qwords) if (ot.includes(w)) score++;
                if (score > best.score) { best = { score, idx: i }; }
              }
              if (best.idx >= 0 && best.score > 0) {
                try { await opts[best.idx].el.click(); chosen = true; answeredCount++; } catch {}
              }
            }

            if (!chosen && opts.length > 0) {
              const pick = Math.floor(Math.random() * opts.length);
              try { await opts[pick].el.click(); answeredCount++; } catch {}
            }
          } catch {}
        }
      } else if (radioInputs && radioInputs.length > 0) {
        const groups = {};
        for (const r of radioInputs) {
          try {
            const name = await r.getAttribute('name');
            if (!name) continue;
            if (!groups[name]) groups[name] = [];
            groups[name].push(r);
          } catch {}
        }
        for (const name in groups) {
          const opts = groups[name];
          const choice = opts[Math.floor(Math.random() * opts.length)];
          try { await choice.click(); answeredCount++; } catch {}
        }
      } else {
        console.log("⚠️ Não encontrou perguntas estruturadas no teste atual.");
      }

      // Submeter (XPath)
      const submitXPaths = [
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'enviar')]",
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'finalizar')]",
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'submeter')]",
        "//button[@type='submit']"
      ];

      let submitted = false;
      for (const xp of submitXPaths) {
        try {
          const [btn] = await page.$x(xp);
          if (btn) {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(()=>{}),
              btn.click().catch(()=>{})
            ]);
            submitted = true;
            break;
          }
        } catch {}
      }

      if (!submitted) {
        try {
          const buttons = await page.$$('button');
          for (const b of buttons) {
            const txt = (await (await b.getProperty('innerText')).jsonValue() || '').toLowerCase();
            if (txt.includes('enviar') || txt.includes('finalizar') || txt.includes('submeter')) {
              await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(()=>{}),
                b.click().catch(()=>{})
              ]);
              submitted = true;
              break;
            }
          }
        } catch {}
      }

      await page.waitForTimeout(1200);

      // tentar extrair pontuação
      let score = null;
      try {
        const bodyText = await page.evaluate(() => document.body.innerText);
        const match = bodyText.match(/(\d{1,3})\s?%/);
        if (match) score = match[1] + '%';
      } catch {}

      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const shotPath = `./testshot_${ts}.png`;
      try { await page.screenshot({ path: shotPath, fullPage: false }); } catch {}

      results.push({
        title: item.text || 'Teste sem título',
        url: page.url(),
        answered: answeredCount,
        submitted,
        score: score || null,
        screenshot: shotPath
      });

      // opcional: volta pra pagina do curso principal (se aplicável)
      try { await page.goto(COURSE_URL, { waitUntil: 'networkidle2', timeout: 10000 }).catch(()=>{}); } catch {}
    } catch (err) {
      console.warn("⚠️ Erro ao processar atividade:", err.message);
      results.push({ title: item.text, url: item.href || null, error: err.message });
    }
  } // fim for each

  console.log("✅ Processamento de atividades concluído. Resultados:", results);
  return results;
}
// --- FIM: Funções para localizar e responder testes ---

async function processCourseOnce() {
  console.log("=== Início de execução: ", new Date().toLocaleString("pt-BR", { timeZone: TIMEZONE }) , " ===");
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage"
    ]
  });

  const page = await browser.newPage();

  try {
    await ensureLoggedIn(page);

    // Navega para o curso / disciplinas
    await page.goto(COURSE_URL, { waitUntil: "networkidle2" });

    // Tenta achar um link para conteúdos/aulas
    let lessonHref = null;
    try {
      const anchors = await page.$$("a");
      for (const a of anchors) {
        try {
          const href = await a.getAttribute("href");
          if (!href) continue;
          const low = href.toLowerCase();
          if (low.includes("conteudo") || low.includes("conteudos") || low.includes("aula") || low.includes("video") || low.includes("vídeo")) {
            lessonHref = new URL(href, page.url()).toString();
            break;
          }
        } catch {}
      }
    } catch (err) {
      console.warn("⚠️ Erro ao buscar links de aulas:", err.message);
    }

    if (!lessonHref) {
      console.log("ℹ️ Não encontrou link óbvio de aula nesta execução. Verifique seletores e DOM.");
      await browser.close();
      return;
    }

    console.log("🔗 Abrindo aula:", lessonHref);
    await page.goto(lessonHref, { waitUntil: "networkidle2" });

    // Tenta iniciar vídeo (elemento <video> ou botão play)
    try {
      const video = await page.$("video");
      if (video) {
        await page.evaluate(() => { const v = document.querySelector("video"); if (v) v.play().catch(()=>{}); });
        console.log("▶️ Elemento <video> encontrado e tentativa de play executada.");
      } else {
        const playBtn = await page.$x("//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'play') or contains(., '▶')]");
        if (playBtn && playBtn[0]) {
          await playBtn[0].click().catch(()=>{});
          console.log("▶️ Botão Play clicado.");
        } else {
          console.log("ℹ️ Não foi possível identificar elemento de vídeo; permanecendo na página por 15 minutos.");
        }
      }
    } catch (err) {
      console.warn("⚠️ Erro ao iniciar vídeo:", err.message);
    }

    // Espera o tempo mínimo com pequenas interações
    await waitMinimumWatchTime(page, 15);

    // Tenta marcar como concluída
    await markLessonCompleted(page);

    // screenshot de confirmação
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const shotPath = `./screenshot_${ts}.png`;
      await page.screenshot({ path: shotPath, fullPage: false });
      console.log("📸 Screenshot gerado:", shotPath);
    } catch (err) {
      // não crítico
    }

    // Agora procura e processa testes/atividades do módulo
    const tests = await findAndDoModuleTests(page);
    // salva resultados localmente para auditoria
    try {
      const fname = `./tests_result_${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
      fs.writeFileSync(fname, JSON.stringify(tests, null, 2));
      console.log("📄 Resultados dos testes salvos em:", fname);
    } catch (err) {
      console.warn("⚠️ Falha ao salvar resultados dos testes:", err.message);
    }

    console.log("=== Fim de execução ===");
    await browser.close();
  } catch (err) {
    console.error("❌ Erro durante a execução:", err.message);
    try { await browser.close(); } catch {}
  }
}

function startScheduler() {
  console.log(`🔁 Agendando execução diária com cron: "${CRON_SCHEDULE}" (timezone: ${TIMEZONE}).`);
  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      await processCourseOnce();
    } catch (err) {
      console.error("❌ Execução agendada falhou:", err.message);
    }
  }, {
    timezone: TIMEZONE
  });
}

// Início
(async () => {
  if (RUN_IMMEDIATELY) {
    console.log("⚡ RUN_IMMEDIATELY=true → executando uma vez agora...");
    await processCourseOnce();
  }
  startScheduler();
})();
