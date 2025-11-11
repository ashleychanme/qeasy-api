// server.mjs
// Qeasy APIサーバ本番版（Keepa + Qoo10連携込み）
//
// 提供エンドポイント:
//  GET  /health
//  GET  /settings
//  POST /settings
//  GET  /items
//  POST /items
//  POST /items/refresh
//  POST /amazon/bulk          ... KeepaでAmazon情報取得
//  POST /qoo10/check-existing ... Qoo10 APIで既存ASIN判定（SellerCode=AMZ-<ASIN>）
//  POST /qoo10/create-listings... Qoo10 ItemsBasic.SetNewGoodsで実出品
//
// ストレージ:
//  data/settings.json
//  data/items.json
//
// 必要な環境変数:
//  PORT                (任意、省略時 4000)
//  ALLOW_ORIGIN        (任意、省略時 "*")
//  KEEPA_API_KEY       (必須: Keepa)
//  KEEPA_DOMAIN        (任意、省略時 5: amazon.co.jp)
//  QOO10_API_KEY       (QAPI発行のAPIキー)
//  QOO10_USER_ID       (QSMログインID)
//  QOO10_USER_PW       (QSMログインPW)
//
// 注意:
//  - Qoo10関連envが未設定の場合はローカル items.json ベースで動作（テスト用）
//  - Keepa KEY未設定の場合もローカル items.json をフォールバック
//  - 本番運用時は必ず KEY 類を設定してください。

import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

/** ====== 前提設定 ====== */

const PORT = process.env.PORT || 4000;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

const KEEPA_API_KEY = process.env.KEEPA_API_KEY || "";
const KEEPA_DOMAIN = Number(process.env.KEEPA_DOMAIN || 5); // 5 = amazon.co.jp

// Qoo10: QAPIキー + QSMログイン情報
const QOO10_API_KEY = process.env.QOO10_API_KEY || "";
const QOO10_USER_ID = process.env.QOO10_USER_ID || "";
const QOO10_USER_PW = process.env.QOO10_USER_PW || "";

// Seller認証キー(SAK)キャッシュ
let qoo10AuthCache = {
  key: "",
  expiresAt: 0,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const ITEMS_FILE = path.join(DATA_DIR, "items.json");

async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error("dataディレクトリ作成に失敗:", e);
  }
}

/** ====== 共通ユーティリティ ====== */

async function loadJson(file, defaultValue) {
  try {
    const txt = await fs.readFile(file, "utf-8");
    return JSON.parse(txt);
  } catch {
    return defaultValue;
  }
}

async function saveJson(file, data) {
  await ensureDataDir();
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

async function loadSettings() {
  return await loadJson(SETTINGS_FILE, {});
}

async function saveSettingsData(settings) {
  await saveJson(SETTINGS_FILE, settings || {});
}

async function loadItems() {
  const list = await loadJson(ITEMS_FILE, []);
  return Array.isArray(list) ? list : [];
}

async function saveItemsData(items) {
  if (!Array.isArray(items)) items = [];
  await saveJson(ITEMS_FILE, items);
}

function toYen(p) {
  // Keepaは1/100通貨単位
  return p && p > 0 ? Math.round(p / 100) : 0;
}

/** ====== Keepa: Amazon情報取得 ====== */
/**
 * 戻り値: { asin, price, sellerCount, title, image, isPrime, shipDays }
 * - price: 円
 * - image: Amazon商品画像URL（あれば）
 */
async function getAmazonInfos(asins) {
  const uniqueAsins = Array.from(
    new Set(
      asins
        .map((a) => String(a || "").trim().toUpperCase())
        .filter((a) => /^[A-Z0-9]{10}$/.test(a))
    )
  );
  if (!uniqueAsins.length) return [];

  // Keepa未設定時は items.json からの簡易情報 or ダミーにフォールバック
  if (!KEEPA_API_KEY) {
    const items = await loadItems();
    const now = new Date().toISOString();
    return uniqueAsins.map((asin) => {
      const it = items.find((i) => String(i.asin || "").toUpperCase() === asin);
      if (it) {
        return {
          asin,
          price: it.amazonPrice || 0,
          sellerCount: 5,
          title: it.name || asin,
          image: it.mainImage,
          isPrime: true,
          shipDays: 1,
        };
      }
      return {
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

  const results = [];
  const chunkSize = 100; // Keepaは1リクエスト最大100ASINまで

  for (let i = 0; i < uniqueAsins.length; i += chunkSize) {
    const chunk = uniqueAsins.slice(i, i + chunkSize);

    const url =
      "https://api.keepa.com/product" +
      `?key=${encodeURIComponent(KEEPA_API_KEY)}` +
      `&domain=${KEEPA_DOMAIN}` +
      `&asin=${chunk.join(",")}` +
      "&stats=180&buybox=1&offers=20&history=0";

    let data;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error("Keepa HTTP error:", res.status, text);
        // このチャンクはダミーで返して続行
        for (const asin of chunk) {
          results.push({
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
      data = await res.json();
    } catch (e) {
      console.error("Keepa fetch error:", e);
      for (const asin of chunk) {
        results.push({
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

    if (!Array.isArray(data.products)) continue;

    for (const p of data.products) {
      const asin = String(p.asin || "").toUpperCase();
      if (!asin) continue;

      const stats = p.stats || {};

      const buyBoxPrice = toYen(stats.buyBoxPrice);
      const currentPrice = toYen(stats.current);
      const newPrice = toYen(p.newPrice);

      const price = buyBoxPrice || currentPrice || newPrice || 0;

      const sellerCount =
        (stats.offerCountFBA != null
          ? stats.offerCountFBA
          : stats.offerCountNew) || 0;

      let image;
      if (p.imagesCSV) {
        const first = String(p.imagesCSV).split(",")[0];
        if (first) {
          image = `https://images-na.ssl-images-amazon.com/images/I/${first}`;
        }
      }

      const isPrime =
        !!p.hasFBA ||
        !!p.fbaOffers ||
        (stats.offerCountFBA != null && stats.offerCountFBA > 0);

      results.push({
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

  return results;
}

/** ====== Qoo10: 認証 (CertificationAPI) ====== */

async function getQoo10SellerAuthKey() {
  const now = Date.now();
  if (qoo10AuthCache.key && now < qoo10AuthCache.expiresAt) {
    return qoo10AuthCache.key;
  }

  if (!QOO10_API_KEY || !QOO10_USER_ID || !QOO10_USER_PW) {
    throw new Error(
      "Qoo10 APIの認証情報(QOO10_API_KEY / QOO10_USER_ID / QOO10_USER_PW)が未設定です。"
    );
  }

  const url =
    "https://api.qoo10.jp/GMKT.INC.Front.QAPIService/ebayjapan.qapi/CertificationAPI.CreateCertificationKey";

  const params = new URLSearchParams();
  params.set("returnType", "application/json");
  params.set("user_id", QOO10_USER_ID);
  params.set("pwd", QOO10_USER_PW);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "GiosisCertificationKey": QOO10_API_KEY,
      "QAPIVersion": "1.0",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Qoo10認証HTTPエラー ${res.status} ${text}`);
  }

  const data = await res.json();
  if (data.ResultCode !== 0 || !data.ResultObject) {
    throw new Error(
      `Qoo10認証失敗 Code=${data.ResultCode} Msg=${data.ResultMsg || ""}`
    );
  }

  const sellerKey = String(data.ResultObject);
  // 約1時間有効 → 少し短めにキャッシュ
  qoo10AuthCache = {
    key: sellerKey,
    expiresAt: now + 45 * 60 * 1000,
  };

  return sellerKey;
}

/** ====== Qoo10: 既存商品チェック (ItemsLookup.GetAllGoodsInfo) ====== */
/**
 * このシステムでは SellerCode = "AMZ-<ASIN>" で登録する前提。
 * 既存商品の SellerCode を走査してターゲットASINと一致すれば「既存」と判定。
 * Qoo10未設定時は items.json の qoo10Id で判定。
 */
async function getExistingQoo10Asins(asins) {
  const target = Array.from(
    new Set(
      asins
        .map((a) => String(a || "").trim().toUpperCase())
        .filter((a) => /^[A-Z0-9]{10}$/.test(a))
    )
  );
  if (!target.length) return [];

  // Qoo10未設定 → ローカル items.json で簡易判定
  if (!QOO10_API_KEY || !QOO10_USER_ID || !QOO10_USER_PW) {
    const items = await loadItems();
    const set = new Set(
      items
        .filter((it) => it.qoo10Id)
        .map((it) => String(it.asin || "").toUpperCase())
    );
    return target.filter((asin) => set.has(asin));
  }

  const sellerKey = await getQoo10SellerAuthKey();
  const found = new Set();
  const targetSet = new Set(target);

  let page = 1;
  const maxPage = 10; // 必要に応じて増やす

  while (page <= maxPage && found.size < targetSet.size) {
    const url =
      "https://api.qoo10.jp/GMKT.INC.Front.QAPIService/ebayjapan.qapi/ItemsLookup.GetAllGoodsInfo";

    const params = new URLSearchParams();
    params.set("returnType", "application/json");
    params.set("Page", String(page));
    // ItemStatus を空 or "10"（販売中）のどちらにするかは運用次第
    params.set("ItemStatus", ""); // 全状態を見る

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "GiosisCertificationKey": sellerKey,
        "QAPIVersion": "1.0",
      },
      body: params.toString(),
    });

    if (!res.ok) {
      console.error(
        "Qoo10 GetAllGoodsInfo HTTPエラー:",
        res.status,
        await res.text().catch(() => "")
      );
      break;
    }

    const data = await res.json();
    const items = data.ResultObject?.Items;
    if (!Array.isArray(items) || items.length === 0) break;

    for (const gd of items) {
      const sc = String(gd.SellerCode || "").toUpperCase();
      if (!sc) continue;

      // 想定: SellerCode = "AMZ-<ASIN>"
      if (sc.startsWith("AMZ-")) {
        const asin = sc.slice(4);
        if (targetSet.has(asin)) {
          found.add(asin);
        }
      } else if (targetSet.has(sc)) {
        // SellerCodeにASIN直書きパターンも一応ケア
        found.add(sc);
      }
    }

    page++;
  }

  return Array.from(found);
}

/** ====== Qoo10: 新規出品 (ItemsBasic.SetNewGoods) ====== */

async function qoo10CreateItem(payload) {
  const {
    asin,
    price,
    title,
    imageUrl,
    categoryNo,
    shippingCode,
    stock,
    jan,          // ★追加
  } = payload;


  const sellerKey = await getQoo10SellerAuthKey();

  const params = new URLSearchParams();
  params.set("returnType", "application/json");
  // カテゴリ番号は Qoo10の SecondSubCat（サブカテゴリ）想定（運用に合わせて調整）
  if (categoryNo) {
    params.set("SecondSubCat", String(categoryNo));
  }
  params.set("ItemTitle", title);
  params.set("SellerCode", `AMZ-${asin}`); // ★ ASIN紐付け
  params.set("IndustrialCodeType", "J"); // JAN
  params.set("IndustrialCode", jan || ""); // ★ここでJAN使用

  if (imageUrl) {
    params.set("StandardImage", imageUrl);
  }
  params.set("ItemPrice", String(price));
  params.set("ItemQty", String(stock || 1));
  params.set("ShippingNo", String(shippingCode || "0"));
  params.set("TaxRate", "S");
  params.set("ExpireDate", "2050-01-01");
  params.set("AvailableDateType", "0");
  params.set("AvailableDateValue", "3");
  params.set("AdultYN", "N");
  // 説明文やキーワードは運用に合わせてここに追加可能:
  // params.set("PromotionName", "...");
  // params.set("ItemDescription", "...");

  const url =
    "https://api.qoo10.jp/GMKT.INC.Front.QAPIService/ebayjapan.qapi/ItemsBasic.SetNewGoods";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "GiosisCertificationKey": sellerKey,
      "QAPIVersion": "1.1",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Qoo10 SetNewGoods HTTP ${res.status} ${text}`);
  }

  const data = await res.json();
  if (data.ResultCode !== 0) {
    throw new Error(
      `Qoo10 SetNewGoods error Code=${data.ResultCode} Msg=${data.ResultMsg || ""}`
    );
  }

  const obj = data.ResultObject || {};
  const qoo10ItemCode =
    obj.GdNo || obj.ItemCode || obj.item_code || obj.goodsNo || "";

  return {
    qoo10ItemCode,
    raw: data,
  };
}

/** ====== Express セットアップ ====== */

const app = express();

app.use(
  cors({
    origin: ALLOW_ORIGIN === "*" ? true : ALLOW_ORIGIN,
    credentials: true,
  })
);
app.use(express.json({ limit: "2mb" }));

/** ====== /health ====== */

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/** ====== settings ====== */

app.get("/settings", async (req, res) => {
  const settings = await loadSettings();
  res.json(settings);
});

app.post("/settings", async (req, res) => {
  const settings = req.body || {};
  await saveSettingsData(settings);
  res.json({ ok: true });
});

/** ====== items ====== */

app.get("/items", async (req, res) => {
  const items = await loadItems();
  res.json(items);
});

app.post("/items", async (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  await saveItemsData(items);
  res.json({ ok: true, count: items.length });
});

/** ====== /items/refresh (定期バッチ連携用) ====== */
/**
 * items.json 内のASINに対して Keepa で最新情報取得し、
 * price / image / inStock / updatedAt を更新。
 * cronから叩いてもOK。
 */
app.post("/items/refresh", async (req, res) => {
  const items = await loadItems();
  if (!items.length) {
    return res.json({ ok: true, updated: 0 });
  }

  const asins = Array.from(
    new Set(
      items
        .map((it) => String(it.asin || "").toUpperCase())
        .filter((a) => /^[A-Z0-9]{10}$/.test(a))
    )
  );

  const infos = await getAmazonInfos(asins);
  const infoMap = new Map(infos.map((i) => [i.asin, i]));
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  let updatedCount = 0;

  const newItems = items.map((it) => {
    const asin = String(it.asin || "").toUpperCase();
    const info = infoMap.get(asin);
    if (!info) return it;

    updatedCount++;
    return {
      ...it,
      asin,
      name: it.name || info.title || asin,
      amazonPrice: info.price || it.amazonPrice || 0,
      mainImage: info.image || it.mainImage,
      inStock: info.price > 0,
      updatedAt: now,
    };
  });

  await saveItemsData(newItems);

  res.json({ ok: true, updated: updatedCount });
});

/** ====== /amazon/bulk ====== */

app.post("/amazon/bulk", async (req, res) => {
  const { asins } = req.body || {};
  if (!Array.isArray(asins)) {
    return res.status(400).json({ error: "asins[] is required" });
  }

  const cleaned = Array.from(
    new Set(
      asins
        .map((a) => String(a || "").trim().toUpperCase())
        .filter((a) => /^[A-Z0-9]{10}$/.test(a))
    )
  );

  const infos = await getAmazonInfos(cleaned);
  res.json(infos);
});

/** ====== /qoo10/check-existing ====== */

app.post("/qoo10/check-existing", async (req, res) => {
  const { asins } = req.body || {};
  if (!Array.isArray(asins)) {
    return res.status(400).json({ error: "asins[] is required" });
  }

  const cleaned = asins
    .map((a) => String(a || "").trim().toUpperCase())
    .filter((a) => /^[A-Z0-9]{10}$/.test(a));

  try {
    const existing = await getExistingQoo10Asins(cleaned);
    res.json(existing);
  } catch (e) {
    console.error("/qoo10/check-existing error:", e);
    // 失敗時は空配列返してUIを止めない
    res.json([]);
  }
});

/** ====== /qoo10/create-listings ====== */

app.post("/qoo10/create-listings", async (req, res) => {
  const body = req.body || {};
  const itemsPayload = Array.isArray(body.items) ? body.items : [];

  if (!itemsPayload.length) {
    return res.json([]);
  }

  let items = await loadItems();
  const asinIndex = new Map(
    items.map((it, idx) => [String(it.asin || "").toUpperCase(), idx])
  );

  const results = [];

  for (const payload of itemsPayload) {
    const asin = String(payload.asin || "").toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      results.push({
        asin,
        ok: false,
        message: "ASIN形式が不正です。",
        code: "INVALID_ASIN",
      });
      continue;
    }

    // Qoo10未設定 → ローカルitems.jsonのみ更新（テスト用）
    if (!QOO10_API_KEY || !QOO10_USER_ID || !QOO10_USER_PW) {
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);
      const fakeCode = `LOCAL-${asin}`;
      const idx = asinIndex.get(asin);
      if (idx != null) {
        items[idx] = {
          ...items[idx],
          qoo10Id: fakeCode,
          updatedAt: now,
        };
      } else {
        items.push({
          asin,
          name: payload.title || asin,
          qoo10Id: fakeCode,
          mainImage: payload.imageUrl,
          amazonPrice: payload.price || 0,
          inStock: true,
          updatedAt: now,
        });
      }
      results.push({
        asin,
        ok: true,
        qoo10ItemCode: fakeCode,
        message:
          "Qoo10 API未設定のためローカルのみ更新しました。（テスト用）",
      });
      continue;
    }

    // 本番: Qoo10へ実出品
    try {
      const { qoo10ItemCode } = await qoo10CreateItem({
  asin,
  price: payload.price,
  title: payload.title,
  imageUrl: payload.imageUrl,
  categoryNo: payload.categoryNo,
  shippingCode: payload.shippingCode,
  stock: payload.stock,
  jan: payload.jan, // ★追加
});

      const now = new Date().toISOString().replace("T", " ").slice(0, 19);
      const idx = asinIndex.get(asin);
      if (idx != null) {
        items[idx] = {
          ...items[idx],
          qoo10Id: qoo10ItemCode,
          updatedAt: now,
        };
      } else {
        items.push({
          asin,
          name: payload.title || asin,
          qoo10Id: qoo10ItemCode,
          mainImage: payload.imageUrl,
          amazonPrice: payload.price || 0,
          inStock: true,
          updatedAt: now,
        });
      }

      results.push({
        asin,
        ok: true,
        qoo10ItemCode,
        message: "Qoo10への出品が完了しました。",
      });
    } catch (e) {
      console.error("Qoo10 create-listing error:", e);
      results.push({
        asin,
        ok: false,
        message:
          e?.message ||
          "Qoo10出品API呼び出し中にエラーが発生しました。",
        code: "CREATE_FAILED",
      });
    }
  }

  await saveItemsData(items);
  res.json(results);
});

/** ====== サーバ起動 ====== */

ensureDataDir()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Qeasy server running on http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error("Failed to start server:", e);
    process.exit(1);
  });
