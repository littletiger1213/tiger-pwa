/* 虎头虎脑工作台 Service Worker —— 离线应用外壳缓存
 * v17：日历订阅改为「三线路 + 一键测速」——默认 GitHub 直连，可切 jsDelivr / 国内加速反代。
 * v16：日历订阅地址改用 jsDelivr（国内可达）+ 同步后主动清 CDN 缓存。
 * v15 关键修复：HTML 改为 network-first。
 * 旧版(v14)对 index.html 用 cache-first，且各版本 sw.js 字节完全相同，
 * 导致浏览器认为 SW 无更新，PWA 被永久锁死在首次安装时缓存的旧页面，
 * 后续所有修复（含虎略财讯数据源）用户一律拿不到。
 * 切记：每次发版都要 bump 下面的 CACHE 版本号。
 */
const CACHE = 'wb-pwa-v17';
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
