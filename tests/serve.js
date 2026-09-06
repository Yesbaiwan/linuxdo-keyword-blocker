'use strict';
// ============================================================================
// Chrome DevTools MCP 测试配套的本地静态服务
// ============================================================================
// linux.do 页面里的测试通过「同步 XHR」从这里拉取被测脚本与测试源码
// （站点 CSP 没有 connect-src 限制，localhost 可访问；同步 XHR 保证 eval
// 仍处于 evaluate 的同步栈内，不受 CSP 拦截——见 tests/README.md）。
//
// 用法：在项目任意位置执行  node tests/serve.js
// 服务根目录 = 本文件所在目录的上一级（项目根），监听 127.0.0.1:8123。
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8123;

http
  .createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`[lkcb-serve] http://127.0.0.1:${PORT}/  (root: ${ROOT})`);
  });
