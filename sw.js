/* 虎头虎脑工作台 Service Worker —— 离线应用外壳缓存
 * v22：⭐ 找到「Safari 能打开、日历订阅却报 cannot connect using SSL」的真正根因 —— **证书信任库**，不是网络。
 *      GitHub Pages 的证书链是  *.github.io ← Let's Encrypt YR1 ← ISRG Root YR ← ISRG Root X1。
 *      `ISRG Root YR` 是 Let's Encrypt 2025-09 才生成的「Generation Y」新根，
 *      **Apple 当前信任库只收录了 ISRG Root X1/X2，尚未收录 Root YR**。
 *      iOS 对「未知根」的信任评估会在每次新 TLS 握手上卡住：Safari 能扛过去（白屏 8~25 秒），
 *      而系统日历进程 dataaccessd 等待上限更短 → 直接判成 SSL 连接失败。
 *      对策：**默认订阅线路改为 jsDelivr**（Sectigo 证书，根是 2004 年的 AAA Certificate Services，
 *      iOS 从第一代就信任），GitHub 直连退到第三位。实测 jsDelivr 连测 8/8 通过、1 秒内响应。
 * v21：两个真问题一起修 ——
 *      ① **Service Worker 会把 .ics 缓存下来**（原来走「静态资源 cache-first」），
 *         首次探测成功后，之后无论网络是否通，「测试哪条能通」都返回 ✓ —— 纯粹假阳性，
 *         会把用户引向一条其实不通的地址。现规定：**.ics / .txt 一律不拦**（不 respondWith，直接放行网络）。
 *      ② 仓库新增日历文件的**纯文本孪生 .txt**（内容一字不改，只是扩展名不同）。
 *         原因：**iOS Safari 不渲染 `text/calendar`**，打开 .ics 只会是一片空白（或直接下载），
 *         于是原先「Safari 直开能看到 BEGIN:VCALENDAR 才算通」这个判据本身是坏的。
 *         改成点 .txt 看文字 —— Safari 一定显示 text/plain，这才是可靠的可达性判据。
 *         订阅时仍用 .ics（`Content-Type: text/calendar` 是 iOS 订阅必需的）。
 * v20：修复「测试哪条能通」永远卡在中途（实测卡在 3/4 不动）。
 *      根因：icsProbe 里的 fetch 没有任何超时。iOS Safari 的 fetch 默认超时长达 1~3 分钟，
 *      只要有一条线路静默挂起（既不回包也不报错，如 raw.githack.com），整个测速就永远不结束。
 *      修复：① 每条线路套 AbortController 硬超时 6 秒（fetchWithTimeout 支持追加选项）；
 *            ② 再加一道 14 秒看门狗兜底，任何情况下界面都会出结果；
 *            ③ 「直接打开验证」每条线路旁加按钮（事件委托，主脚本被 IIFE 包裹用不了内联 onclick）。
 * v19：订阅链路补强 ——
 *      ① ICS 头部新增 X-PUBLISHED-TTL / REFRESH-INTERVAL（PT15M）：告诉 iOS「这个日历每 15 分钟会变」，
 *         否则 iPhone 可能按默认的「每天/每周」才刷新一次，当天新加的日程要等很久才进手机。
 *      ② 订阅线路扩到 4 条（GitHub / jsDelivr / Statically / gitHack），全是单层 https。
 *      ③ 移除「在日历 App 中订阅」(webcal) 按钮 —— 该路径必然触发「不安全连接」，属死路。
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
const CACHE = 'wb-pwa-v22';
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

  // ⚠️ 2026-09-14 关键修复：日历文件（.ics）与其纯文本孪生（.txt）**一律不拦**。
  //   1) 原来 .ics 走「静态资源 cache-first」，首次探测成功后就被缓存，
  //      之后「测试哪条能通」永远返回 ✓ —— 哪怕手机网络已断，是纯粹的假阳性，
  //      会把用户引向一条其实不通的订阅地址。放行后探测结果才是真的。
  //   2) Safari 直接打开这些地址时也交由网络处理，避免被缓存/离线兜底干扰判断。
  if (/\.(ics|txt)$/i.test(url.pathname)) return;

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
