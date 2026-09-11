'use strict';
// 本地跑真机回归：node tests/run.js [console|spa|perf|both]（默认 both），全绿退出码 0。
// 跑在测试专用 Chrome profile（默认 tests/.chrome-profile，可用 LKCB_CHROME_PROFILE 换），登录态每次从
// linux.do_cookies.txt 导入，失效就停下不跑（chrome.exe 路径可用 LKCB_CHROME 换）。
// 流程：connectOverCDP 挂上去 → 查环境干净 → 预热一轮 → 逐套导航 + 同步 XHR 注入 → 页面把结果 POST 回
// 本地 serve.js，这里只打摘要与失败明细。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const serve = require('./serve.js');

const SITE = 'https://linux.do/latest';
const PROFILE =
  process.env.LKCB_CHROME_PROFILE || path.join(__dirname, '.chrome-profile');
const COOKIE_FILE = path.join(__dirname, '..', 'linux.do_cookies.txt');
const CHROME =
  process.env.LKCB_CHROME ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageLogs = []; // 页面控制台里的报错，失败时一并打出来
const SUITE_TIMEOUT = 90000;
const SUITES = {
  console: { file: 'tests/suites/console.js', results: '__lkcbTestResults' },
  spa: { file: 'tests/suites/spa.js', results: '__lkcbSpaResults' },
  // 处理模式两跑都要：隐藏会把行从布局里摘掉、淡化只改透明度，抖动与开销不是一回事
  'perf-dim': { file: 'tests/suites/perf.js', mode: 'dim', results: '__lkcbPerfResults' },
  'perf-hide': { file: 'tests/suites/perf.js', mode: 'hide', results: '__lkcbPerfResults' },
};
const EXPAND = {
  console: ['console'],
  spa: ['spa'],
  perf: ['perf-dim', 'perf-hide'],
  both: ['console', 'spa', 'perf-dim', 'perf-hide'],
};

// 专用 profile 是我们自己建的、只导入 cookie，正常不该有会干扰测量的扩展。但 Chrome 会自带组件扩展
// （实测有 Adobe Acrobat、Web Store 付款），所以不能见扩展就拦，只认两类会污染测量的：
// 油猴（注入本脚本 → 双实例）与广告拦截（改 DOM / 拦请求）。按扩展 ID 判定，ID 是稳定的。
const POLLUTING_EXT = {
  dhdgffkkebhmkfjojejmpbldmpobfkfo: 'Tampermonkey',
  gcalenpjmijncebpfijmoaglllgpjagf: 'Tampermonkey Beta',
  cjpalhdlnbpafiamejdnhcphjbkeiagm: 'uBlock Origin',
  ddkjiahejlhfcafbddmgiahcphecmpfh: 'uBlock Origin Lite',
  gighmmpiobklfepjocnamgkkbiglidom: 'AdBlock',
  cfhdojbkjhnklbpkdaibdccddilifddb: 'Adblock Plus',
  bgnkhhnnamicmpeenaelnjfhikgbkllg: 'AdGuard',
};
function pollutingExtensions() {
  const dir = path.join(PROFILE, 'Default', 'Extensions');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((id) => POLLUTING_EXT[id])
    .map((id) => `${POLLUTING_EXT[id]}（${id}）`);
}

// Chrome 只有带 --remote-debugging-port 启动才会写这个文件；有它就能连上这个会话
function devtoolsEndpoint() {
  const file = path.join(PROFILE, 'DevToolsActivePort');
  const [port, wsPath] = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!port) throw new Error(`${file} 内容不合法，读不到端口`);
  return wsPath
    ? `ws://127.0.0.1:${port}${wsPath}`
    : `http://127.0.0.1:${port}`;
}

// 连调试专用 Chrome：没开就用专用 profile 起一个
async function connectChrome() {
  try {
    return await chromium.connectOverCDP(devtoolsEndpoint());
  } catch {
    /* 没开，或端口文件是上次残留，下面自己起 */
  }
  console.log(`[run] 起调试专用 Chrome：${PROFILE}`);
  if (!fs.existsSync(CHROME))
    throw new Error(`找不到 Chrome：${CHROME}（可用 LKCB_CHROME 指定路径）`);
  fs.mkdirSync(PROFILE, { recursive: true });
  spawn(
    CHROME,
    [
      `--user-data-dir=${PROFILE}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
    ],
    { detached: true, stdio: 'ignore' },
  ).unref();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(600);
    try {
      return await chromium.connectOverCDP(devtoolsEndpoint());
    } catch {
      /* 还没起来，继续等 */
    }
  }
  throw new Error(`等调试专用 Chrome 起来超时（profile：${PROFILE}）`);
}

// Netscape cookie 文件 → Playwright cookie 数组（#HttpOnly_ 开头的行是数据，不能当注释丢掉）
function loadCookies() {
  if (!fs.existsSync(COOKIE_FILE))
    throw new Error(
      `找不到 ${COOKIE_FILE}\n请先导出 linux.do 的 cookie（Netscape 格式）放到项目根目录，我再重跑。`,
    );
  const text = fs.readFileSync(COOKIE_FILE, 'utf8');
  const cookies = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
    const [domain, , cookiePath, secure, expires, name, value] = line
      .replace(/^#HttpOnly_/, '')
      .split('\t');
    if (!name) continue;
    cookies.push({
      name,
      value,
      domain,
      path: cookiePath || '/',
      secure: secure === 'TRUE',
      expires: Number(expires) > 0 ? Number(expires) : -1,
    });
  }
  return cookies;
}

// 打开首页，等登录态与列表出现
async function gotoReady(page) {
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page
    .waitForFunction(
      () =>
        !!document.getElementById('current-user') &&
        document.querySelectorAll('tr.topic-list-item').length > 0,
      null,
      { timeout: 45000 },
    )
    .then(() => true)
    .catch(() => false);
}

async function runSuite(page, name) {
  const spec = SUITES[name];
  serve.clearResult();
  pageLogs.length = 0; // 只留这一套的页面报错
  console.log(`\n--- ${name} ---`);
  const ready = await gotoReady(page);
  if (!ready) {
    console.log(
      '❌ 页面没就绪（未登录 / 列表没出来）—— 登录态来自 linux.do_cookies.txt，过期了就重新导出一份',
    );
    return false;
  }
  // 注入前先确认页面里没有别的实例（真实油猴在跑的话，双实例互踩，结果不可信）
  const dirty = await page.evaluate(
    () =>
      !!window.__lkcbLoaded ||
      !!document.getElementById('lkcb-panel') ||
      !!document.getElementById('lkcb-overlay'),
  );
  if (dirty) {
    console.log(
      '❌ 注入前就发现页面里已经有脚本实例（真实油猴装了这个脚本？）——双实例结果不可信，停在这一步不测了',
    );
    return false;
  }
  // 注入：同步 XHR 拉源码 + eval 必须落在 evaluate 的同步栈内，否则被站点 CSP 拦
  await page.evaluate((spec) => {
    const get = (url) => {
      const x = new XMLHttpRequest();
      x.open('GET', url, false);
      x.send(null);
      if (x.status !== 200) throw new Error('fetch fail ' + url);
      return x.responseText;
    };
    window.__LKCB_SOURCE__ = get('http://127.0.0.1:8123/ld-blocker.user.js');
    if (spec.mode) window.__LKCB_PERF_MODE__ = spec.mode; // perf 用它决定隐藏 / 淡化
    (0, eval)(get('http://127.0.0.1:8123/' + spec.file));
  }, { file: spec.file, mode: spec.mode || '' });

  let report;
  try {
    report = await serve.waitResult(name, SUITE_TIMEOUT);
  } catch (e) {
    // 页面没推回结果（套件卡住 / 抛错）：试着直接从页面读一次
    const results = await page
      .evaluate((key) => window[key], spec.results)
      .catch(() => null);
    if (!results) {
      console.log(`❌ ${e.message}`);
      return false;
    }
    report = {
      suite: name,
      total: results.length,
      failures: results.filter((r) => !r.ok),
    };
  }
  console.log(serve.summarize(report));
  const ok = !report.failures?.length;
  // 失败时把页面报错也带上，省得再单独去捞一次
  if (!ok && pageLogs.length)
    console.log('   页面报错：\n     ' + pageLogs.slice(-5).join('\n     '));
  return ok;
}

async function main() {
  const which = (process.argv[2] || 'both').toLowerCase();
  const names = EXPAND[which];
  if (!names) throw new Error(`未知套件 ${which}，可用：console | spa | perf | both`);

  let server = null;
  let browser = null;
  let page = null;
  let allOk = true;
  try {
    try {
      server = await serve.start(serve.PORT, { quiet: true });
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      console.log(`[run] ${serve.PORT} 已被占用，复用已在跑的 serve`);
    }
    browser = await connectChrome();
    // 专用 profile 里被装了干扰扩展就先停（Chrome 自带的组件扩展不算），别带着污染测
    const exts = pollutingExtensions();
    if (exts.length) {
      console.log('\n❌ 测试专用 profile 里装了会干扰测量的扩展，先停下不测了：');
      console.log('   ' + exts.join('、'));
      console.log(`   把它们从 ${PROFILE} 里清掉，我再重跑。`);
      process.exitCode = 1;
      return;
    }
    const context = browser.contexts()[0];
    if (!context) throw new Error('连上了 Chrome，但里面没有可用窗口');
    await context.addCookies(loadCookies()); // 登录态以 linux.do_cookies.txt 为准，每次导入
    // 复用 Chrome 启动时那个空白标签页，不另开：否则测完只关掉自己开的那个，会剩一个空白页
    page = context.pages()[0] || (await context.newPage());
    page.on('pageerror', (e) => pageLogs.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') pageLogs.push('console error: ' + m.text());
    });

    // 先空跑一轮把页面/缓存带热：perf 量的是热页面（冷缓存那一下被站点自身加载 + hydration 拖着走）
    console.log('[run] 预热一轮页面加载…');
    const warm = await gotoReady(page);
    if (!warm) {
      // 登录态来自 linux.do_cookies.txt：失效就别往下测了，等用户换 cookie
      const loggedIn = await page
        .evaluate(() => !!document.getElementById('current-user'))
        .catch(() => false);
      console.log(
        loggedIn
          ? '❌ 页面列表没出来（站点可能抽风），稍后重跑一次'
          : '❌ 没登录上：linux.do_cookies.txt 里的 cookie 失效了。\n' +
              '   请你重新导出一份换掉它，我再重跑；在那之前我不会继续测任何东西。',
      );
      process.exitCode = 1;
      return;
    }
    await sleep(2500);

    for (const [i, name] of names.entries()) {
      if (i) await sleep(2000); // 站点有速率限制：套件之间别贴着脸刷新页面
      allOk = (await runSuite(page, name)) && allOk;
    }
    console.log(
      allOk ? '\n全部通过' : '\n有失败项，明细见上；完整结果在 tests/.last-result.json',
    );
    process.exitCode = allOk ? 0 : 1;
  } finally {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {}); // connectOverCDP：只断开连接，不会关掉你的浏览器
    server?.close();
  }
}

main().catch((e) => {
  console.error('[run] 出错：', String(e.stack || e).slice(0, 600));
  process.exitCode = 1;
});
