'use strict';
// 测试配套的本地服务，两个用途：
// 1. 静态托管脚本与套件源码（页面用同步 XHR 拉，保证 eval 落在 evaluate 的同步栈内，避开站点 CSP）。
//    只放行 SERVE_ALLOW 白名单，其余一律 403——项目根下有 cookie 文件，不能整目录暴露。
// 2. 接收套件 POST 回来的结果，落盘 tests/.last-result.json 并在终端打一行摘要。
// 平时不用手动起：run.js 内嵌启动；单独调试才 node tests/serve.js（摘要打在那个终端）。

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8123;
const RESULT_FILE = path.join(__dirname, '.last-result.json');
// 白名单：相对项目根、用 / 分隔；目录以 / 结尾
const SERVE_ALLOW = ['ld-blocker.user.js', 'tests/suites/', 'tests/fixtures/'];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST',
  'Access-Control-Allow-Headers': '*',
};

// 结果摘要：全绿一行，失败再列出条目与实际值
function summarize(report) {
  const failed = report.failures || [];
  const tail = report.metrics ? `（${report.metrics}）` : '';
  const line = `${report.suite}：${report.total - failed.length}/${report.total} 通过${tail}`;
  if (!failed.length) return `✅ ${line}`;
  return [
    `❌ ${line}`,
    ...failed.map((f) => `   · ${f.name}${f.detail ? ' —— ' + f.detail : ''}`),
  ].join('\n');
}

function handleResult(req, res, quiet) {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    res.writeHead(204, CORS).end();
    let report;
    try {
      report = JSON.parse(body);
    } catch {
      console.log('[serve] 收到的结果不是合法 JSON');
      return;
    }
    fs.writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
    if (!quiet) console.log(summarize(report));
  });
}

function handle(req, res, quiet) {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST' && url === '/__result')
    return handleResult(req, res, quiet);
  // 只放行页面真正要拉的东西：脚本本体、两套套件源码、性能规则 fixture。
  // 绝不能整目录暴露——项目根下就有 linux.do_cookies.txt，而这里带了 CORS *
  const file = path.resolve(ROOT, '.' + url);
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (
    rel.startsWith('..') ||
    !SERVE_ALLOW.some((p) => rel === p || rel.startsWith(p))
  )
    return res.writeHead(403, CORS).end('forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404, CORS).end('not found');
    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end(data);
  });
}

function start(port = PORT, { quiet = false } = {}) {
  const server = http.createServer((req, res) => handle(req, res, quiet));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolve({
        close: () => server.close(),
        url: `http://127.0.0.1:${port}`,
      }),
    );
  });
}

// 轮询结果文件等某个套件跑完（run.js 用）。每次跑之前要先 clearResult()，否则会读到上一轮的
function clearResult() {
  fs.rmSync(RESULT_FILE, { force: true });
}

async function waitResult(suite, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const report = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
      if (report.suite === suite) return report;
    } catch {
      /* 还没落盘，继续等 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`等 ${suite} 结果超时（${timeout}ms）`);
}

if (require.main === module) {
  start()
    .then((s) => console.log(`[serve] 已启动 ${s.url}/`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { start, waitResult, clearResult, summarize, PORT };
