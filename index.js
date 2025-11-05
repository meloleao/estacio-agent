import puppeteer from "puppeteer";

const EMAIL = process.env.ESTACIO_EMAIL;
const SENHA = process.env.ESTACIO_SENHA;

async function iniciar() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  console.log("Acessando plataforma...");
  await page.goto("https://estudante.estacio.br/disciplinas", { waitUntil: "networkidle2" });

  // Login
  if (page.url().includes("login")) {
    await page.type("input[type='email']", EMAIL);
    await page.type("input[type='password']", SENHA);
    await page.click("button[type='submit']");
    await page.waitForNavigation();
  }

  console.log("Login concluído. Buscando cursos...");
  await page.waitForSelector("a[href*='disciplinas/estacio_']");
  const cursos = await page.$$("a[href*='disciplinas/estacio_']");
  await cursos[0].click();

  console.log("Abrindo primeira aula não concluída...");
  await page.waitForSelector("a[href*='conteudos']");
  await page.click("a[href*='conteudos']");
  await page.waitForTimeout(1000 * 60 * 15); // aguarda 15 minutos

  console.log("Marcando aula como concluída...");
  const botaoConcluir = await page.$("button:contains('Concluir')") || await page.$("button:contains('Finalizar')");
  if (botaoConcluir) await botaoConcluir.click();

  console.log("Aula marcada. Encerrando sessão.");
  await browser.close();
}

iniciar();
