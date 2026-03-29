const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const IDS = [
  44,77,124,128,136,137,139,140,148,152,153,160,162,167,169,173,
  176,178,180,181,182,183,184,186,187,190,191,193,206,209,210,220,
  229,230,237,238,240,248,249,257,259,264,267,280,282,283,290,291,
  294,295,298,299,301,303,304,305,307,311,312,313,315,318,320,328,
  329,330,332,333,335,336,337,339,340,345,346,347,349,350,354,355,
  356,359,360,366,371,372,378,380,387,395,397,398,399,401,403,406,
  409,410,413,414,415,417,418,419,423,427,428,429,431,434,436,437,
  439,440
];

let cachedData = [];
let isScraping = false;
let scrapeProgress = { done: 0, total: IDS.length, current: '', log: [], error: null };

async function getBrowser() {
  const puppeteer = require('puppeteer-core');
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';
  console.log('  🔍 Using Chrome at:', executablePath);
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions'
    ]
  });
  console.log('  ✅ Browser launched');
  return browser;
}

async function scrapeAgent(page, id) {
  try {
    await page.goto(`https://degen.virtuals.io/agents/${id}`, {
      waitUntil: 'networkidle2',
      timeout: 25000
    });
    await page.waitForSelector('[class*="font-mono"]', { timeout: 10000 }).catch(() => {});

    const data = await page.evaluate((agentId) => {
      const result = {
        id: agentId, name: `Agent #${agentId}`,
        realizedPnl: null, unrealizedPnl: null,
        roe: null, winRate: null, closedPos: null,
        volume: null, holdings: null, openPositions: null
      };
      const h1 = document.querySelector('h1');
      if (h1 && h1.textContent.trim().length < 60) result.name = h1.textContent.trim();

      function parseVal(str) {
        if (!str) return null;
        const s = str.trim();
        const neg = s.startsWith('-');
        const n = parseFloat(s.replace(/[^0-9.]/g, ''));
        return isNaN(n) ? null : (neg ? -n : n);
      }
      function parseWR(str) {
        if (!str) return null;
        const m = str.match(/(\d+)\s*%/);
        return m ? parseInt(m[1]) : null;
      }
      const divs = Array.from(document.querySelectorAll('div'));
      for (let i = 0; i < divs.length; i++) {
        const text = divs[i].textContent.trim();
        const next = divs[i].nextElementSibling;
        const nextText = next ? next.textContent.trim() : null;
        if (text === 'Realized PnL')     result.realizedPnl   = parseVal(nextText);
        if (text === 'Unrealized PnL')   result.unrealizedPnl = parseVal(nextText);
        if (text === 'ROE')              result.roe           = parseVal(nextText);
        if (text === 'Win Rate')         result.winRate       = parseWR(nextText);
        if (text === 'Closed Positions') result.closedPos     = parseInt(nextText) || null;
        if (text === 'Volume')           result.volume        = nextText;
        if (text === 'Holdings')         result.holdings      = nextText;
        if (text === 'Open Positions')   result.openPositions = parseInt(nextText) || null;
      }
      return result;
    }, id);

    data.totalPnl = +((data.realizedPnl ?? 0) + (data.unrealizedPnl ?? 0)).toFixed(2);
    return data;
  } catch(e) {
    return { id, name: `Agent #${id}`, realizedPnl: null, unrealizedPnl: null, roe: null, winRate: null, closedPos: null, totalPnl: null, error: e.message };
  }
}

async function scrapeAll() {
  if (isScraping) return;
  isScraping = true;
  scrapeProgress = { done: 0, total: IDS.length, current: 'Launching browser...', log: [], error: null };

  let browser;
  try {
    browser = await getBrowser();
  } catch(e) {
    scrapeProgress.error = 'Browser failed: ' + e.message;
    scrapeProgress.current = '— Failed —';
    isScraping = false;
    console.error('  ❌ Browser launch error:', e.message);
    return;
  }

  console.log('\n  🚀 Scraping', IDS.length, 'agents...\n');
  const CONCURRENCY = 3;
  const queue = [...IDS];
  const results = [];

  async function worker() {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    while (queue.length > 0) {
      const id = queue.shift();
      scrapeProgress.current = `Scraping #${id}...`;
      const data = await scrapeAgent(page, id);
      results.push(data);
      scrapeProgress.done++;
      const pct = Math.round((scrapeProgress.done / IDS.length) * 100);
      const ok = data.realizedPnl !== null;
      const msg = `${ok?'✓':'✗'} [${scrapeProgress.done}/${IDS.length}] #${id} ${data.name} (${pct}%)`;
      console.log(' ', msg);
      scrapeProgress.log.unshift(msg);
      if (scrapeProgress.log.length > 30) scrapeProgress.log.pop();
    }
    await page.close();
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();

  cachedData = results;
  scrapeProgress.current = '— Complete —';
  isScraping = false;

  try { fs.writeFileSync(path.join(__dirname, 'cache.json'), JSON.stringify(results, null, 2)); } catch(e) {}
  console.log(`\n  ✅ Done — ${results.filter(r=>r.realizedPnl!==null).length} / ${IDS.length} scraped\n`);
}

const cachePath = path.join(__dirname, 'cache.json');
if (fs.existsSync(cachePath)) {
  try { cachedData = JSON.parse(fs.readFileSync(cachePath, 'utf8')); console.log(`  📦 Cache: ${cachedData.length} agents`); } catch(e) {}
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url === '/api/data') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(cachedData)); return; }
  if (url === '/api/scrape') {
    if (isScraping) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({status:'already_running'})); return; }
    scrapeAll();
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({status:'started'})); return;
  }
  if (url === '/api/progress') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({...scrapeProgress,isScraping,cachedCount:cachedData.length})); return; }
  if (url === '/api/test') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({status:'ok',node:process.version,platform:process.platform,chrome:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/google-chrome-stable'})); return; }

  let filePath = path.join(__dirname, url==='/'?'index.html':url);
  const ext = path.extname(filePath);
  const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json'};
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200,{'Content-Type':mime[ext]||'text/plain'});
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ✅  Virtuals Degen — 114 agents · Port:', PORT);
  console.log('');
});
