// server.mjs
// Qeasy API サーバ（本番用 / CORS一元化 / Keepa + Qoo10 連携）
// ---------------------------------------------------------------------
// Endpoints
//  GET  /health
//  GET  /settings
//  POST /settings
//  GET  /items
//  POST /items                   { items: Item[] } を保存（上書き）
//  POST /items/refresh           { asins?: string[] } → items.json をAmazon情報で更新
//  POST /amazon/bulk             { asins: string[] }  → Keepaから一括取得
//  POST /qoo10/check-existing    { asins: string[] }  → 既存ASIN判定（SellerCode=AMZ-<ASIN>）
//  POST /qoo10/create-listings   { list: [{ asin, price, title, imageUrl?, categoryNo?, shippingCode?, stock?, jan? }...] }
//
// Storage
//  data/settings.json
//  data/items.json
//
// Required ENV (systemd の EnvironmentFile=.env などで注入):
//  PORT                (任意、省略時 4000)
//  ALLOW_ORIGIN        (許可Origin。カンマ区切り / "*" 可) 例: https://xxxxx.pages.dev,https://api.kendo-...
//  KEEPA_API_KEY       (Keepa)
//  KEEPA_DOMAIN        (任意、省略時 5: amazon.co.jp)
//  QOO10_API_KEY       (QAPIキー)
//  QOO10_USER_ID       (QSMログインID)
//  QOO10_USER_PW       (QSMログインPW)
//
// 注意
//  - CORS はこのファイル内で一元管理。Nginx等で Access-Control-* を追加しないでください。
//  - Keepa/Qoo10未設定時はローカル items.json にフォールバック（テスト運用可）
// ---------------------------------------------------------------------

import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// ====== 環境値 ======
const PORT = Number(process.env.PORT || 4000);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

const KEEPA_API_KEY = process.env.KEEPA_API_KEY || "";
const KEEPA_DOMAIN = Number(process.env.KEEPA_DOMAIN || 5); // 5=amazon.co.jp

const QOO10_API_KEY = process.env.QOO10_API_KEY || "";
const QOO10_USER_ID = process.env.QOO10_USER_ID || "";
const QOO10_USER_PW = process.env.QOO10_USER_PW || "";

// ====== パス・データ保存先 ======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const ITEMS_FILE = path.join(DATA_DIR, "items.json");

// ====== Express 準備（app.use は必ずこの生成“以降”に置く）======
const app = express();

// CDN/Varnish等向けに Vary: Origin を常に付与
app.use((req, res, next) => {
  res.setHeader("Vary", "Origin");
  next();
});

// 受信JSON
app.use(express.json({ limit: "1mb" }));

// ====== CORS（ここだけ / 重複禁止）======
const allowList = (ALLOW_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
const isAllowed = (origin) => {
  if (!origin) return true;              // curl 等
  if (allowList.includes("*")) return true;
  if (allowList.includes(origin)) return true;
  try {
    const u = new URL(origin);
    return allowList.some(p => {
      if (p.startsWith("https://*.")) {
        const base = p.slice("https://*.".length);
        return u.protocol === "https:" && (u.hostname === base || u.hostname.endsWith(`.${base}`));
      }
      if (p.startsWith("http://*.")) {
        const base = p.slice("http://*.".length);
        return u.protocol === "http:" && (u.hostname === base || u.hostname.endsWith(`.${base}`));
      }
      return false;
    });
  } catch { return false; }
};
const corsOptionsDelegate = (req, cb) => {
  const origin = req.headers.origin;
  cb(null, {
    origin: isAllowed(origin) ? origin : false,
    credentials: true,
    methods: ["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"],
    maxAge: 86400,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });
};
app.use(cors(corsOptionsDelegate));
app.options("*", cors(corsOptionsDelegate));

// ====== ユーティリティ ======
async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}
async function loadJson(file, def) {
  try {
    const t = await fs.readFile(file, "utf-8");
    return JSON.parse(t);
  } catch {
    return def;
  }
}
async function saveJson(file, data) {
  await ensureDataDir();
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}
async function loadSettings() {
  return await loadJson(SETTINGS_FILE, {});
}
async function saveSettingsData(s) {
  await saveJson(SETTINGS_FILE, s || {});
}
async function loadItems() {
  const a = await loadJson(ITEMS_FILE, []);
  return Array.isArray(a) ? a : [];
}
async function saveItemsData(a) {
  await saveJson(ITEMS_FILE, Array.isArray(a) ? a : []);
}
const toYen = (p) => (p && p > 0 ? Math.round(p / 100) : 0);

// ====== Keepa: Amazon情報取得 ======
async function getAmazonInfos(asins) {
  const unique = Array.from(
    new Set(
      (asins || [])
        .map((a) => String(a || "").trim().toUpperCase())
        .filter((a) => /^[A-Z0-9]{10}$/.test(a))
    )
  );
  if (!unique.length) return [];

  // フォールバック（Keepa未設定）
  if (!KEEPA_API_KEY) {
    const local = await loadItems();
    const now = new Date().toISOString();
    return unique.map((asin) => {
      const it = local.find(
        (x) => String(x.asin || "").toUpperCase() === asin
      );
      return it
        ? {
            asin,
            price: it.amazonPrice || 0,
            sellerCount: 5,
            title: it.name || asin,
            image: it.mainImage,
            isPrime: true,
            shipDays: 1,
            fetchedAt: now,
          }
        : {
            asin,
            price: 0,
            sellerCount: 0,
            title: asin,
            image: undefined,
            isPrime: true,
            shipDays: 3,
            fetchedAt: now,
          };
    });
  }

  const out = [];
  const chunk = 100;
  for (let i = 0; i < unique.length; i += chunk) {
    const part = unique.slice(i, i + chunk);
    const url =
      "https://api.keepa.com/product" +
      `?key=${encodeURIComponent(KEEPA_API_KEY)}` +
      `&domain=${KEEPA_DOMAIN}` +
      `&asin=${part.join(",")}` +
      "&stats=180&buybox=1&offers=20&history=0";

    let json;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      json = await r.json();
    } catch (e) {
      // 失敗したチャンクはダミーで埋めて継続
      for (const asin of part) {
        out.push({
          asin,
          price: 0,
          sellerCount: 0,
          title: asin,
          image: undefined,
          isPrime: true,
          shipDays: 3,
        });
      }
      continue;
    }

    for (const p of json.products || []) {
      const asin = String(p.asin || "").toUpperCase();
      if (!asin) continue;
      const stats = p.stats || {};
      const price =
        toYen(stats.buyBoxPrice) ||
        toYen(stats.current) ||
        toYen(p.newPrice) ||
        0;

      const sellerCount =
        (stats.offerCountFBA != null ? stats.offerCountFBA : stats.offerCountNew) ||
        0;

      let image;
      if (p.imagesCSV) {
        const first = String(p.imagesCSV).split(",")[0];
        if (first) image = `https://images-na.ssl-images-amazon.com/images/I/${first}`;
      }

      const isPrime =
        !!p.hasFBA ||
        !!p.fbaOffers ||
        (stats.offerCountFBA != null && stats.offerCountFBA > 0);

      out.push({
        asin,
        price,
        sellerCount,
        title: p.title || asin,
        image,
        isPrime,
        shipDays: isPrime ? 1 : 3,
      });
    }
  }
  return out;
}

// ====== Qoo10: 認証キー（SellerAuthKey） ======
let qoo10AuthCache = { key: "", expiresAt: 0 };
async function getQoo10SellerAuthKey() {
  const now = Date.now();
  if (qoo10AuthCache.key && now < qoo10AuthCache.expiresAt)
    return qoo10AuthCache.key;

  if (!QOO10_API_KEY || !QOO10_USER_ID || !QOO10_USER_PW) {
    throw new Error(
      "QOO10_API_KEY / QOO10_USER_ID / QOO10_USER_PW が未設定です。"
    );
  }

  const url =
    "https://api.qoo10.jp/GMKT.INC.Front.QAPIService/ebayjapan.qapi/CertificationAPI.CreateCertificationKey";
  const params = new URLSearchParams();
  params.set("returnType", "application/json");
  params.set("user_id", QOO10_USER_ID);
  params.set("pwd", QOO10_USER_PW);

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      GiosisCertificationKey: QOO10_API_KEY,
      QAPIVersion: "1.0",
    },
    body: params.toString(),
  });
  if (!r.ok) throw new Error(`Qoo10 auth HTTP ${r.status}`);
  const j = await r.json();
  if (j.ResultCode !== 0 || !j.ResultObject)
    throw new Error(`Qoo10 auth error Code=${j.ResultCode} Msg=${j.ResultMsg}`);

  qoo10AuthCache = { key: String(j.ResultObject), expiresAt: now + 45 * 60 * 1000 };
  return qoo10AuthCache.key;
}

// ====== Qoo10: 既存ASINチェック（SellerCode=AMZ-<ASIN>） ======
async function getExistingQoo10Asins(asins) {
  const target = Array.from(
    new Set(
      (asins || [])
        .map((a) => String(a || "").trim().toUpperCase())
        .filter((a) => /^[A-Z0-9]{10}$/.test(a))
    )
  );
  if (!target.length) return [];

  // 未設定 → items.json で擬似判定
  if (!QOO10_API_KEY || !QOO10_USER_ID || !QOO10_USER_PW) {
    const items = await loadItems();
    const set = new Set(
      items.filter((it) => it.qoo10Id).map((it) => String(it.asin || "").toUpperCase())
    );
    return target.filter((a) => set.has(a));
  }

  const sellerKey = await getQoo10SellerAuthKey();
  const found = new Set();
  const tset = new Set(target);

  let page = 1;
  const maxPage = 10;
  while (page <= maxPage && found.size < tset.size) {
    const url =
      "https://api.qoo10.jp/GMKT.INC.Front.QAPIService/ebayjapan.qapi/ItemsLookup.GetAllGoodsInfo";
    const params = new URLSearchParams();
    params.set("returnType", "application/json");
    params.set("Page", String(page));
    params.set("ItemStatus", ""); // 全状態

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        GiosisCertificationKey: sellerKey,
        QAPIVersion: "1.0",
      },
      body: params.toString(),
    });
    if (!r.ok) break;
    const j = await r.json();
    const arr = j?.ResultObject?.Items;
    if (!Array.isArray(arr) || !arr.length) break;

    for (const gd of arr) {
      const sc = String(gd.SellerCode || "").toUpperCase();
      if (!sc) continue;
      if (sc.startsWith("AMZ-")) {
        const asin = sc.slice(4);
        if (tset.has(asin)) found.add(asin);
      } else if (tset.has(sc)) {
        found.add(sc);
      }
    }
    page++;
  }
  return Array.from(found);
}

// ====== Qoo10: 新規出品 ======
async function qoo10CreateItem(payload) {
  const { asin, price, title, imageUrl, categoryNo, shippingCode, stock, jan } =
    payload || {};

  const sellerKey = await getQoo10SellerAuthKey();

  const params = new URLSearchParams();
  params.set("returnType", "application/json");
  if (categoryNo) params.set("SecondSubCat", String(categoryNo));
  params.set("ItemTitle", title);
  params.set("SellerCode", `AMZ-${asin}`);
  params.set("IndustrialCodeType", "J");
  params.set("IndustrialCode", jan || "");
  if (imageUrl) params.set("StandardImage", imageUrl);
  params.set("ItemPrice", String(price));
  params.set("ItemQty", String(stock || 1));
  params.set("ShippingNo", String(shippingCode || "0"));
  params.set("TaxRate", "S");
  params.set("ExpireDate", "2050-01-01");
  params.set("AvailableDateType", "0");
  params.set("AvailableDateValue", "3");
  params.set("AdultYN", "N");

  const url =
    "https://api.qoo10.jp/GMKT.INC.Front.QAPIService/ebayjapan.qapi/ItemsBasic.SetNewGoods";
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      GiosisCertificationKey: sellerKey,
      QAPIVersion: "1.1",
    },
    body: params.toString(),
  });
  if (!r.ok) throw new Error(`Qoo10 SetNewGoods HTTP ${r.status}`);
  const j = await r.json();
  if (j.ResultCode !== 0)
    throw new Error(`Qoo10 SetNewGoods error Code=${j.ResultCode} Msg=${j.ResultMsg}`);

  const obj = j.ResultObject || {};
  const qoo10ItemCode =
    obj.GdNo || obj.ItemCode || obj.item_code || obj.goodsNo || "";

  return { qoo10ItemCode, raw: j };
}

// ====== ルート ======
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// settings
app.get("/settings", async (_req, res) => {
  res.json(await loadSettings());
});
app.post("/settings", async (req, res) => {
  const incoming = req.body || {};
  await saveSettingsData(incoming);
  res.json({ ok: true });
});

// items
app.get("/items", async (_req, res) => {
  res.json(await loadItems());
});
app.post("/items", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  await saveItemsData(items);
  res.json({ ok: true, count: items.length });
});

// items/refresh
app.post("/items/refresh", async (req, res) => {
  const want = Array.isArray(req.body?.asins) ? req.body.asins : null;
  const items = await loadItems();
  const targetAsins = want?.length
    ? want
    : items.map((x) => String(x.asin || "")).filter(Boolean);

  const infos = await getAmazonInfos(targetAsins);
  const map = new Map(infos.map((i) => [i.asin, i]));
  for (const it of items) {
    const asin = String(it.asin || "").toUpperCase();
    const inf = map.get(asin);
    if (!inf) continue;
    it.amazonPrice = inf.price;
    it.amazonTitle = inf.title || it.amazonTitle;
    it.mainImage = inf.image || it.mainImage;
    it.isPrime = !!inf.isPrime;
    it.shipDays = inf.shipDays;
    it.updatedAt = new Date().toISOString();
  }
  await saveItemsData(items);
  res.json({ ok: true, updated: map.size });
});

// amazon/bulk
app.post("/amazon/bulk", async (req, res) => {
  const asins = Array.isArray(req.body?.asins) ? req.body.asins : [];
  const data = await getAmazonInfos(asins);
  res.json(data);
});

// qoo10/check-existing
app.post("/qoo10/check-existing", async (req, res) => {
  const asins = Array.isArray(req.body?.asins) ? req.body.asins : [];
  const existed = await getExistingQoo10Asins(asins);
  res.json(existed);
});

// qoo10/create-listings
app.post("/qoo10/create-listings", async (req, res) => {
  const list = Array.isArray(req.body?.list) ? req.body.list : [];

  if (!QOO10_API_KEY || !QOO10_USER_ID || !QOO10_USER_PW) {
    // ドライラン（資格なし）
    return res.json({
      ok: false,
      dryRun: true,
      reason: "Qoo10の資格情報が未設定です。env を設定してください。",
      received: list.length,
    });
  }

  const results = [];
  for (const p of list) {
    try {
      const r = await qoo10CreateItem(p);
      results.push({ asin: p.asin, ok: true, qoo10ItemCode: r.qoo10ItemCode });
    } catch (e) {
      results.push({ asin: p.asin, ok: false, error: String(e?.message || e) });
    }
  }
  res.json({ ok: true, results });
});

// 404
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not Found", path: req.path });
});

// エラーハンドラ
app.use((err, _req, res, _next) => {
  console.error("Unhandled Error:", err);
  res.status(500).json({ ok: false, error: String(err?.message || err) });
});

// ====== 起動 ======
app.listen(PORT, () => {
  console.log(`Qeasy server running on http://localhost:${PORT}`);
});
