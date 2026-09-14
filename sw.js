/* 虎头虎脑工作台 Service Worker —— 离线应用外壳缓存
 * v20：修复「测试哪条能通」永远卡在中途（实测卡在 3/4 不动）。
 *      根因：icsProbe 里的 fetch 没有任何超时。iOS Safari 的 fetch 默认超时长达 1~3 分钟，
 *      只要有一条线路静默挂起（既不回包也不报错，如 raw.githack.com），整个测速就永远不结束。
 *      修复：① 每条线路套 AbortController 硬超时 6 秒（fetchWithTimeout 支持追加选项）；
 *            ② 再加一道 14 秒看门狗兜底，任何情况下界面都会出结果；
 *            ③ 「直接打开验证」每条线路旁加「复制」按钮（事件委托，主脚本被 IIFE 包裹用不了内联 onclick）。
 * v19：订阅链路补强 ——
 *      ① ICS 头部新增 X-PUBLISHED-TTL / REFRESH-INTERVAL（PT15M）：告诉 iOS「这个日历每 15 分钟会变」，
 *         否则 iPhone 可能按默认的「每天/每周」才刷新一次，当天新加的日程要等很久才进手机。
 *      ② 订阅线路扩到 4 条（GitHub / jsDelivr / Statically / gitHack），全是单层 https。
 *      ③ 移除「在日历 App 中订阅」(webcal) 按钮 —— 该路径必然触发「不安全连接」，属死路。
 *      ④ 新增「直接打开验证」直链区：fetch 能通 ≠ iOS 日历进程能通，只能靠 Safari 直开确认。
 * v18 关键修复：删除「嵌套 URL」订阅线路 —— https://gh-proxy.com/https://raw.githubusercontent.com/…
 *      这种 URL 里再套一个完整 https 地址的写法，浏览器 fetch 能跑，但 iOS 日历订阅进程
 *      (dataaccessd) 的 URL 解析器不认内层协议头，会直接抛 "cannot connect using SSL"。
 * v17：日历订阅改为「多线路 + 一键测速」，默认 GitHub 直连。
 * v16：日历订阅地址曾改用 jsDelivr + 同步后主动清 CDN 缓存。
 * v15：HTML 改为 network-first。
 * 旧版(v14)对 index.html 用 cache-first，且各版本 sw.js 字节完全相同，
 * 导致浏览器认为 SW 无更新，PWA 被永久锁死在首次安装时缓存的旧页面，
 * 后续所有修复（含虎略财讯数据源）用户一律拿不到。
 * 切记：每次发版都要 bump 下面的 CACHE 版本号。
 */
const CACHE = 'wb-pwa-v20';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(ASSETS).catch(function () { return Promise.resolve(); });
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // 跨域数据请求（腾讯行情/东财行情/新闻接口）一律放行走网络，不进缓存
  if (url.origin !== self.location.origin) return;

  var isHtml = (req.mode === 'navigate') || /(\/index\.html|\/office-workspace\.html|\.html)$/.test(url.pathname) || url.pathname.endsWith('/');

  if (isHtml) {
    // 页面：network-first —— 保证每次打开都拿到服务器上最新的页面
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var cp = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); });
        }
        return res;
      }).catch(function () {
        // 离线兜底：回退缓存首页
        return caches.match(req).then(function (hit) {
          return hit || caches.match('./index.html');
        });
      })
    );
    return;
  }

  // 静态资源：cache-first
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var cp = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); });
        }
        return res;
      }).catch(function () { return hit; });
    })
  );
});
