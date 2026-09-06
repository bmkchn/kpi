import { useState, useEffect, useMemo, useCallback, useRef, Component, Fragment } from 'react';
import {
  Package, Plus, BarChart3, Boxes, X, Settings, Upload, Pencil, Trash2, Search,
  AlertTriangle, RotateCcw, ChevronRight, ChevronDown, Layers, Clock, Ban, TrendingUp, Truck, CalendarClock, GripVertical, PackageOpen,
} from 'lucide-react';

/* ============================================================
   定数・ユーティリティ
   ============================================================ */

const STORAGE_KEY = 'inventory-kpi:v18';
const SHARED = true;   // true にすると、このアーティファクトを開いた全員が同じデータを見ます
const HORIZON = 24;
const DAY = 86400000;

const uid = () => (crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const todayIso = () => iso(new Date());
const ymKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / DAY);
const fmtJp = (v) => { if (!v) return '—'; const [y, m, d] = String(v).split('-'); return `${y}年${Number(m)}月${Number(d)}日`; };

const sortLots = (lots) => [...lots].sort((a, b) => {
  if (!a.expiry && !b.expiry) return 0;
  if (!a.expiry) return 1;
  if (!b.expiry) return -1;
  return a.expiry.localeCompare(b.expiry);
});

const buildMonths = (startYM, count) =>
  Array.from({ length: count }, (_, i) => {
    const d = new Date(startYM.year, startYM.month - 1 + i, 1);
    const y = d.getFullYear(), m = d.getMonth() + 1;
    return { key: ymKey(y, m), year: y, month: m, label: `${m}月`, full: `${y}/${m}`, index: i };
  });

/** 発注の状態 */
const PO_STATUS = {
  ordered:   { label: '発注済み', tone: 'bg-gray-100 text-gray-700' },
  partial:   { label: '一部納品', tone: 'bg-amber-100 text-amber-800' },
  done:      { label: '納品完了', tone: 'bg-teal-100 text-teal-800' },
  completed: { label: '完了（手動）', tone: 'bg-violet-100 text-violet-800' },
  canceled:  { label: '取消',     tone: 'bg-gray-100 text-gray-400' },
};

/** 発注の単位。重量で発注し、袋で納品する商品に対応する */
const PO_UNITS = { bag: '袋', kg: 'kg' };

/** 途中経過として記録する項目。カテゴリーによって使う列が違う */
const STAGE_FIELDS = [
  { key: 'maker',   label: 'メーカー在庫', hint: '発注済みだが、まだ手元に来ていない分' },
  { key: 'partner', label: '協力先在庫',   hint: '検品・小分けの工程にある分' },
  { key: 'inspect', label: '検査ロス',     hint: '検品ではねた分' },
  { key: 'direct',  label: '直接受取',     hint: '工程を経ずに受け取った分' },
  { key: 'lossWeight', label: '粉末ロス',  hint: '重量発注で目減りした分（kg）' },
  { key: 'guarantee',  label: '保証分',    hint: '目減りを補うために上乗せされた分' },
];

/** 発注に紐づく納品の合計 */
const poReceived = (po) => (po.receipts ?? []).reduce((s2, r) => s2 + num(r.quantity), 0);

/** 発注数を納品の単位（袋）に換算する。重量発注なら内容量で割る */
const poOrderedInBags = (po) => {
  if (po.unit !== 'kg') return num(po.orderQty);
  const g = num(po.gramsPerBag);
  return g > 0 ? (num(po.orderQty) * 1000) / g : 0;
};

/**
 * 未製造の残り（袋）。歩留まりなどで発注数と納品数がぴったり一致しないことがあるため、
 * 手動で「完了」にした発注は、実際の差分に関わらず残り0として扱う（それ以上は仮在庫にも積まない）。
 */
const poRemaining = (po) => {
  if (po.status === 'completed') return 0;
  return Math.max(0, poOrderedInBags(po) - poReceived(po));
};

/** 発注の状態を自動で判定する。取消・完了は手動で固定した状態を優先する */
const poStatus = (po) => {
  if (po.status === 'canceled') return 'canceled';
  if (po.status === 'completed') return 'completed';
  const recv = poReceived(po);
  if (recv <= 0.001) return 'ordered';
  return poRemaining(po) > 0.5 ? 'partial' : 'done';
};

/** 原価の内訳。すべて任意。未入力なら合計だけを使う */
const COST_PARTS = [
  { key: 'material', label: '主原料' },
  { key: 'additive', label: '添加物' },
  { key: 'repack', label: 'リパック' },
  { key: 'label', label: 'ラベル' },
  { key: 'sticker', label: 'シール貼り' },
  { key: 'pouch', label: '包材' },
  { key: 'other', label: 'その他' },
];

/** 内訳（キーは何でもよい）の合計。合計が0なら、代わりに合計欄の値を使う */
const partsCost = (parts, fallback) => {
  const sum = Object.values(parts ?? {}).reduce((s2, v) => s2 + num(v), 0);
  return sum > 0 ? sum : num(fallback);
};

/** ロットの原価。内訳があれば合計、なければ入力した単価をそのまま使う */
const lotCost = (lot) => partsCost(lot?.costParts, lot?.cost);

/** 納品1回分の原価（1袋あたり）。仕入先ごとの内訳があれば合計、なければ入力した単価をそのまま使う */
const receiptCost = (r) => partsCost(r?.costParts, r?.cost);

/** シートの行ごとに、実績値の取得方法をメモできる項目 */
const NOTE_ROWS = {
  confirmedNew: '定期新規数（発送済み）',
  pendingCancelNew: 'キャンセル・保留',
  newCustomers: '合計新規数',
  subNew: '定期新規数',
  first: '初月発送',
  upsellUnits: 'アップセル初回発送数',
  firstBase: 'お試し発送',
  repeat: '2回目以降の定期件数',
  legacy: '昨年度からの継続',
  retention: '残存率',
  activity: '稼働率',
  upsellRate: 'アップセル率',
};

/** 商品の並べ替え */
const PRODUCT_SORTS = {
  manual: '手動（ドラッグで並べ替え）',
  share: '選択率の高い順',
  name: '商品名順',
};

/** 規格の表示順。定期を上に、見切りを最後に置く */
const specRank = (spec) => {
  if (spec.source === 'clearance') return 3;
  if (spec.source === 'cross') return 1;
  if (spec.source === 'remainder') return 0;
  return num(spec.marginMonths) > 0 ? 0 : 2;
};
/** 同じ区分の中では、規格に設定した表示順で並べる */
const specSort = (a, b) => (specRank(a) - specRank(b)) || (num(a.order) - num(b.order)) || a.name.localeCompare(b.name);
const RANK_LABEL = ['定期', 'クロスセル', '単品・サンプル', '見切り'];

/** 規格の件数の元 */
const SPEC_SOURCES = {
  first_base: { group: 'カテゴリー連動', label: '新規のうち、お試し発送のみ', hint: '継続顧客は含まない。当月の定期新規数 × (100% − アップセル率)。例）100g初回' },
  upsell: { group: 'カテゴリー連動', label: '新規のうち、本商品発送のみ', hint: '継続顧客は含まない。当月の定期新規数 × アップセル率' },
  first:  { group: 'カテゴリー連動', label: '初月発送（新規の全件）', hint: '1ヶ月に2回発送する方も件数に含みます' },
  repeat: { group: 'カテゴリー連動', label: '2回目以降のみ（アップセル分を除く）', hint: 'カテゴリーの「2回目以降」の行をそのまま使います' },
  repeat_upsell: { group: 'カテゴリー連動', label: '2回目以降 ＋ 新規の本商品発送分', hint: '2回目以降の定期件数 ＋ 定期新規数 × アップセル率' },
  all:    { group: 'カテゴリー連動', label: 'カテゴリーの出荷予測件数（全件）', hint: '初回＋2回目以降など、カテゴリーの合計をそのまま使います' },
  remainder:  { group: '計算で求める', label: '残り（全出荷件数から他の規格を引く）', hint: '例）800g … 出荷予測件数 − 100g − 1kg。途中でサイズ変更した分も拾えます' },
  legacy: { group: '実績から計算', label: '実績×継続率で減衰（新規は積み上がらない）', hint: '例）1kgのように、新規のお客様がもう選ばない・既存のお客様だけが使い続けるサイズ向け。出荷件数の実績（手入力・CSV取込）を入れた月を起点に、以降は 実績 × 継続率^経過月 で計算します。実績がない間は「開始件数×継続率」を使います' },
  cohort_legacy: { group: '実績から計算', label: '実績×継続率で減衰＋新規も積み上がる', hint: '例）800gのように、新規のお客様も選び続けつつ、追跡開始前からの既存客も少しずつ減っていくサイズ向け。各月の新規×その経過月の残存率×稼働率を積み上げ（今月分だけお試しを除く）＋ 開始件数×継続率^経過月' },
  cross: { group: 'その他', label: 'クロス（他の規格・カテゴリーの数字を参照）', hint: '参照先の出荷件数 × 割合。カテゴリーをまたいで選べます（例: ヘルシーの新規数にイヌメシを連動させる）' },
  clearance: { group: 'その他', label: '見切り消化（期限が近い在庫を捌く）', hint: '定期便に出せなくなった在庫を、上限の範囲で優先的に消化します' },
  manual: { group: 'その他', label: '月ごとに手入力', hint: '件数を直接入力します' },
};
const SPEC_SOURCE_GROUPS = ['カテゴリー連動', '実績から計算', '計算で求める', 'その他'];

const rate24 = (v) => Array.from({ length: HORIZON }, () => v);

/* ============================================================
   計算エンジン
   ============================================================ */

/**
 * カテゴリーの件数。
 *   合計新規     = 定期新規数（発送済み） + キャンセル・保留
 *   定期新規     = 合計新規 × 定期率
 *   コホート件数 = 定期新規 × 残存率[k] × 稼働率[k]
 *   昨年度       = 開始件数 × 継続率^経過月
 */
function categoryCounts(cat, months, ovFirst = () => null) {
  /* 「定期新規数（発送済み）」「キャンセル・保留」を使い始めたカテゴリーは、
     そちらを正として計算する（合計新規数の直接入力・定期率は使わない）。
     まだ使っていないカテゴリー（イヌメシなど）は、これまで通りの計算のままにする。 */
  const usesConfirmed = !!cat.useConfirmedModel;

  const rows = months.map((mo) => {
    const confirmedNew = num(cat.confirmedNew?.[mo.key]);
    const pendingCancelNew = num(cat.pendingCancelNew?.[mo.key]);
    return {
      ...mo, confirmedNew, pendingCancelNew,
      newTotal: usesConfirmed ? confirmedNew + pendingCancelNew : num(cat.newCustomers?.[mo.key]),
      subNew: 0, first: 0, repeat: 0, legacy: 0, all: 0,
      subNewAdjusted: false,
    };
  });

  const r0 = (num(cat.retention?.[0]) / 100) * (num(cat.activity?.[0]) / 100);

  months.forEach((mo, mi) => {
    /* 初月発送を手入力していたら、その件数になる人数までさかのぼって使う。
       こうすると翌月以降の「2回目以降」にも反映される */
    const forced = ovFirst(mo.key);
    let sub = usesConfirmed ? rows[mi].confirmedNew : rows[mi].newTotal * (num(cat.subscriptionRate, 100) / 100);
    if (forced !== null && r0 > 0) {
      sub = forced / r0;
      rows[mi].subNewAdjusted = true;
    }
    rows[mi].subNew = sub;
    if (sub <= 0) return;

    for (let k = 0; k < HORIZON && mi + k < months.length; k++) {
      const c = sub * (num(cat.retention?.[k]) / 100) * (num(cat.activity?.[k]) / 100);
      if (k === 0) rows[mi].first += c;
      /* 発送済み／キャンセル・保留で入力するカテゴリーは、2回目以降を実績の直接入力に置き換えるため、
         残存率・稼働率による積み上げはしない（下でrepeatActualに差し替える）。 */
      else if (!usesConfirmed) rows[mi + k].repeat += c;
    }
  });

  /* 発送済み／キャンセル・保留で入力するカテゴリーの「2回目以降」は、実績（手入力・CSV取込）が
     あればそれを使い、無い月（まだ実績が無い将来の予測月）は、確認済みの計算式で計算する。
       2回目以降[i] = 追跡開始月の実績 × 継続率^経過月
                    ＋ Σ(各月の新規 × その経過月の残存率 × 稼働率)　※今月分の新規だけは
                      「稼働率100%を超える分」だけを同月2回目としてここに含める
     「追跡開始月の実績」は、勝手な入力欄を別に持たず、シートの最初の月（months[0]）の
     「2回目以降」の実績（手入力・CSV取込の値）をそのまま使う。 */
  let computedRepeat = null;
  if (usesConfirmed) {
    const rate = num(cat.legacyRetention, 95) / 100;
    const anchor = num(cat.repeatActual?.[months[0]?.key]);
    computedRepeat = months.map((mo, i) => {
      let v = anchor * Math.pow(rate, i);
      for (let k = 0; k <= i; k++) {
        const src = rows[i - k];
        if (!src) continue;
        if (k === 0) {
          v += src.subNew * (num(cat.retention?.[0]) / 100) * (Math.max(0, num(cat.activity?.[0]) - 100) / 100);
        } else {
          v += src.subNew * (num(cat.retention?.[k]) / 100) * (num(cat.activity?.[k]) / 100);
        }
      }
      return Math.max(0, v);
    });
  }

  rows.forEach((r, i) => {
    r.upsellRate = num(cat.upsellRates?.[r.key], num(cat.upsellRateDefault));
    r.upsellUnits = r.subNew * (r.upsellRate / 100);
    r.firstBase = r.subNew * (1 - r.upsellRate / 100);
    /* 同月2回目（初月発送のうち、定期新規数を上回る分＝同じ月に2回発送された分）。
       表示のためにモードに関わらず常に計算する。 */
    r.firstExtra = Math.max(0, r.first - r.subNew);
    if (usesConfirmed) {
      /* 実績（手入力・CSV取込）があればそれを使い、無ければ計算式（computedRepeat）で埋める。
         「0」は未入力（消し忘れ・空欄クリック時の意図しない0）とみなし、計算式にフォールバックする。
         出荷予測件数は「初月発送」ではなく「定期新規数」を使う。初月発送には同月2回目
         （＝実質は2回目以降の一部）が混ざっており、実績の2回目以降と足すと重複するため。 */
      const actual = cat.repeatActual?.[r.key];
      const hasActual = actual !== undefined && actual !== null && actual !== '' && num(actual) > 0;
      r.repeat = hasActual ? num(actual) : (computedRepeat?.[i] ?? 0);
      r.repeatIsComputed = !hasActual;
      r.legacy = 0;
      r.all = r.subNew + r.repeat;
    } else {
      r.legacy = num(cat.legacyStart) * Math.pow(num(cat.legacyRetention, 90) / 100, i);
      r.all = r.first + r.repeat + r.legacy;
    }
  });
  return rows;
}

/** 規格の月次件数。catCounts は「カテゴリーID → categoryCounts()の行」の一覧（クロスでカテゴリーの数値に直接連動する場合に使う） */
function specCounts(spec, counts, months, specTotals, catCounts, cat) {
  if (spec.source === 'cross') {
    /* カテゴリーの数値に規格を経由せず直接連動する場合 */
    if (spec.crossFromMetric && spec.crossFromCategory) {
      const rows = catCounts?.get(spec.crossFromCategory);
      return months.map((mo, i) => (rows ? num(rows[i]?.[spec.crossFromMetric]) * (num(spec.crossRate) / 100) : 0));
    }
    const src = specTotals?.get(spec.crossFrom);
    return months.map((mo, i) => (src ? (src.orders[i] ?? 0) * (num(spec.crossRate) / 100) : 0));
  }
  if (spec.source === 'clearance' || spec.source === 'remainder') return months.map(() => 0);
  if (spec.source === 'cohort_legacy') {
    /* 新規の積み上げ＋開始時点の残り（レガシー）が減衰していく方式。
       例）6月 = (6月新規×残存率[0]×稼働率[0] − 6月お試し)
               + (5月新規×残存率[1]×稼働率[1])
               + (4月新規×残存率[2]×稼働率[2])
               + 開始件数 × 継続率^(経過月数)
       「お試し」を引くのは、その月に新規で入った人の分（k=0）だけ。 */
    const retention = cat?.retention ?? [];
    const activity = cat?.activity ?? [];
    const rate = num(spec.legacyRetention, 95) / 100;
    return months.map((mo, i) => {
      let v = num(spec.legacyStart) * Math.pow(rate, i + 1);
      for (let k = 0; k <= i; k++) {
        const c = counts[i - k];
        if (!c) continue;
        const contribution = c.subNew * (num(retention[k]) / 100) * (num(activity[k]) / 100);
        v += k === 0 ? contribution - c.firstBase : contribution;
      }
      return Math.max(0, v);
    });
  }
  return months.map((mo, i) => {
    const c = counts[i];
    switch (spec.source) {
      case 'first': return c.first;
      case 'first_base': return c.firstBase;
      case 'upsell': return c.upsellUnits;
      case 'repeat': return c.repeat;
      case 'repeat_upsell': return c.repeat + c.upsellUnits;
      case 'all': return c.all;
      case 'legacy': return num(spec.legacyStart) * Math.pow(num(spec.legacyRetention, 95) / 100, i);
      case 'manual': return num(spec.manualCounts?.[mo.key]);
      default: return 0;
    }
  });
}

/** 規格の 1件あたり袋数。固定 or アップセル率から算出 */
function specBags(spec, months) {
  return months.map((mo) => {
    if (spec.bagsMode === 'upsell') {
      const rate = num(spec.upsellRates?.[mo.key], num(spec.upsellRateDefault));
      return num(spec.baseBags, 1) + num(spec.extraBags, 1) * (rate / 100);
    }
    return num(spec.bagsPerOrder, 1);
  });
}

/** 月末日 */
const monthEndIso = (y, m) => iso(new Date(y, m, 0));
/** 月末から margin ヶ月先の月末（この日以降に期限が残っていれば使える） */
const marginLimitIso = (y, m, margin) => {
  const d = new Date(y, m - 1 + num(margin), 1);
  return monthEndIso(d.getFullYear(), d.getMonth() + 1);
};

/**
 * ロットを賞味期限の古い順に消費する。
 * 出荷区分（規格）ごとに「使用できる残り期限」を持ち、
 * 期限までの余裕が足りないロットはその区分では使えない。
 * 余裕の少ない区分（サンプル・単品）から先に消費するので、
 * 定期に出せなくなったロットを使い切れる。
 */
function runProduct(product, lots, streams, months, baseIndex = 0, stockOv = () => null, safetyStock = null, adjustOv = () => null) {
  const stack = sortLots(lots).map((l) => ({ ...l, remain: num(l.quantity) }));
  const order = [...streams].sort((x, y) => num(x.margin) - num(y.margin));
  const strictest = streams.length ? Math.max(...streams.map((x) => num(x.margin))) : 0;

  const rows = [];
  let shortageTotal = 0, wasteTotal = 0, firstShortage = null;
  let wasteCostTotal = 0, shipCostTotal = 0, shipQtyTotal = 0;
  let zeroIso = null, safetyIso = null;
  const streamShort = {};
  const safety = safetyStock === null ? num(product.safety_stock) : safetyStock;

  /* 月内は日割りで均等に消費するとみなし、在庫が尽きる日を求める */
  const dayInMonth = (mo, stockStart, monthDemand, threshold) => {
    if (monthDemand <= 0.001) return null;
    const days = new Date(mo.year, mo.month, 0).getDate();
    const perDay = monthDemand / days;
    const d = Math.ceil((stockStart - threshold) / perDay);
    const clamped = Math.min(Math.max(d, 1), days);
    return iso(new Date(mo.year, mo.month - 1, clamped));
  };

  months.forEach((mo, i) => {
    const end = monthEndIso(mo.year, mo.month);

    /* 在庫の基準月より前は試算しない。手入力した実在庫だけを表示する */
    if (i < baseIndex) {
      const actual = stockOv(mo.key);
      rows.push({
        month: mo, before: true, incoming: 0, waste: 0, divert: 0, byStream: {},
        usedLots: [], wasteLots: [], shipQty: 0, shipCost: 0, wasteCost: 0, stockValue: 0, unitCost: 0,
        demand: 0, shortage: 0, adjust: 0,
        remain: actual === null ? null : actual,
        breakdown: [],
      });
      return;
    }

    /* 在庫調整（返品・倉庫移動・棚卸差異など。出荷には含めない） */
    const adjust = adjustOv(mo.key) ?? 0;
    if (adjust > 0.001) {
      const latest = stack.filter((l) => l.expiry).map((l) => l.expiry).sort().pop() ?? '';
      stack.push({ id: `adj-in-${mo.key}`, expiry: latest, quantity: adjust, remain: adjust });
    } else if (adjust < -0.001) {
      let cut = -adjust;
      for (const l of stack) {
        if (cut <= 0.001) break;
        const take = Math.min(cut, l.remain);
        l.remain -= take; cut -= take;
      }
      /* 在庫が足りず引ききれなかった分は、不足として積む */
      if (cut > 0.001) shortageTotal += cut;
    }

    /* 納品 */
    let incoming = 0;
    (product.incoming ?? []).forEach((inc) => {
      if (inc.ym === mo.key && num(inc.quantity) > 0) {
        incoming += num(inc.quantity);
        stack.push({
          id: `inc-${inc.id}`, expiry: inc.expiry || '',
          quantity: num(inc.quantity), remain: num(inc.quantity),
          cost: num(inc.cost), costParts: inc.costParts ?? {},
        });
      }
    });
    stack.sort((x, y) => (!x.expiry ? 1 : !y.expiry ? -1 : x.expiry.localeCompare(y.expiry)));

    /* 期限切れ */
    let waste = 0, wasteCost = 0;
    const wasteLots = [];
    stack.forEach((l) => {
      if (l.remain > 0.001 && l.expiry && l.expiry < end) {
        waste += l.remain;
        wasteCost += l.remain * lotCost(l);
        wasteLots.push({ expiry: l.expiry, qty: Math.round(l.remain), cost: lotCost(l) });
        l.remain = 0;
      }
    });
    wasteTotal += waste;
    wasteCostTotal += wasteCost;

    /* 消費前の在庫（日割り予測の起点） */
    const stockStart = stack.reduce((sum, l) => sum + l.remain, 0);

    /* 定期便に出せなくなった在庫（見切り対象） */
    const strictLimitNow = marginLimitIso(mo.year, mo.month, strictest);
    const nearExpiry = strictest > 0
      ? stack.filter((l) => l.remain > 0.001 && l.expiry && l.expiry >= end && l.expiry < strictLimitNow)
          .reduce((sum, l) => sum + l.remain, 0)
      : 0;

    /* 区分ごとに消費 */
    const usedLots = [];
    const byStream = {};
    order.forEach((st) => {
      /* 見切り区分は「捌ける在庫」に合わせて需要が変わる。上限は設定値 */
      const want = st.clearance
        ? Math.min(st.cap > 0 ? st.cap : Infinity, nearExpiry)
        : Math.max(0, st.demand[i]);
      let need = want;
      const limit = marginLimitIso(mo.year, mo.month, st.margin);
      /* ロットに出荷区分の指定があれば、その区分だけが使える */
      const usable = (l) => {
        const ids = l.specIds ?? [];
        return ids.length === 0 || ids.includes(st.key);
      };
      /* 区分専用のロットを先に、次に共通のロットを使う */
      const pool = [
        ...stack.filter((l) => (l.specIds ?? []).length > 0 && usable(l)),
        ...stack.filter((l) => (l.specIds ?? []).length === 0),
      ];
      for (const l of pool) {
        if (need <= 0.001) break;
        if (l.remain <= 0.001) continue;
        if (l.expiry && l.expiry < limit) continue;
        const take = Math.min(need, l.remain);
        l.remain -= take; need -= take;
        /* どのロットから何袋出したかを残す。原価の算出に使う */
        usedLots.push({ expiry: l.expiry || '', qty: take, cost: lotCost(l) });
      }
      byStream[st.key] = { demand: want, shortage: st.clearance ? 0 : need, clearance: !!st.clearance };
      if (!st.clearance && need > 0.001) {
        streamShort[st.key] = (streamShort[st.key] ?? 0) + need;
        if (!st.firstShort) st.firstShort = mo;
      }
    });

    const monthShort = Object.values(byStream).reduce((sum, v) => sum + v.shortage, 0);
    if (monthShort > 0.001) { shortageTotal += monthShort; if (!firstShortage) firstShortage = mo; }

    let remain = stack.reduce((sum, l) => sum + l.remain, 0);

    /* 月末締めの実在庫が入っていれば、その数に合わせる */
    let closingDiff = 0;
    const actual = stockOv(mo.key);
    if (actual !== null) {
      closingDiff = actual - remain;
      if (closingDiff > 0.001) {
        const latest = stack.filter((l) => l.expiry).map((l) => l.expiry).sort().pop() ?? '';
        stack.push({ id: `close-${mo.key}`, expiry: latest, quantity: closingDiff, remain: closingDiff });
      } else if (closingDiff < -0.001) {
        let cut = -closingDiff;
        for (const l of stack) {
          if (cut <= 0.001) break;
          const take = Math.min(cut, l.remain);
          l.remain -= take; cut -= take;
        }
      }
      remain = actual;
      shortageTotal = 0;
      stack.sort((x, y) => (!x.expiry ? 1 : !y.expiry ? -1 : x.expiry.localeCompare(y.expiry)));
    }

    /* 入荷で在庫が戻ったら、それまでの不足の積み上げは解消したものとして扱う */
    if (monthShort <= 0.001 && remain > 0.001) shortageTotal = 0;

    /* 日割りで在庫が尽きる日・安全在庫を割る日 */
    const monthDemand = Object.values(byStream).reduce((sum, v) => sum + v.demand, 0);
    if (!safetyIso && stockStart > safety && remain <= safety) {
      safetyIso = dayInMonth(mo, stockStart, monthDemand, safety);
    }
    if (!zeroIso && stockStart > 0 && remain <= 0.001) {
      zeroIso = dayInMonth(mo, stockStart, monthDemand, 0);
    }

    const strictLimit = strictLimitNow;
    const divert = strictest > 0
      ? stack.filter((l) => l.remain > 0.001 && l.expiry && l.expiry >= end && l.expiry < strictLimit)
          .reduce((sum, l) => sum + l.remain, 0)
      : 0;

    /* その月の出荷原価 */
    const shipQty = usedLots.reduce((sum, u) => sum + u.qty, 0);
    const shipCost = usedLots.reduce((sum, u) => sum + u.qty * u.cost, 0);
    shipQtyTotal += shipQty;
    shipCostTotal += shipCost;

    /* 月末在庫の評価額 */
    const stockValue = stack.reduce((sum, l) => sum + l.remain * lotCost(l), 0);

    rows.push({
      month: mo, incoming, waste, divert, byStream, adjust, closingDiff,
      usedLots, wasteLots, shipQty, shipCost, wasteCost, stockValue,
      unitCost: shipQty > 0.001 ? shipCost / shipQty : 0,
      demand: Object.values(byStream).reduce((sum, v) => sum + v.demand, 0),
      shortage: monthShort,
      remain: shortageTotal > 0.001 ? -shortageTotal : remain,
      breakdown: stack.filter((l) => l.remain > 0.001)
        .map((l) => `期限:${l.expiry || '期限なし'} / 残:${Math.round(l.remain).toLocaleString()}`),
    });
  });

  return {
    rows, shortageTotal, wasteTotal, firstShortage, streamShort, zeroIso, safetyIso,
    wasteCostTotal, shipCostTotal, shipQtyTotal,
    avgUnitCost: shipQtyTotal > 0.001 ? shipCostTotal / shipQtyTotal : 0,
  };
}

/**
 * 在庫が安全在庫を割る月を探し、必要な発注月と数量を逆算する。
 *   発注月 = 到着月 − リードタイム月数
 *   発注数 = カバー月数分の需要 + 安全在庫 − その時点の在庫
 */
function planOrders(rows, product, opts) {
  const { coverMonths, roundTo, minQty, baseIndex, startIdx, stockOv, safety: safetyOpt } = opts;
  const safety = safetyOpt === undefined || safetyOpt === null ? num(product.safety_stock) : safetyOpt;
  const ltMonths = Math.ceil(num(product.lead_time_days) / 30);

  let stock = null;
  const extra = new Array(rows.length).fill(0);
  const orders = [];

  rows.forEach((r, i) => {
    if (r.before) return;

    /* 月初の在庫に戻してから、その月の増減を追う */
    if (stock === null) stock = (r.remain ?? 0) + r.demand + r.waste - r.incoming;

    stock = stock + r.incoming + (r.adjust ?? 0) + extra[i] - r.demand - r.waste;

    /* 手入力した月末の実在庫があれば、そこで確定させる */
    const actual = stockOv ? stockOv(r.month.key) : null;
    if (actual !== null && actual !== undefined) stock = actual;

    if (stock >= safety) return;

    const demandAhead = rows.slice(i, i + coverMonths).reduce((sum, x) => sum + (x.before ? 0 : x.demand), 0);
    let qty = Math.max(demandAhead + safety - stock, minQty);
    qty = Math.ceil(qty / roundTo) * roundTo;
    if (qty <= 0) return;

    /* 発注月は着荷月からリードタイム分さかのぼる。過去にはさかのぼらない */
    const rawIdx = i - ltMonths;
    const clamped = Math.max(rawIdx, startIdx);
    orders.push({
      arrive: rows[i].month,
      arriveIdx: i,
      demandAhead,
      order: rows[Math.min(clamped, rows.length - 1)].month,
      orderIdx: clamped,
      late: rawIdx < startIdx,
      qty, stockBefore: Math.round(stock),
    });
    extra[i] += qty;
    stock += qty;
  });

  return { orders, incoming: extra, ltMonths };
}

/**
 * 画面共通の計算。カテゴリー件数 → 規格の袋数 → 商品の消費まで一度で出す。
 */
function compute(data, months) {
  const ov = data.overrides ?? {};
  const getOv = (kind, id, key) => {
    const v = ov[`${kind}|${id}|${key}`];
    return v === undefined || v === null || v === '' ? null : Number(v);
  };

  const catCounts = new Map();
  const specTotals = new Map();

  /* 先にすべてのカテゴリーの人数・件数を計算しておく。
     クロスで「カテゴリーの数値に直接連動」する場合、参照先カテゴリーが
     data.categories 配列の後ろにあっても計算できるようにするため。 */
  data.categories.forEach((cat) => {
    const base = categoryCounts(cat, months, (key) => getOv('first', cat.id, key));
    const usesConfirmed = !!cat.useConfirmedModel;
    const counts = base.map((r) => {
      const upsellOv = getOv('upsellUnits', cat.id, r.key);
      const upsellUnits = upsellOv ?? r.upsellUnits;
      const firstBase = upsellOv !== null ? Math.max(0, r.subNew - upsellOv) : r.firstBase;
      if (usesConfirmed) {
        /* 発送済み／キャンセル・保留で入力するカテゴリーは、2回目以降を repeatActual
           （実績）＋計算式のフォールバックで categoryCounts が既に正しく出しているので、
           ここで古い「2回目以降」「昨年度」の上書きを再適用しない（二重上書きになるため）。 */
        return { ...r, upsellUnits, firstBase };
      }
      const repeat = getOv('repeat', cat.id, r.key) ?? r.repeat;
      const legacy = getOv('legacy', cat.id, r.key) ?? r.legacy;
      return { ...r, repeat, legacy, upsellUnits, firstBase, all: r.first + repeat + legacy };
    });
    catCounts.set(cat.id, counts);
  });

  data.categories.forEach((cat) => {
    const counts = catCounts.get(cat.id);

    const mySpecs = data.specs.filter((sp) => sp.category_id === cat.id);
    /* 参照が必要なものは後回し：通常 → クロスセル → 残り */
    const plain = mySpecs.filter((x) => x.source !== 'cross' && x.source !== 'remainder');
    const ordered = [...plain, ...mySpecs.filter((x) => x.source === 'cross'), ...mySpecs.filter((x) => x.source === 'remainder')];

    ordered.forEach((spec) => {
      let bo;
      if (spec.source === 'remainder') {
        /* 全出荷件数から、同じカテゴリーの他の定期系規格を引いた残り */
        const others = plain.filter((x) => specRank(x) === 0 && x.id !== spec.id);
        bo = months.map((mo, i) => {
          const used = others.reduce((sum, o) => sum + (specTotals.get(o.id)?.orders[i] ?? 0), 0);
          return Math.max(0, counts[i].all - used);
        });
      } else {
        bo = specCounts(spec, counts, months, specTotals, catCounts, cat);
      }

      /* 独自カーブは、手入力した月を起点にして以降を引き直す */
      if (spec.source === 'legacy') {
        const rate = num(spec.legacyRetention, 95) / 100;
        let anchor = null;   // { index, value }
        bo = months.map((mo, i) => {
          const ov = getOv('orders', spec.id, mo.key);
          if (ov !== null) { anchor = { index: i, value: ov }; return ov; }
          if (anchor) return anchor.value * Math.pow(rate, i - anchor.index);
          return bo[i];
        });
      }

      const bb = specBags(spec, months);
      const orders = months.map((mo, i) => getOv('orders', spec.id, mo.key) ?? bo[i]);
      const bags = months.map((mo, i) => getOv('bags', spec.id, mo.key) ?? bb[i]);
      const mall = 1 + num(spec.mallRate) / 100;
      const uplift = 1 + num(spec.upliftRate) / 100;   // 予測に対する割増率
      specTotals.set(spec.id, {
        orders, bags, uplift,
        total: orders.map((n, i) => n * bags[i] * mall * uplift),
        /* 手入力する前の自動計算値。差異の比較に使う（割増は含めない） */
        autoOrders: bo,
        autoTotal: bo.map((n, i) => n * bb[i] * mall),
      });
    });
  });

  /* 商品の出荷区分。主たる規格＋追加の区分 */
  const streamsOf = (p) => {
    const list = [];
    const push = (specId, share, monthlyBags) => {
      const spec = data.specs.find((x) => x.id === specId);
      if (!spec) return;
      const tot = specTotals.get(specId)?.total ?? months.map(() => 0);
      const fixed = num(monthlyBags);
      const auto = specTotals.get(specId)?.autoTotal ?? months.map(() => 0);
      const autoDemand = months.map((mo, i) => (fixed > 0 ? fixed : auto[i] * (num(share) / 100)));
      list.push({
        key: specId, label: spec.name, margin: num(spec.marginMonths),
        clearance: spec.source === 'clearance',
        cap: fixed > 0 ? fixed : num(spec.clearanceCap),
        autoDemand,
        demand: months.map((mo, i) =>
          getOv('demand', `${p.id}:${specId}`, mo.key) ?? (fixed > 0 ? fixed : tot[i] * (num(share) / 100))),
      });
    };
    push(p.spec_id, p.share, p.monthlyBags);
    (p.streams ?? []).forEach((st) => push(st.spec_id, st.share, st.monthlyBags));
    return list;
  };

  const productResults = new Map();
  const lotsByProduct = new Map();
  data.lots.forEach((l) => {
    if (!lotsByProduct.has(l.product_id)) lotsByProduct.set(l.product_id, []);
    lotsByProduct.get(l.product_id).push(l);
  });

  /* 納品管理の発注を、在庫の見込みに反映する。
     ・実際に「在庫へ反映」した納品は、その納品日でロットとして扱う（従来どおり）
     ・まだ納品されていない残数は、納品予定日に「仮」の入荷として見込む
       → これにより発注アラート側の必要数が、すでに発注済みの分だけ自動で減る */
  const baseKeyForReceipt = ymKey(data.stockBaseYM?.year ?? months[0].year, data.stockBaseYM?.month ?? months[0].month);
  const incomingFromPo = new Map();
  const pushIncoming = (productId, entry) => {
    const list = incomingFromPo.get(productId) ?? [];
    list.push(entry);
    incomingFromPo.set(productId, list);
  };
  (data.purchaseOrders ?? []).forEach((po) => {
    if (po.status === 'canceled' || !po.product_id) return;
    (po.receipts ?? []).forEach((r) => {
      if (!r.applied || num(r.quantity) <= 0) return;
      const ym = (r.date || '').slice(0, 7);
      if (ym && ym < baseKeyForReceipt) {
        /* 基準月より前の納品は、すでに在庫に含まれているとみなす */
        return;
      }
      pushIncoming(po.product_id, {
        id: `po-${r.id}`, ym: ym || baseKeyForReceipt,
        quantity: num(r.quantity), expiry: r.expiry || '',
        cost: receiptCost(r), costParts: r.costParts ?? {}, source: 'po',
      });
    });

    const pending = poRemaining(po);
    if (pending > 0.001) {
      /* 納品予定日が未入力でも、発注した時点で「基準月に届く」ものとして見込む。
         予定日があれば、それが基準月より先ならその月、過ぎていれば（延着）基準月を使う */
      const dueYm = po.dueDate ? po.dueDate.slice(0, 7) : '';
      const ym = dueYm && dueYm > baseKeyForReceipt ? dueYm : baseKeyForReceipt;
      pushIncoming(po.product_id, {
        id: `po-pending-${po.id}`, ym,
        quantity: Math.round(pending), expiry: '', cost: 0, costParts: {}, source: 'po-pending',
      });
    }
  });

  const baseKey = ymKey(data.stockBaseYM?.year ?? months[0].year, data.stockBaseYM?.month ?? months[0].month);
  const baseIndex = Math.max(0, months.findIndex((mo) => mo.key === baseKey));

  /* 安全在庫の算出。直近◯ヶ月の平均出荷数を使う設定にも対応する */
  const safetyMode = data.safetyMode ?? 'fixed';
  const safetyMonths = Math.max(1, num(data.safetyMonths, 3));
  const safetyBase = data.safetyBaseYM ?? data.stockBaseYM ?? months[0];
  const safetyEndIdx = (() => {
    const key = ymKey(safetyBase.year, safetyBase.month);
    const i = months.findIndex((mo) => mo.key === key);
    return i >= 0 ? i : Math.max(0, baseIndex - 1);
  })();

  const safetyOf = (p, streams) => {
    if (safetyMode !== 'avg') return num(p.safety_stock);
    const from = Math.max(0, safetyEndIdx - safetyMonths + 1);
    const window = [];
    for (let i = from; i <= safetyEndIdx; i++) {
      window.push(streams.reduce((sum, st) => sum + (st.demand[i] ?? 0), 0));
    }
    if (window.length === 0) return num(p.safety_stock);
    return Math.round(window.reduce((a, b) => a + b, 0) / window.length);
  };

  data.products.forEach((p0) => {
    const fromPo = incomingFromPo.get(p0.id) ?? [];
    const p = fromPo.length ? { ...p0, incoming: [...(p0.incoming ?? []), ...fromPo] } : p0;
    const streams = streamsOf(p);
    if (streams.length === 0) return;
    const stockOv = (key) => getOv('stock', p.id, key);
    const adjustOv = (key) => getOv('adjust', p.id, key);
    const safety = safetyOf(p, streams);
    productResults.set(p.id, {
      product: p, streams, safety,
      ...runProduct(p, lotsByProduct.get(p.id) ?? [], streams, months, baseIndex, stockOv, safety, adjustOv),
    });
  });

  return { getOv, catCounts, specTotals, productResults, lotsByProduct, baseIndex, baseKey, safetyMode, safetyMonths, safetyEndIdx };
}

/* ============================================================
   共通パーツ
   ============================================================ */

const inputClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-100';
const cellInput = 'w-full rounded-md border border-gray-300 bg-white px-1.5 py-1 text-right text-xs outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100';
const primaryBtn = 'rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50';
const secondaryBtn = 'rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50';

function Modal({ open, title, subtitle, onClose, children, footer, size = 'md' }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const width = { md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-5xl' }[size];
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-gray-900/40 p-4">
      <div className={`w-full ${width} my-auto rounded-2xl border border-gray-200 bg-white shadow-xl`}>
        <div className="flex items-start justify-between border-b border-gray-100 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="px-6 py-5">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-gray-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  );
}

/**
 * 数値入力。value は数値（allowEmpty のときは ''／undefined もあり得る）、onChange は数値を受け取る。
 * 表示テキストを自分で管理することで、「0」を消して次の数字を打ったときに
 * 古い「0」の後ろへ継ぎ足されて「01」のようになる問題を防ぐ。入力の先頭に余計な0が
 * 残った場合（例: カーソル位置の都合で"01"になった場合）も、その場で取り除く。
 * allowEmpty=true のときは、空欄を 0 に丸めず '' のまま onChange へ渡す
 * （「未入力」と「0」を区別したい項目向け）。
 */
function NumField({ value, onChange, allowEmpty = false, className, ...rest }) {
  const toText = (v) => (v === '' || v === null || v === undefined ? '' : String(v));
  const [text, setText] = useState(() => toText(value));
  const focusedRef = useRef(false);

  useEffect(() => {
    /* 入力中（フォーカスが当たっている間）は、外から来る値で上書きしない */
    if (focusedRef.current) return;
    setText(toText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const parse = (v) => {
    if (v === '') return allowEmpty ? '' : 0;
    if (v === '-' || v === '.' || v === '-.') return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  return (
    <input
      type="text" inputMode="decimal" autoComplete="off" className={className} value={text}
      onChange={(e) => {
        let v = e.target.value;
        /* 日本語入力で全角の数字・ピリオド・マイナスが混ざることがあるので、半角に直してから判定する */
        if (/[０-９．。－―ー]/.test(v)) {
          v = v.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
               .replace(/[．。]/g, '.').replace(/[－―ー]/g, '-');
        }
        if (v !== '' && v !== '-' && !/^-?\d*\.?\d*$/.test(v)) return;
        if (/^0\d/.test(v)) v = v.replace(/^0+(?=\d)/, '');
        /* 入力中は画面表示だけを更新し、実際の計算（onChange）は呼ばない。
           ここで毎回呼ぶと重くなるうえ、以前はタイマーで待ってから呼ぶ方式にしていたが、
           それ自体が入力中の値を壊す不具合の原因になっていた。 */
        setText(v);
      }}
      onFocus={(e) => { focusedRef.current = true; rest.onFocus?.(e); }}
      onBlur={(e) => {
        focusedRef.current = false;
        const parsed = parse(text);
        setText(toText(parsed));
        onChange(parsed);
        rest.onBlur?.(e);
      }}
      {...rest}
    />
  );
}

/**
 * 横にも縦にもスクロールできる表を、決まった高さの箱の中に収める。
 * こうすることで、表がどれだけ長くても、横スクロールバーは常にこの箱の下端
 * （＝画面のすぐ近く）にあり、ページの一番下まで移動しなくても操作できる。
 */
function ScrollXSynced({ children }) {
  return (
    <div className="overflow-auto scroll-x" style={{ maxHeight: 'calc(100vh - 320px)' }}>
      {children}
    </div>
  );
}

function ExpiryBadge({ expiry }) {
  if (!expiry) return <span className="text-xs text-gray-400">期限なし</span>;
  const left = daysBetween(todayIso(), expiry);
  const tone = left < 0 ? 'bg-red-50 text-red-700 border-red-200'
    : left <= 60 ? 'bg-amber-50 text-amber-700 border-amber-200'
      : left <= 180 ? 'bg-yellow-50 text-yellow-700 border-yellow-200'
        : 'bg-gray-50 text-gray-600 border-gray-200';
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs ${tone}`}>
      <Clock className="h-3 w-3" />{expiry}<span className="opacity-70">{left < 0 ? `${-left}日超過` : `残${left}日`}</span>
    </span>
  );
}

const Cell = ({ v, tone, title }) => (
  <td title={title} className={`whitespace-nowrap px-2 py-1.5 text-right tabular-nums ${
    tone === 'short' ? 'bg-red-50 font-semibold text-red-700'
      : tone === 'low' ? 'bg-amber-50 text-amber-700'
        : tone === 'accent' ? 'bg-teal-50/50 font-semibold text-teal-900'
          : tone === 'manual' ? 'bg-violet-50 font-medium text-violet-900'
            : 'text-gray-700'}`}>{v}</td>
);

const RowHead = ({ children, bold, bg = 'bg-white', formula, note, onEditNote }) => (
  <th style={{ minWidth: 200 }}
    className={`sticky left-0 z-10 ${bg} px-3 py-1.5 text-left ${bold ? 'font-semibold text-gray-800' : 'font-normal text-gray-600'}`}>
    <div className="flex items-start gap-1">
      <span className="flex-1">{children}</span>
      {formula && (
        <span title={formula}
          className="mt-0.5 shrink-0 cursor-help rounded-full bg-gray-200 px-1 text-xs leading-4 text-gray-600">
          式
        </span>
      )}
      {onEditNote && (
        <button onClick={onEditNote} title={note || '実績の取得方法をメモできます'}
          className={`mt-0.5 shrink-0 rounded-full px-1 text-xs leading-4 transition ${
            note ? 'bg-teal-100 text-teal-700 hover:bg-teal-200' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'}`}>
          {note ? '取得' : '＋'}
        </button>
      )}
    </div>
    {formula && <div className="mt-0.5 text-xs font-normal leading-tight text-gray-400">{formula}</div>}
    {note && <div className="mt-0.5 whitespace-pre-wrap text-xs font-normal leading-tight text-teal-700">{note}</div>}
  </th>
);

/* ============================================================
   シミュレーション
   ============================================================ */

/** 実績の取得方法をメモする */
function NoteModal({ open, rowKey, label, value, onClose, onSave }) {
  const [text, setText] = useState('');
  useEffect(() => { if (open) setText(value ?? ''); }, [open, value]);
  if (!rowKey) return null;

  return (
    <Modal open={open} title="実績の取得方法" subtitle={label} onClose={onClose} size="lg"
      footer={<>
        {value && (
          <button className="mr-auto rounded-lg border border-red-300 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
            onClick={() => onSave(rowKey, '')}>メモを消す</button>
        )}
        <button className={secondaryBtn} onClick={onClose}>キャンセル</button>
        <button className={primaryBtn} onClick={() => onSave(rowKey, text)}>保存</button>
      </>}>
      <div className="space-y-3">
        <p className="rounded-xl bg-gray-50 px-4 py-3 text-xs text-gray-600">
          この数字をどこから取ってくるかを書いておけます。担当が変わっても同じ手順で集められます。
          書いた内容はシートの行見出しに表示され、全員に共有されます。
        </p>
        <Field label="取得方法">
          <textarea className={inputClass} rows={5} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={'例）ECforce の受注管理 → 定期受注\n作成日を当月で絞り、定期回数を 1 にした件数'} />
        </Field>
      </div>
    </Modal>
  );
}

function SimulationSheet({ data, onChangeCategory, onChangeOverrides, onEditIncoming, onChangeMeta, onImportMonthlyShipment }) {
  const { categories, specs, products } = data;
  const [catId, setCatId] = useState(categories[0]?.id ?? '');
  const [showRates, setShowRates] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [showFormula, setShowFormula] = useState(false);
  const [showDiff, setShowDiff] = useState(true);
  const [diffMode, setDiffMode] = useState('both');   // 'qty' | 'rate' | 'both'
  const [diffFromMonth, setDiffFromMonth] = useState(''); // 空なら全期間。実績を入れた過去月は差異が大きく出て紛らわしいので、表示を始める月を選べるようにする
  const [diffSettingsOpen, setDiffSettingsOpen] = useState(false);
  const [noteRow, setNoteRow] = useState(null);
  const [showCost, setShowCost] = useState(false);
  const [openSpecs, setOpenSpecs] = useState({});
  const [openExtra, setOpenExtra] = useState({});

  const category = categories.find((c) => c.id === catId) ?? categories[0];
  const months = useMemo(() => buildMonths(data.startYM, data.months ?? HORIZON), [data.startYM, data.months]);
  const calc = useMemo(() => compute(data, months), [data, months]);
  const ov = data.overrides ?? {};

  const setOv = (kind, id, key, raw) => {
    const next = { ...ov };
    if (raw === '' || raw === null) delete next[`${kind}|${id}|${key}`];
    else next[`${kind}|${id}|${key}`] = Number(raw);
    onChangeOverrides(next);
  };

  const counts = calc.catCounts.get(category?.id) ?? [];
  const catSpecs = useMemo(
    () => (category ? specs.filter((x) => x.category_id === category.id).sort(specSort) : []),
    [specs, category]
  );
  const catProductIds = useMemo(
    () => new Set(products.filter((p) => catSpecs.some((x) => x.id === p.spec_id)).map((p) => p.id)),
    [products, catSpecs]
  );
  const results = useMemo(
    () => [...calc.productResults.values()].filter((r) => catProductIds.has(r.product.id)),
    [calc, catProductIds]
  );

  const firstShort = results.filter((r) => r.firstShortage).sort((x, y) => x.firstShortage.index - y.firstShortage.index)[0];
  const firstZero = results.filter((r) => r.zeroIso).sort((x, y) => x.zeroIso.localeCompare(y.zeroIso))[0];
  const wasteTotal = results.reduce((sum, r) => sum + r.wasteTotal, 0);
  const ovCount = Object.keys(ov).length;

  const patch = (fields) => onChangeCategory({ ...category, ...fields });
  const setNew = (key, v) => patch({ newCustomers: { ...category?.newCustomers, [key]: v } });
  const setConfirmedNew = (key, v) => patch({ confirmedNew: { ...category?.confirmedNew, [key]: v } });
  const setPendingCancelNew = (key, v) => patch({ pendingCancelNew: { ...category?.pendingCancelNew, [key]: v } });
  const setRepeatActual = (key, v) => patch({ repeatActual: { ...category?.repeatActual, [key]: v } });
  /* 「定期新規数（発送済み）」「キャンセル・保留」を使い始めたカテゴリーは、そちらの入力欄を出す。
     まだのカテゴリー（イヌメシなど）は、これまで通り「合計新規数（入力）」を直接入力する欄のままにする。 */
  const usesConfirmed = !!category?.useConfirmedModel;
  const setRate = (field, i, v) => {
    const arr = [...(category?.[field] ?? [])];
    arr[i] = v;
    patch({ [field]: arr });
  };

  if (categories.length === 0) {
    return <div className="rounded-2xl border border-gray-200 bg-white p-12 text-center">
      <p className="text-sm text-gray-500">設定タブでカテゴリーを作成してください。</p>
    </div>;
  }

  /* 行ごとの取得方法メモ。カテゴリーごとに持つ */
  const notes = category?.rowNotes ?? {};
  const noteProps = (key) => (showFormula
    ? { note: notes[key] || '', onEditNote: () => setNoteRow(key) }
    : {});
  const saveNote = (key, text) => {
    const next = { ...notes };
    if (text.trim()) next[key] = text.trim();
    else delete next[key];
    patch({ rowNotes: next });
    setNoteRow(null);
  };

  /* 差異のセル。個数と割合を切り替えて出す。実績を入れた過去月は「表示開始月」より前として省略できる */
  const DiffCell = ({ auto, actual, title, monthKey }) => {
    if (diffFromMonth && monthKey && monthKey < diffFromMonth) return <Cell v="" />;
    const diff = actual - auto;
    if (Math.abs(diff) <= 0.5) return <Cell v="—" />;
    const rate = auto > 0.001 ? (actual / auto - 1) * 100 : null;
    const tone = diff > 0 ? 'bg-amber-100 font-semibold text-amber-900' : 'bg-sky-100 font-semibold text-sky-900';
    return (
      <td title={title} className={`whitespace-nowrap px-2 py-1.5 text-right tabular-nums ${tone}`}>
        {diffMode !== 'rate' && <div>{diff > 0 ? '+' : ''}{Math.round(diff).toLocaleString()}</div>}
        {diffMode !== 'qty' && (
          <div className={diffMode === 'both' ? 'text-xs opacity-80' : ''}>
            {rate === null ? '—' : `${rate > 0 ? '+' : ''}${rate.toFixed(1)}%`}
          </div>
        )}
      </td>
    );
  };

  /* 差異の平均。何割増しで発送しているかの目安 */
  const diffSummary = (pairs) => {
    const used = pairs.filter(([a, b]) => a > 0.001 && Math.abs(b - a) > 0.5);
    if (used.length === 0) return null;
    const totalAuto = used.reduce((s2, [a]) => s2 + a, 0);
    const totalAct = used.reduce((s2, [, b]) => s2 + b, 0);
    const avgRate = (totalAct / totalAuto - 1) * 100;
    return { months: used.length, avgRate, factor: totalAct / totalAuto, diff: totalAct - totalAuto };
  };

  /* 商品を1つ上／下へ動かす */
  const moveProduct = (list, index, dir) => {
    const target = index + dir;
    if (target < 0 || target >= list.length) return;
    const ordered = [...list];
    const [moved] = ordered.splice(index, 1);
    ordered.splice(target, 0, moved);
    onChangeMeta?.({
      products: data.products.map((p) => {
        const i = ordered.findIndex((r) => r.product.id === p.id);
        return i >= 0 ? { ...p, order: (i + 1) * 10 } : p;
      }),
    });
  };

  /* 商品の並べ替え。規格ごとの選択率も見る */
  const sortMode = data.productSort ?? 'manual';
  const sortItems = (list, specId) => {
    const shareOf = (r) => {
      if (r.product.specId === specId || r.product.spec_id === specId) return num(r.product.share);
      const st = (r.product.streams ?? []).find((x) => x.spec_id === specId);
      return num(st?.share);
    };
    const stockOf = (r) => (calc.lotsByProduct.get(r.product.id) ?? []).reduce((sum, l) => sum + num(l.quantity), 0);
    const expiryOf = (r) => sortLots(calc.lotsByProduct.get(r.product.id) ?? [])[0]?.expiry || '9999-12-31';

    void stockOf; void expiryOf;
    const copy = [...list];
    switch (sortMode) {
      case 'name': return copy.sort((a, b) => a.product.name.localeCompare(b.product.name, 'ja'));
      case 'share': return copy.sort((a, b) => (shareOf(b) - shareOf(a)) || a.product.name.localeCompare(b.product.name, 'ja'));
      default: return copy.sort((a, b) => (num(a.product.order) - num(b.product.order)) || a.product.name.localeCompare(b.product.name, 'ja'));
    }
  };

  /* セルにカーソルを合わせたときに出す計算の内訳 */
  const cellNote = (kind, i) => {
    if (!showFormula) return undefined;
    const c = counts[i];
    if (!c) return undefined;
    const R = (v) => Math.round(v).toLocaleString();
    const ret = num(category.retention?.[0]);
    const act = num(category.activity?.[0]);

    switch (kind) {
      case 'subNew':
        return `合計新規 ${R(c.newTotal)} × 定期率 ${num(category.subscriptionRate, 100)}% = ${R(c.subNew)}`;
      case 'first':
        return `定期新規 ${R(c.subNew)}人 × 残存率[初月] ${ret}% × 稼働率[初月] ${act}% = ${R(c.first)}件\n内訳: お試し ${R(c.firstBase)} ＋ 本商品 ${R(c.upsellUnits)} ＋ 同月2回目 ${R(c.firstExtra)}${c.subNewAdjusted ? '\n※ 手入力した件数から人数を逆算しています' : ''}`;
      case 'upsellUnits':
        return `定期新規 ${R(c.subNew)}人 × アップセル率 ${c.upsellRate}% = ${R(c.upsellUnits)}`;
      case 'firstBase':
        return `定期新規 ${R(c.subNew)}人 × (1 − アップセル率 ${c.upsellRate}%) = ${R(c.firstBase)}`;
      case 'repeat': {
        const parts = [];
        for (let k = 1; k <= i && k < HORIZON && parts.length < 4; k++) {
          const src = counts[i - k];
          if (!src || src.subNew <= 0) continue;
          parts.push(`${src.full}の${R(src.subNew)}人 × 残存${num(category.retention?.[k])}% × 稼働${num(category.activity?.[k])}%`);
        }
        return `${parts.join('\n＋ ')}${parts.length ? '\n' : ''}＝ ${R(c.repeat)}${i > 4 ? '\n（ほかの月の分も合計）' : ''}`;
      }
      case 'legacy':
        return `開始件数 ${num(category.legacyStart)} × 継続率 ${num(category.legacyRetention, 90)}% の ${i} 乗 = ${R(c.legacy)}`;
      case 'all':
        return usesConfirmed
          ? `定期新規数 ${R(c.subNew)} ＋ 2回目以降 ${R(c.repeat)} = ${R(c.all)}\n（内訳参考：初月発送 ${R(c.first)}＝お試し ${R(c.firstBase)}＋本商品 ${R(c.upsellUnits)}＋同月2回目 ${R(c.firstExtra ?? 0)}）`
          : `初月発送 ${R(c.first)} ＋ 2回目以降 ${R(c.repeat)} ＋ 昨年度からの継続 ${R(c.legacy)} = ${R(c.all)}`;
      default:
        return undefined;
    }
  };

  /* 規格ごとの内訳 */
  const specNote = (spec, i, st) => {
    if (!showFormula) return undefined;
    const c = counts[i];
    const R = (v) => Math.round(v).toLocaleString();
    const others = catSpecs.filter((x) => specRank(x) === 0 && x.id !== spec.id && x.source !== 'remainder');
    switch (spec.source) {
      case 'first_base': return `初月発送 ${R(c.first)} − アップセル初回発送数 ${R(c.upsellUnits)} = ${R(st.orders[i])}`;
      case 'first': return `初月発送 ${R(c.first)}`;
      case 'upsell': return `定期新規 ${R(c.subNew)} × アップセル率 ${c.upsellRate}% = ${R(st.orders[i])}`;
      case 'repeat': return `2回目以降の定期 ${R(c.repeat)}`;
      case 'repeat_upsell': return `2回目以降 ${R(c.repeat)} ＋ アップセル初回発送数 ${R(c.upsellUnits)} = ${R(st.orders[i])}`;
      case 'all': return `出荷予測件数 ${R(c.all)}`;
      case 'legacy': return `開始件数 ${num(spec.legacyStart)} × 継続率 ${num(spec.legacyRetention, 95)}% の ${i} 乗 = ${R(st.orders[i])}`;
      case 'cohort_legacy': {
        const rate = num(spec.legacyRetention, 95) / 100;
        const parts = [];
        for (let k = 0; k <= i && parts.length < 4; k++) {
          const src = counts[i - k];
          if (!src) continue;
          const label = k === 0 ? `${src.full}新規 ${R(src.subNew)} × 残存${num(category.retention?.[k])}% × 稼働${num(category.activity?.[k])}% − お試し${R(src.firstBase)}`
            : `${src.full}新規 ${R(src.subNew)} × 残存${num(category.retention?.[k])}% × 稼働${num(category.activity?.[k])}%`;
          parts.push(label);
        }
        const legacyPart = `開始件数${num(spec.legacyStart)} × 継続率${num(spec.legacyRetention, 95)}%の${i + 1}乗`;
        return `${parts.join('\n＋ ')}\n＋ ${legacyPart}${i >= 4 ? '\n（さらに前の月の新規分も合計）' : ''}\n＝ ${R(st.orders[i])}`;
      }
      case 'cross': {
        const src = calc.specTotals.get(spec.crossFrom);
        return `参照先の件数 ${R(src?.orders[i] ?? 0)} × 併売率 ${num(spec.crossRate)}% = ${R(st.orders[i])}`;
      }
      case 'remainder':
        return `出荷予測件数 ${R(c.all)} − ${others.map((o) => `${o.name} ${R(calc.specTotals.get(o.id)?.orders[i] ?? 0)}`).join(' − ')} = ${R(st.orders[i])}`;
      case 'clearance': return '在庫連動。定期に出せなくなった在庫を上限の範囲で消化します';
      default: return `手入力 ${R(st.orders[i])}`;
    }
  };

  const EditCell = ({ kind, id, mo, value, decimals = 0, note }) => {
    const cur = calc.getOv(kind, id, mo.key);
    const overridden = cur !== null;
    if (!manualMode) {
      return <Cell v={decimals ? value.toFixed(decimals) : Math.round(value).toLocaleString()}
        tone={overridden ? 'manual' : undefined}
        title={overridden ? '手入力で上書きされています' : note} />;
    }
    return (
      <td className="px-1 py-1">
        <NumField step={decimals ? '0.01' : '1'}
          className={`w-full rounded-md border px-1.5 py-1 text-right text-xs outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100 ${overridden ? 'border-violet-300 bg-violet-50 text-violet-900' : 'border-gray-200 bg-white text-gray-500'}`}
          placeholder={decimals ? value.toFixed(decimals) : String(Math.round(value))}
          value={cur ?? ''} onChange={(v) => setOv(kind, id, mo.key, v)} allowEmpty />
      </td>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-gray-500">カテゴリー</span>
        <div className="flex flex-wrap gap-1 rounded-xl bg-gray-100 p-1">
          {categories.map((c) => (
            <button key={c.id} onClick={() => setCatId(c.id)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${category?.id === c.id ? 'bg-white text-teal-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
              {c.name}
            </button>
          ))}
        </div>
        <button onClick={() => patch({ useConfirmedModel: !usesConfirmed })}
          title="オンにすると「定期新規数（発送済み）」と「キャンセル・保留」を分けて入力する方式になります。オフだと「合計新規数」に定期率をかける従来方式です。"
          className={`ml-2 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
            usesConfirmed ? 'bg-teal-100 text-teal-800' : 'border border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
          発送済み／キャンセル・保留で入力{usesConfirmed ? '：オン' : '：オフ'}
        </button>
        {onImportMonthlyShipment && (
          <button onClick={onImportMonthlyShipment}
            className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
            <Upload className="h-3.5 w-3.5" />受注明細CSVで月次実績を取込
          </button>
        )}
        {!usesConfirmed && <span className="ml-auto text-xs text-gray-500">定期率 {num(category.subscriptionRate, 100)}% / 規格 {catSpecs.length} 件</span>}
        {usesConfirmed && <span className="ml-auto text-xs text-gray-500">規格 {catSpecs.length} 件</span>}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-gray-500"><TrendingUp className="h-4 w-4 text-teal-600" />初月の出荷予測件数</div>
          <div className="text-xl font-bold text-gray-900">{Math.round(counts[0]?.all ?? 0).toLocaleString()} <span className="text-xs font-normal text-gray-400">件</span></div>
          <p className="mt-0.5 text-xs text-gray-400">
            初月発送 {Math.round(counts[0]?.first ?? 0)} / 定期 {Math.round(counts[0]?.repeat ?? 0)} / 昨年度 {Math.round(counts[0]?.legacy ?? 0)}
          </p>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-gray-500"><AlertTriangle className={`h-4 w-4 ${firstZero ? 'text-amber-500' : 'text-teal-600'}`} />最初に在庫が尽きる日</div>
          <div className="text-xl font-bold text-gray-900">{firstZero ? fmtJp(firstZero.zeroIso) : '—'}</div>
          <p className={`mt-0.5 text-xs ${firstZero ? 'text-amber-600' : 'text-gray-400'}`}>
            {firstZero ? `${firstZero.product.name}（あと ${Math.max(0, daysBetween(todayIso(), firstZero.zeroIso))} 日）` : '期間中の不足なし'}
          </p>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-gray-500"><Ban className={`h-4 w-4 ${wasteTotal > 0 ? 'text-amber-500' : 'text-teal-600'}`} />期限切れ廃棄の見込み</div>
          <div className="text-xl font-bold text-gray-900">{Math.round(wasteTotal).toLocaleString()} <span className="text-xs font-normal text-gray-400">袋</span></div>
          <p className="mt-0.5 text-xs text-gray-400">{results.length} 商品で試算</p>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">{category.name} の年間予定シート</h2>
          <div className="flex flex-wrap items-center gap-2">
            {ovCount > 0 && <span className="rounded-lg bg-violet-50 px-2 py-1 text-xs text-violet-700">手入力 {ovCount} 件</span>}
            {ovCount > 0 && (
              <button onClick={() => onChangeOverrides({})}
                className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50">手入力をすべて消す</button>
            )}
            <label className="flex items-center gap-1 text-xs text-gray-500">
              並び順
              <select value={sortMode} onChange={(e) => onChangeMeta?.({ productSort: e.target.value })}
                className="rounded-lg border border-gray-300 py-1 pl-2 pr-6 text-xs text-gray-700 outline-none focus:border-teal-500">
                {Object.entries(PRODUCT_SORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <div className="relative flex items-center gap-1">
              <button onClick={() => setShowDiff((v) => !v)}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${showDiff ? 'bg-amber-500 text-white' : 'border border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
                予測との差異
              </button>
              {showDiff && (
                <>
                  <button onClick={() => setDiffSettingsOpen((v) => !v)}
                    title="表示設定"
                    className={`rounded-lg border p-1.5 transition ${diffSettingsOpen ? 'border-teal-400 bg-teal-50 text-teal-700' : 'border-gray-300 text-gray-500 hover:bg-gray-50'}`}>
                    <Settings className="h-3.5 w-3.5" />
                  </button>
                  {diffFromMonth && (
                    <span className="rounded-md bg-amber-50 px-1.5 py-1 text-[11px] text-amber-700">
                      {months.find((mo) => mo.key === diffFromMonth)?.full ?? diffFromMonth}〜
                    </span>
                  )}
                  {diffSettingsOpen && (
                    <div className="absolute left-0 top-full z-50 mt-1 w-56 space-y-2 rounded-lg border border-gray-200 bg-white p-3 text-xs shadow-lg">
                      <label className="block">
                        <span className="mb-1 block text-gray-500">表示する内容</span>
                        <select value={diffMode} onChange={(e) => setDiffMode(e.target.value)}
                          className="w-full rounded-lg border border-gray-300 py-1 pl-2 pr-6 text-gray-700 outline-none focus:border-teal-500">
                          <option value="both">個数と割合</option>
                          <option value="qty">個数だけ</option>
                          <option value="rate">割合だけ</option>
                        </select>
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-gray-500">表示を始める月</span>
                        <select value={diffFromMonth} onChange={(e) => setDiffFromMonth(e.target.value)}
                          className="w-full rounded-lg border border-gray-300 py-1 pl-2 pr-6 text-gray-700 outline-none focus:border-teal-500">
                          <option value="">すべての月</option>
                          {months.map((mo) => <option key={mo.key} value={mo.key}>{mo.full}〜</option>)}
                        </select>
                      </label>
                      <p className="text-[11px] text-gray-400">実績を入れた過去の月は差異が大きく出て紛らわしいため、表示を始める月を後ろにずらせます。</p>
                    </div>
                  )}
                </>
              )}
            </div>
            <button onClick={() => setShowCost((v) => !v)}
              title="ロットの原価から、出荷原価・廃棄損失・在庫評価額を出します"
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${showCost ? 'bg-emerald-700 text-white' : 'border border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
              原価
            </button>
            <button onClick={() => setShowFormula((v) => !v)}
              title="計算式と、実績の取得方法のメモを表示します"
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${showFormula ? 'bg-gray-800 text-white' : 'border border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
              計算式・取得方法
              {Object.keys(notes).length > 0 && (
                <span className={`ml-1 rounded-full px-1 ${showFormula ? 'bg-gray-600' : 'bg-gray-200 text-gray-600'}`}>
                  {Object.keys(notes).length}
                </span>
              )}
            </button>
            <button onClick={() => setManualMode((v) => !v)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${manualMode ? 'bg-violet-600 text-white' : 'border border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
              {manualMode ? '手入力モード：オン' : '手入力モード：オフ'}
            </button>
            <button onClick={() => setShowRates((v) => !v)}
              className="flex items-center gap-1 rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50">
              {showRates ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}残存率・稼働率
            </button>
          </div>
        </div>

        {showFormula && (
          <p className="border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs text-gray-700">
            <span className="text-gray-500">グレー</span>が計算式、
            <span className="text-teal-700">緑</span>が実績の取得方法です。
            行見出しの「＋」または「取得」を押すとメモを編集できます。
            セルにカーソルを合わせると、その月の数字を当てはめた内訳が出ます。
          </p>
        )}
        {manualMode && (
          <div className="border-b border-violet-100 bg-violet-50/60 px-4 py-2 text-xs text-violet-800">
            <p>実績の数字を直接入力できます。空欄にすると計算値に戻ります。</p>
            <p className="mt-0.5 text-violet-700">
              「初月発送」を直すと、その月に入った人数を逆算して、翌月以降の「2回目以降の定期件数」にも反映します。
              「独自カーブ」の規格（1kgなど）の出荷件数を直すと、その月を起点に以降を引き直します。
            </p>
          </div>
        )}

        <div className="overflow-auto" style={{ maxHeight: '72vh' }}>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th style={{ minWidth: 200 }}
                  className="sticky left-0 top-0 z-30 border-b border-gray-200 bg-gray-100 px-3 py-2 text-left font-medium text-gray-600">
                  項目
                </th>
                {months.map((mo, i) => (
                  <th key={mo.key} style={{ minWidth: 66 }}
                    className={`sticky top-0 z-20 whitespace-nowrap border-b border-gray-200 px-2 py-2 text-right font-medium ${
                      i < calc.baseIndex ? 'bg-gray-200 text-gray-500'
                        : i === calc.baseIndex ? 'bg-teal-100 text-teal-800' : 'bg-gray-100 text-gray-600'}`}>
                    <div>{mo.full}</div>
                    {i === calc.baseIndex && <div className="text-xs font-normal text-teal-700">基準</div>}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {usesConfirmed ? (
                <>
                  <tr className="border-b border-gray-100">
                    <RowHead bg="bg-white" {...noteProps('confirmedNew')}>定期新規数（発送済み）</RowHead>
                    {months.map((mo) => (
                      <td key={mo.key} className="px-1 py-1">
                        <NumField min={0} className={cellInput}
                          value={num(category.confirmedNew?.[mo.key])} onChange={(v) => setConfirmedNew(mo.key, v)} />
                      </td>
                    ))}
                  </tr>

                  <tr className="border-b border-gray-100">
                    <RowHead bg="bg-white" {...noteProps('pendingCancelNew')}>キャンセル・保留</RowHead>
                    {months.map((mo) => (
                      <td key={mo.key} className="px-1 py-1">
                        <NumField min={0} className={cellInput}
                          value={num(category.pendingCancelNew?.[mo.key])} onChange={(v) => setPendingCancelNew(mo.key, v)} />
                      </td>
                    ))}
                  </tr>

                  <tr className="border-b border-gray-100 bg-teal-50/40">
                    <RowHead bold bg="bg-teal-50/40" formula={showFormula ? '定期新規数（発送済み） ＋ キャンセル・保留' : null} {...noteProps('newCustomers')}>合計新規数</RowHead>
                    {counts.map((c) => <Cell key={c.key} v={Math.round(c.newTotal).toLocaleString()} />)}
                  </tr>
                </>
              ) : (
                <tr className="border-b border-gray-100 bg-teal-50/40">
                  <RowHead bold bg="bg-teal-50/40" {...noteProps('newCustomers')}>合計新規数（入力）</RowHead>
                  {months.map((mo) => (
                    <td key={mo.key} className="px-1 py-1">
                      <NumField min={0} className={cellInput}
                        value={num(category.newCustomers?.[mo.key])} onChange={(v) => setNew(mo.key, v)} />
                    </td>
                  ))}
                </tr>
              )}

              <tr className="border-b border-gray-100">
                <RowHead formula={showFormula ? (usesConfirmed ? '定期新規数（発送済み）' : '合計新規数 × 定期率') : null} {...noteProps('subNew')}>定期新規数</RowHead>
                {counts.map((c, i) => (
                  <Cell key={c.key} tone={c.subNewAdjusted ? 'manual' : undefined}
                    title={c.subNewAdjusted
                      ? `初月発送の手入力から逆算した人数です（${Math.round(c.subNew).toLocaleString()}人）`
                      : cellNote('subNew', i)}
                    v={Math.round(c.subNew).toLocaleString()} />
                ))}
              </tr>

              {showRates && (
                <>
                  <tr className="border-b border-gray-100"><RowHead>残存率 (%)</RowHead>
                    {months.map((mo, i) => (
                      <td key={mo.key} className="px-1 py-1">
                        <NumField min={0} className={cellInput} value={num(category.retention?.[i])}
                          onChange={(v) => setRate('retention', i, v)} />
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b border-gray-100"><RowHead>稼働率 (%)</RowHead>
                    {months.map((mo, i) => (
                      <td key={mo.key} className="px-1 py-1">
                        <NumField min={0} className={cellInput} value={num(category.activity?.[i])}
                          onChange={(v) => setRate('activity', i, v)} />
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b border-gray-100 bg-indigo-50/30"><RowHead bg="bg-indigo-50/30" {...noteProps('upsellRate')}>アップセル率 (%)</RowHead>
                    {months.map((mo) => (
                      <td key={mo.key} className="px-1 py-1">
                        <NumField min={0} max={100} className={cellInput}
                          value={num(category.upsellRates?.[mo.key], num(category.upsellRateDefault))}
                          onChange={(v) => patch({ upsellRates: { ...category.upsellRates, [mo.key]: v } })} />
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b border-gray-200 bg-gray-50/60"><RowHead bg="bg-gray-50/60">経過月</RowHead>
                    {months.map((mo, i) => <Cell key={mo.key} v={i === 0 ? '初月' : `${i}ヶ月`} />)}
                  </tr>
                </>
              )}

              <tr className="border-b border-gray-100">
                <RowHead formula={showFormula ? '定期新規数 × 残存率[初月] × 稼働率[初月]' : null} {...noteProps('first')}>初月発送</RowHead>
                {counts.map((c, i) => <EditCell key={c.key} kind="first" id={category.id} mo={c} value={c.first} note={cellNote('first', i)} />)}</tr>
              <tr className="border-b border-gray-100">
                <RowHead formula={showFormula ? '定期新規数 × アップセル率' : null} {...noteProps('upsellUnits')}>　アップセル初回発送数</RowHead>
                {counts.map((c, i) => <EditCell key={c.key} kind="upsellUnits" id={category.id} mo={c} value={c.upsellUnits} note={cellNote('upsellUnits', i)} />)}</tr>
              <tr className="border-b border-gray-100">
                <RowHead formula={showFormula ? '定期新規数 × (1 − アップセル率)' : null} {...noteProps('firstBase')}>　お試し発送</RowHead>
                {counts.map((c, i) => <Cell key={c.key} title={cellNote('firstBase', i)} v={Math.round(c.firstBase).toLocaleString()} />)}</tr>
              <tr className="border-b border-gray-100">
                <RowHead formula={showFormula ? '初月発送 − 定期新規数（同じ月に2回発送された分）' : null}>　同月2回目の発送</RowHead>
                {counts.map((c, i) => (
                  <Cell key={c.key} v={Math.round(c.firstExtra ?? 0).toLocaleString()}
                    title={showFormula
                      ? `初月発送 ${Math.round(c.first).toLocaleString()} − 定期新規 ${Math.round(c.subNew).toLocaleString()} = ${Math.round(c.firstExtra ?? 0).toLocaleString()}\n実質的には2回目以降の一部です（出荷予測件数は初月発送ではなく定期新規数を使って重複を避けています）`
                      : undefined} />
                ))}</tr>
              {usesConfirmed ? (
                <tr className="border-b border-gray-100">
                  <RowHead formula={showFormula ? `実績があればそれを使用／無ければ ${months[0]?.full}実績×継続率^経過月 ＋ 各月の新規×該当する残存率×稼働率 の積み上げ` : null}
                    {...noteProps('repeat')}>
                    <div className="flex items-center gap-1.5">
                      <span>2回目以降</span>
                      <span className="flex items-center gap-0.5 text-[11px] font-normal text-gray-400">
                        (継続率
                        <NumField min={0} max={100} className="w-10 rounded border border-gray-200 bg-white px-1 py-0 text-center text-[11px]"
                          value={num(category.legacyRetention, 95)} onChange={(v) => patch({ legacyRetention: v })} />
                        %)
                      </span>
                    </div>
                  </RowHead>
                  {months.map((mo, i) => {
                    const c = counts[i];
                    const anchor = num(category.repeatActual?.[months[0]?.key]);
                    const rate = num(category.legacyRetention, 95) / 100;
                    const decayPart = anchor * Math.pow(rate, i);
                    const cohortLines = [];
                    for (let k = 0; k <= i && cohortLines.length < 5; k++) {
                      const src = counts[i - k];
                      if (!src) continue;
                      if (k === 0) {
                        const term = src.subNew * (num(category.retention?.[0]) / 100) * (Math.max(0, num(category.activity?.[0]) - 100) / 100);
                        cohortLines.push(`${src.full}新規 ${Math.round(src.subNew).toLocaleString()} × (稼働${num(category.activity?.[0])}%−100%) = ${Math.round(term).toLocaleString()}`);
                      } else {
                        const term = src.subNew * (num(category.retention?.[k]) / 100) * (num(category.activity?.[k]) / 100);
                        cohortLines.push(`${src.full}新規 ${Math.round(src.subNew).toLocaleString()} × 残存${num(category.retention?.[k])}% × 稼働${num(category.activity?.[k])}% = ${Math.round(term).toLocaleString()}`);
                      }
                    }
                    const breakdown = showFormula
                      ? `${months[0]?.full}実績 ${Math.round(anchor).toLocaleString()} × 継続率${num(category.legacyRetention, 95)}%の${i}乗 = ${Math.round(decayPart).toLocaleString()}\n＋ ${cohortLines.join('\n＋ ')}\n＝ ${Math.round(c?.repeat ?? 0).toLocaleString()}`
                      : undefined;
                    return (
                      <td key={mo.key} className="px-1 py-1">
                        <NumField min={0} allowEmpty
                          className={`${cellInput} ${c?.repeatIsComputed ? 'bg-sky-50/60 text-sky-800' : ''}`}
                          title={c?.repeatIsComputed ? (breakdown ?? `実績未入力のため計算値を表示中：${Math.round(c.repeat).toLocaleString()}`) : undefined}
                          value={(() => {
                            const v = category.repeatActual?.[mo.key];
                            return v !== undefined && v !== null && v !== '' ? num(v) : '';
                          })()}
                          placeholder={c?.repeatIsComputed ? Math.round(c.repeat).toLocaleString() : undefined}
                          onChange={(v) => setRepeatActual(mo.key, v)} />
                      </td>
                    );
                  })}
                </tr>
              ) : (
                <>
                  <tr className="border-b border-gray-100">
                    <RowHead formula={showFormula ? '各月の定期新規数 × 残存率[経過月] × 稼働率[経過月] の合計' : null} {...noteProps('repeat')}>
                      2回目以降の定期件数（{data.startYM.year}年以降）
                    </RowHead>
                    {counts.map((c, i) => <EditCell key={c.key} kind="repeat" id={category.id} mo={c} value={c.repeat} note={cellNote('repeat', i)} />)}</tr>
                  <tr className="border-b border-gray-100">
                    <RowHead formula={showFormula ? '開始件数 × 継続率 ^ 経過月' : null} {...noteProps('legacy')}>昨年度からの継続</RowHead>
                    {counts.map((c, i) => <EditCell key={c.key} kind="legacy" id={category.id} mo={c} value={c.legacy} note={cellNote('legacy', i)} />)}</tr>
                </>
              )}
              <tr className="border-b-2 border-gray-300 bg-gray-100">
                <RowHead bold bg="bg-gray-100" formula={showFormula ? (usesConfirmed ? '定期新規数 ＋ 2回目以降' : '初月発送 ＋ 2回目以降 ＋ 昨年度') : null}>出荷予測件数</RowHead>
                {counts.map((c, i) => <Cell key={c.key} title={cellNote('all', i)} v={Math.round(c.all).toLocaleString()} />)}
              </tr>

              {catSpecs.length === 0 && (
                <tr><td colSpan={months.length + 1} className="px-3 py-8 text-center text-gray-500">
                  このカテゴリーに規格がありません。設定タブで追加してください。
                </td></tr>
              )}

              {catSpecs.map((spec) => {
                const rank = specRank(spec);
                const open = openSpecs[spec.id] ?? rank <= 1;   // 定期とクロスは開き、単品・見切りは畳む
                const st = calc.specTotals.get(spec.id) ?? { orders: [], bags: [], total: [] };
                const demandItems = sortItems(results.filter((r) => r.streams.some((x) => x.key === spec.id)), spec.id);
                const stockItems = sortItems(results.filter((r) => r.product.spec_id === spec.id), spec.id);
                const shareTotal = stockItems.reduce((sum, r) => sum + num(r.product.share), 0);

                return (
                  <Fragment key={spec.id}>
                    <tr className="border-y border-gray-300 bg-gray-800">
                      <th style={{ minWidth: 200 }} className="sticky left-0 z-10 bg-gray-800 px-3 py-2 text-left">
                        <button onClick={() => setOpenSpecs((v) => ({ ...v, [spec.id]: !open }))}
                          className="flex items-center gap-1.5 text-white">
                          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          <span className="font-semibold">{spec.name}</span>
                          <span className={`rounded px-1 text-xs ${rank === 0 ? 'bg-teal-600' : rank === 1 ? 'bg-indigo-500' : 'bg-gray-600'}`}>
                            {RANK_LABEL[rank]}
                          </span>
                        </button>
                      </th>
                      <td colSpan={months.length} className="bg-gray-800 px-3 py-2 text-left text-gray-300">
                        {SPEC_SOURCES[spec.source]?.label.split('（')[0]} / {stockItems.length} 商品 / 選択率合計 {shareTotal.toFixed(1)}%
                        {num(spec.marginMonths) > 0
                          ? ` / 期限${num(spec.marginMonths)}ヶ月前まで使用`
                          : ' / 期限まで使用可'}
                        {num(spec.mallRate) > 0 && ` / モール +${spec.mallRate}%`}
                        {num(spec.upliftRate) !== 0 && ` / 予測に ${num(spec.upliftRate) > 0 ? '+' : ''}${spec.upliftRate}% 割増`}
                      </td>
                    </tr>

                    {open && (
                      <>
                        {(spec.source === 'legacy' || spec.source === 'cohort_legacy') && (
                          <tr className="border-b border-gray-200 bg-sky-50/40">
                            <RowHead bg="bg-sky-50/40">開始残差／継続率</RowHead>
                            <td colSpan={months.length} className="px-3 py-1.5">
                              <div className="flex flex-wrap items-center gap-3 text-xs text-gray-600">
                                <label className="flex items-center gap-1.5">
                                  開始時点の残り件数
                                  <NumField min={0} className="w-20 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-center text-xs"
                                    value={num(spec.legacyStart)} onChange={(v) => onChangeCategory(null, { ...spec, legacyStart: v })} />
                                  件
                                </label>
                                <label className="flex items-center gap-1.5">
                                  継続率
                                  <NumField min={0} max={100} className="w-16 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-center text-xs"
                                    value={num(spec.legacyRetention, 95)} onChange={(v) => onChangeCategory(null, { ...spec, legacyRetention: v })} />
                                  %
                                </label>
                                <span className="text-gray-400">追跡開始（{months[0]?.full}）より前からの、この規格の出荷残り件数</span>
                              </div>
                            </td>
                          </tr>
                        )}
                        <tr className="border-b border-gray-100">
                          <RowHead formula={showFormula ? SPEC_SOURCES[spec.source]?.label : null}>出荷件数</RowHead>
                          {months.map((mo, i) => (
                            <EditCell key={mo.key} kind="orders" id={spec.id} mo={mo} value={st.orders[i] ?? 0}
                              note={specNote(spec, i, st)} />
                          ))}</tr>

                        {spec.bagsMode === 'upsell' && (
                          <tr className="border-b border-gray-100 bg-indigo-50/30">
                            <RowHead bg="bg-indigo-50/30">アップセル率 (%)</RowHead>
                            {months.map((mo) => (
                              <td key={mo.key} className="px-1 py-1">
                                <NumField min={0} className={cellInput}
                                  value={num(spec.upsellRates?.[mo.key], num(spec.upsellRateDefault))}
                                  onChange={(v) => onChangeCategory(null, { ...spec, upsellRates: { ...spec.upsellRates, [mo.key]: v } })} />
                              </td>
                            ))}
                          </tr>
                        )}

                        <tr className="border-b border-gray-100">
                          <RowHead formula={showFormula ? (spec.bagsMode === 'upsell' ? '基本袋数 ＋ 追加袋数 × アップセル率' : '規格に設定した固定値') : null}>1件あたり袋数</RowHead>
                          {months.map((mo, i) => (
                            <EditCell key={mo.key} kind="bags" id={spec.id} mo={mo} value={st.bags[i] ?? 0} decimals={2}
                              note={showFormula
                                ? (spec.bagsMode === 'upsell'
                                  ? `基本 ${num(spec.baseBags)} ＋ 追加 ${num(spec.extraBags)} × ${num(spec.upsellRates?.[mo.key], num(spec.upsellRateDefault))}% = ${(st.bags[i] ?? 0).toFixed(2)}`
                                  : `固定 ${num(spec.bagsPerOrder, 1)} 袋`)
                                : undefined} />
                          ))}</tr>

                        {showDiff && st.autoOrders && months.some((mo, i) => Math.abs((st.orders[i] ?? 0) - (st.autoOrders[i] ?? 0)) > 0.5) && (() => {
                          const sum = diffSummary(months.map((mo, i) => [st.autoOrders[i] ?? 0, st.orders[i] ?? 0]));
                          return (
                            <>
                              <tr className="border-b border-amber-200 bg-amber-50/50">
                                <RowHead bg="bg-amber-50/50"
                                  formula={sum ? `平均 ${sum.avgRate > 0 ? '+' : ''}${sum.avgRate.toFixed(1)}%（${sum.factor.toFixed(2)}倍 / ${sum.months}ヶ月）` : null}>
                                  <button onClick={() => setOpenExtra((v) => ({ ...v, diffOrders: !v.diffOrders }))}
                                    className="flex items-center gap-1.5">
                                    {openExtra.diffOrders ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                    　予測との差異（件数）
                                  </button>
                                </RowHead>
                                {months.map((mo, i) => (
                                  openExtra.diffOrders ? (
                                    <DiffCell key={mo.key} monthKey={mo.key}
                                      auto={st.autoOrders[i] ?? 0} actual={st.orders[i] ?? 0}
                                      title={`自動計算 ${Math.round(st.autoOrders[i] ?? 0).toLocaleString()} → 手入力 ${Math.round(st.orders[i] ?? 0).toLocaleString()}\nモール出荷やイレギュラー出荷の可能性があります`} />
                                  ) : <Cell key={mo.key} v="" />
                                ))}
                              </tr>
                            </>
                          );
                        })()}

                        <tr className="border-b-2 border-gray-200 bg-teal-50/40">
                          <RowHead bold bg="bg-teal-50/40"
                            formula={showFormula ? `出荷件数 × 1件あたり袋数${num(spec.mallRate) > 0 ? ` × モール${(1 + num(spec.mallRate) / 100).toFixed(2)}` : ''}${num(spec.upliftRate) !== 0 ? ` × 割増${(1 + num(spec.upliftRate) / 100).toFixed(2)}` : ''}` : null}>
                            出荷袋数
                          </RowHead>
                          {(st.total ?? []).map((n, i) => (
                            <Cell key={i} tone="accent"
                              title={showFormula
                                ? `${Math.round(st.orders[i] ?? 0).toLocaleString()} 件 × ${(st.bags[i] ?? 0).toFixed(2)} 袋${num(spec.mallRate) > 0 ? ` × モール${(1 + num(spec.mallRate) / 100).toFixed(2)}` : ''}${num(spec.upliftRate) !== 0 ? ` × 割増${(1 + num(spec.upliftRate) / 100).toFixed(2)}` : ''} = ${Math.round(n).toLocaleString()} 袋`
                                : undefined}
                              v={Math.round(n).toLocaleString()} />
                          ))}
                        </tr>

                        <tr><td colSpan={months.length + 1} className="bg-gray-100 px-3 py-1 font-semibold text-gray-600">
                          商品別 出荷袋数（左の％は選択率{sortMode === 'manual' ? ' / ▲▼で並べ替え' : ''}）
                        </td></tr>
                        {demandItems.map((r, di) => {
                          const stream = r.streams.find((x) => x.key === spec.id);
                          const isSub = r.product.spec_id !== spec.id;
                          return (
                            <tr key={`d-${r.product.id}-${spec.id}`} className="border-b border-gray-100">
                              <th style={{ minWidth: 200 }} className="sticky left-0 z-10 bg-white px-3 py-1.5 text-left font-normal text-gray-600">
                                <div className="flex items-center gap-1">
                                  {sortMode === 'manual' && (
                                    <span className="flex shrink-0 flex-col">
                                      <button onClick={() => moveProduct(demandItems, di, -1)} disabled={di === 0}
                                        title="上へ" className="leading-none text-gray-300 hover:text-teal-600 disabled:opacity-30">▲</button>
                                      <button onClick={() => moveProduct(demandItems, di, 1)} disabled={di === demandItems.length - 1}
                                        title="下へ" className="leading-none text-gray-300 hover:text-teal-600 disabled:opacity-30">▼</button>
                                    </span>
                                  )}
                                  <span className="text-gray-400">
                                    {num(r.product.monthlyBags) > 0 && !isSub ? `固定${num(r.product.monthlyBags)}袋` : `${num(r.product.share)}%`}
                                  </span>
                                  <span>{r.product.name}</span>
                                  {isSub && <span className="rounded bg-indigo-50 px-1 text-indigo-600">追加区分</span>}
                                </div>
                              </th>
                              {months.map((mo, i) => (
                                <EditCell key={mo.key} kind="demand" id={`${r.product.id}:${spec.id}`} mo={mo} value={stream?.demand[i] ?? 0}
                                  note={showFormula
                                    ? (stream?.clearance
                                      ? `見切り対象の在庫 ${Math.round(r.rows[i]?.divert ?? 0).toLocaleString()} 袋のうち、上限 ${stream.cap || 'なし'} まで消化`
                                      : num(isSub ? 0 : r.product.monthlyBags) > 0
                                        ? `固定 ${num(r.product.monthlyBags)} 袋/月`
                                        : `規格の出荷袋数 ${Math.round(st.total[i] ?? 0).toLocaleString()} × 選択率 ${num(isSub ? (r.product.streams ?? []).find((x) => x.spec_id === spec.id)?.share : r.product.share)}% = ${Math.round(stream?.demand[i] ?? 0).toLocaleString()}`)
                                    : undefined} />
                              ))}
                            </tr>
                          );
                        })}

                        {showDiff && demandItems.some((r) => {
                          const st2 = r.streams.find((x) => x.key === spec.id);
                          return st2 && months.some((mo, i) => Math.abs((st2.demand[i] ?? 0) - (st2.autoDemand?.[i] ?? 0)) > 0.5);
                        }) && (
                          <>
                            <tr>
                              <td colSpan={months.length + 1} className="bg-amber-50 px-3 py-1 font-semibold text-amber-800">
                                <button onClick={() => setOpenExtra((v) => ({ ...v, diffBags: !v.diffBags }))}
                                  className="flex items-center gap-1.5">
                                  {openExtra.diffBags ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                  予測との差異（袋数）　＋はモール・イレギュラー出荷など、−は出荷減。行の下に平均の割増率が出ます
                                </button>
                              </td>
                            </tr>
                            {openExtra.diffBags && demandItems.map((r) => {
                              const st2 = r.streams.find((x) => x.key === spec.id);
                              if (!st2 || !months.some((mo, i) => Math.abs((st2.demand[i] ?? 0) - (st2.autoDemand?.[i] ?? 0)) > 0.5)) return null;
                              const sum = diffSummary(months.map((mo, i) => [st2.autoDemand?.[i] ?? 0, st2.demand[i] ?? 0]));
                              return (
                                <tr key={`df-${r.product.id}-${spec.id}`} className="border-b border-gray-100">
                                  <RowHead formula={sum ? `平均 ${sum.avgRate > 0 ? '+' : ''}${sum.avgRate.toFixed(1)}%（${sum.factor.toFixed(2)}倍）` : null}>
                                    {r.product.name}
                                  </RowHead>
                                  {months.map((mo, i) => (
                                    <DiffCell key={mo.key} monthKey={mo.key}
                                      auto={st2.autoDemand?.[i] ?? 0} actual={st2.demand[i] ?? 0}
                                      title={`自動計算 ${Math.round(st2.autoDemand?.[i] ?? 0).toLocaleString()} → 手入力 ${Math.round(st2.demand[i] ?? 0).toLocaleString()}`} />
                                  ))}
                                </tr>
                              );
                            })}
                          </>
                        )}

                        <tr><td colSpan={months.length + 1} className="bg-gray-100 px-3 py-1 font-semibold text-gray-600">
                          商品別 在庫数（赤字は不足 / 灰色は基準月より前）
                        </td></tr>
                        {stockItems.map((r) => (
                          <tr key={`s-${r.product.id}`} className="border-b border-gray-100">
                            <RowHead>{r.product.name}</RowHead>
                            {r.rows.map((row, i) => {
                              const cur = calc.getOv('stock', r.product.id, row.month.key);
                              if (manualMode) {
                                return (
                                  <td key={i} className="px-1 py-1">
                                    <NumField
                                      className={`w-full rounded-md border px-1.5 py-1 text-right text-xs outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100 ${cur !== null ? 'border-violet-300 bg-violet-50 text-violet-900' : 'border-gray-200 bg-white text-gray-500'}`}
                                      placeholder={row.remain === null ? '実在庫' : String(Math.round(row.remain))}
                                      value={cur ?? ''} onChange={(v) => setOv('stock', r.product.id, row.month.key, v)} allowEmpty />
                                  </td>
                                );
                              }
                              if (row.before) {
                                return <Cell key={i} tone={cur !== null ? 'manual' : undefined}
                                  title="在庫の基準月より前です。手入力モードで実在庫を入れられます"
                                  v={row.remain === null ? '—' : Math.round(row.remain).toLocaleString()} />;
                              }
                              return (
                                <Cell key={i}
                                  tone={cur !== null ? 'manual' : row.shortage > 0.001 ? 'short' : row.remain <= num(r.safety) ? 'low' : undefined}
                                  title={cur !== null ? '月末締めの実在庫で上書きされています'
                                    : row.shortage > 0.001 ? `${Math.round(row.shortage).toLocaleString()}袋 不足しています`
                                      : row.breakdown.join('\n') || '在庫なし'}
                                  v={Math.round(row.remain).toLocaleString()} />
                              );
                            })}
                          </tr>
                        ))}

                        {showCost && stockItems.some((r) => r.rows.some((x) => (x.shipCost ?? 0) > 0.001)) && (
                          <>
                            <tr><td colSpan={months.length + 1} className="bg-emerald-50 px-3 py-1 font-semibold text-emerald-800">
                              出荷原価（実際に使ったロットの原価を積み上げ）
                            </td></tr>
                            {stockItems.map((r) => (
                              <Fragment key={`cost-${r.product.id}`}>
                                <tr className="border-b border-gray-100">
                                  <RowHead>{r.product.name}</RowHead>
                                  {r.rows.map((row, i) => (
                                    <td key={i}
                                      title={(row.usedLots ?? []).length
                                        ? (row.usedLots.map((u) => `期限${u.expiry || 'なし'} ${Math.round(u.qty).toLocaleString()}袋 × ¥${u.cost.toFixed(1)} = ¥${Math.round(u.qty * u.cost).toLocaleString()}`).join('\n')
                                          + `\n合計 ¥${Math.round(row.shipCost).toLocaleString()} / 平均 ¥${row.unitCost.toFixed(1)}`)
                                        : undefined}
                                      className={`whitespace-nowrap px-2 py-1.5 text-right tabular-nums ${
                                        (row.shipCost ?? 0) > 0.001 ? 'bg-emerald-50 text-emerald-900' : 'text-gray-300'}`}>
                                      {(row.shipCost ?? 0) > 0.001 ? `¥${Math.round(row.shipCost).toLocaleString()}` : '—'}
                                    </td>
                                  ))}
                                </tr>
                                <tr className="border-b border-gray-100">
                                  <RowHead>　平均単価</RowHead>
                                  {r.rows.map((row, i) => (
                                    <Cell key={i} v={(row.unitCost ?? 0) > 0.001 ? `¥${row.unitCost.toFixed(1)}` : '—'} />
                                  ))}
                                </tr>
                              </Fragment>
                            ))}

                            {stockItems.some((r) => r.rows.some((x) => (x.wasteCost ?? 0) > 0.001)) && (
                              <>
                                <tr><td colSpan={months.length + 1} className="bg-red-50 px-3 py-1 font-semibold text-red-800">
                                  廃棄による損失額
                                </td></tr>
                                {stockItems.filter((r) => r.rows.some((x) => (x.wasteCost ?? 0) > 0.001)).map((r) => (
                                  <tr key={`wc-${r.product.id}`} className="border-b border-gray-100">
                                    <RowHead>{r.product.name}</RowHead>
                                    {r.rows.map((row, i) => (
                                      <td key={i}
                                        title={(row.wasteLots ?? []).length
                                          ? row.wasteLots.map((w) => `期限${w.expiry} ${w.qty.toLocaleString()}袋 × ¥${w.cost.toFixed(1)}`).join('\n')
                                          : undefined}
                                        className={`whitespace-nowrap px-2 py-1.5 text-right tabular-nums ${
                                          (row.wasteCost ?? 0) > 0.001 ? 'bg-red-50 font-semibold text-red-700' : 'text-gray-300'}`}>
                                        {(row.wasteCost ?? 0) > 0.001 ? `¥${Math.round(row.wasteCost).toLocaleString()}` : '—'}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </>
                            )}

                            <tr><td colSpan={months.length + 1} className="bg-gray-100 px-3 py-1 font-semibold text-gray-600">月末在庫の評価額</td></tr>
                            {stockItems.map((r) => (
                              <tr key={`sv-${r.product.id}`} className="border-b border-gray-100">
                                <RowHead>{r.product.name}</RowHead>
                                {r.rows.map((row, i) => (
                                  <Cell key={i} v={(row.stockValue ?? 0) > 0.001 ? `¥${Math.round(row.stockValue).toLocaleString()}` : '—'} />
                                ))}
                              </tr>
                            ))}
                          </>
                        )}

                        {(manualMode || stockItems.some((r) => r.rows.some((x) => Math.abs(x.adjust ?? 0) > 0.001 || Math.abs(x.closingDiff ?? 0) > 0.001))) && (
                          <>
                            <tr><td colSpan={months.length + 1} className="bg-sky-50 px-3 py-1 font-semibold text-sky-800">
                              在庫調整（返品・倉庫移動など、出荷に含まれない増減）
                              {manualMode ? '　手入力モードで直接入力できます' : ''}
                            </td></tr>
                            {stockItems.map((r) => {
                              const hasAny = r.rows.some((x) => Math.abs(x.adjust ?? 0) > 0.001);
                              if (!manualMode && !hasAny) return null;
                              return (
                                <tr key={`a-${r.product.id}`} className="border-b border-gray-100">
                                  <RowHead>{r.product.name}</RowHead>
                                  {r.rows.map((row, i) => {
                                    const cur = calc.getOv('adjust', r.product.id, row.month.key);
                                    if (manualMode) {
                                      return (
                                        <td key={i} className="px-1 py-1">
                                          <NumField
                                            className={`w-full rounded-md border px-1.5 py-1 text-right text-xs outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100 ${cur !== null ? 'border-sky-300 bg-sky-50 text-sky-900' : 'border-gray-200 bg-white text-gray-500'}`}
                                            placeholder="±0"
                                            value={cur ?? ''}
                                            onChange={(v) => setOv('adjust', r.product.id, row.month.key, v)} allowEmpty />
                                        </td>
                                      );
                                    }
                                    const v = row.adjust ?? 0;
                                    return (
                                      <td key={i}
                                        className={`whitespace-nowrap px-2 py-1.5 text-right tabular-nums ${
                                          Math.abs(v) > 0.001 ? 'bg-sky-100 font-semibold text-sky-900' : 'text-gray-300'}`}>
                                        {Math.abs(v) > 0.001 ? `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString()}` : '—'}
                                      </td>
                                    );
                                  })}
                                </tr>
                              );
                            })}

                            {stockItems.some((r) => r.rows.some((x) => Math.abs(x.closingDiff ?? 0) > 0.001)) && (
                              <>
                                <tr><td colSpan={months.length + 1} className="bg-gray-100 px-3 py-1 text-gray-600">
                                  月末締めとの差（実在庫を入力した月の自動調整分）
                                </td></tr>
                                {stockItems.filter((r) => r.rows.some((x) => Math.abs(x.closingDiff ?? 0) > 0.001)).map((r) => (
                                  <tr key={`cd-${r.product.id}`} className="border-b border-gray-100">
                                    <RowHead>{r.product.name}</RowHead>
                                    {r.rows.map((row, i) => (
                                      <Cell key={i} tone={Math.abs(row.closingDiff ?? 0) > 0.001 ? 'manual' : undefined}
                                        v={Math.abs(row.closingDiff ?? 0) > 0.001 ? `${row.closingDiff > 0 ? '+' : ''}${Math.round(row.closingDiff).toLocaleString()}` : '—'} />
                                    ))}
                                  </tr>
                                ))}
                              </>
                            )}
                          </>
                        )}

                        {stockItems.some((r) => (r.product.incoming ?? []).length > 0) && (
                          <>
                            <tr>
                              <td colSpan={months.length + 1} className="bg-emerald-50 px-3 py-1 font-semibold text-emerald-800">
                                <button onClick={() => setOpenExtra((v) => ({ ...v, incoming: !v.incoming }))}
                                  className="flex items-center gap-1.5">
                                  {openExtra.incoming ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                  納品予定（数字をクリックすると修正できます）
                                </button>
                              </td>
                            </tr>
                            {openExtra.incoming && stockItems.filter((r) => (r.product.incoming ?? []).length > 0).map((r) => (
                              <tr key={`i-${r.product.id}`} className="border-b border-gray-100">
                                <th style={{ minWidth: 200 }} className="sticky left-0 z-10 bg-white px-3 py-1.5 text-left font-normal">
                                  <button onClick={() => onEditIncoming?.(r.product)}
                                    className="flex items-center gap-1 text-gray-600 underline decoration-dotted underline-offset-2 hover:text-emerald-700">
                                    <Truck className="h-3 w-3" />{r.product.name}
                                  </button>
                                </th>
                                {r.rows.map((row, i) => {
                                  const items = (r.product.incoming ?? []).filter((x) => x.ym === row.month.key);
                                  const srcLabel = (s) => (
                                    s === 'plan' ? '発注計画から'
                                      : s === 'po' ? '発注書の納品実績'
                                        : s === 'po-pending' ? '発注書より仮計上（納品予定日ベース・発注書タブで修正）'
                                          : '手入力'
                                  );
                                  const title = items.length
                                    ? items.map((x) => `${num(x.quantity).toLocaleString()}袋 / 賞味期限 ${x.expiry || '未設定'} / ${srcLabel(x.source)}`).join('\n') + '\n\nクリックで修正'
                                    : 'クリックで入荷を追加';
                                  return (
                                    <td key={i} title={title}
                                      onClick={() => onEditIncoming?.(r.product)}
                                      className={`cursor-pointer whitespace-nowrap px-2 py-1.5 text-right tabular-nums transition ${
                                        row.incoming > 0
                                          ? items.some((x) => x.source === 'po-pending') && items.every((x) => x.source === 'po-pending')
                                            ? 'bg-amber-50 font-semibold text-amber-800 hover:bg-amber-100'
                                            : 'bg-emerald-100 font-semibold text-emerald-900 hover:bg-emerald-200'
                                          : 'text-gray-300 hover:bg-gray-50'}`}>
                                      {row.incoming > 0 ? Math.round(row.incoming).toLocaleString() : '—'}
                                      {items.length > 0 && items.some((x) => x.source === 'po-pending') && <span className="ml-0.5 text-[10px] font-normal">仮</span>}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </>
                        )}

                        {demandItems.some((r) => r.rows.some((x) => x.byStream[spec.id]?.clearance)) && (
                          <>
                            <tr><td colSpan={months.length + 1} className="bg-amber-50 px-3 py-1 font-semibold text-amber-800">見切り消化の実績</td></tr>
                            {demandItems.map((r) => (
                              <tr key={`cl-${r.product.id}`} className="border-b border-gray-100">
                                <RowHead>{r.product.name}</RowHead>
                                {r.rows.map((row, i) => {
                                  const v = row.byStream[spec.id]?.demand ?? 0;
                                  return <Cell key={i} tone={v > 0 ? 'low' : undefined} v={v > 0 ? Math.round(v).toLocaleString() : '—'} />;
                                })}
                              </tr>
                            ))}
                          </>
                        )}

                        {stockItems.some((r) => r.rows.some((x) => x.divert > 0)) && (
                          <>
                            <tr>
                              <td colSpan={months.length + 1} className="bg-amber-50 px-3 py-1 font-semibold text-amber-800">
                                <button onClick={() => setOpenExtra((v) => ({ ...v, divert: !v.divert }))}
                                  className="flex items-center gap-1.5">
                                  {openExtra.divert ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                  定期に出せない在庫（見切り・サンプルへ転用可能）
                                </button>
                              </td>
                            </tr>
                            {openExtra.divert && stockItems.filter((r) => r.rows.some((x) => x.divert > 0)).map((r) => (
                              <tr key={`v-${r.product.id}`} className="border-b border-gray-100">
                                <RowHead>{r.product.name}</RowHead>
                                {r.rows.map((row, i) => (
                                  <Cell key={i} tone={row.divert > 0 ? 'low' : undefined}
                                    v={row.divert > 0 ? Math.round(row.divert).toLocaleString() : '—'} />
                                ))}
                              </tr>
                            ))}
                          </>
                        )}

                        {stockItems.some((r) => r.wasteTotal > 0) && (
                          <>
                            <tr>
                              <td colSpan={months.length + 1} className="bg-gray-100 px-3 py-1 font-semibold text-gray-600">
                                <button onClick={() => setOpenExtra((v) => ({ ...v, waste: !v.waste }))}
                                  className="flex items-center gap-1.5">
                                  {openExtra.waste ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                  期限切れ廃棄
                                </button>
                              </td>
                            </tr>
                            {openExtra.waste && stockItems.filter((r) => r.wasteTotal > 0).map((r) => (
                              <tr key={`w-${r.product.id}`} className="border-b border-gray-100">
                                <RowHead>{r.product.name}</RowHead>
                                {r.rows.map((row, i) => (
                                  <Cell key={i} tone={row.waste > 0 ? 'short' : undefined} v={row.waste > 0 ? Math.round(row.waste).toLocaleString() : '—'} />
                                ))}
                              </tr>
                            ))}
                          </>
                        )}
                      </>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <NoteModal open={!!noteRow} rowKey={noteRow} label={NOTE_ROWS[noteRow] ?? ''}
          value={notes[noteRow]} onClose={() => setNoteRow(null)} onSave={saveNote} />

        <p className="border-t border-gray-100 bg-gray-50/60 px-4 py-2 text-xs text-gray-500">
          在庫数のセルにカーソルを合わせると賞味期限ごとの内訳が出ます。紫のセルは手入力で上書きした値です。
          「基準」と付いた月から在庫の試算を始めます。それより前の月は手入力モードで実績を入れてください。
        </p>
      </div>
    </div>
  );
}

/* ============================================================
   設定
   ============================================================ */

const blankCategory = {
  name: '', newCustomers: {}, confirmedNew: {}, pendingCancelNew: {}, repeatActual: {}, useConfirmedModel: false, subscriptionRate: 100, rowNotes: {},
  retention: rate24(0), activity: rate24(100), legacyStart: 0, legacyRetention: 90,
  upsellRates: {}, upsellRateDefault: 15,
};

const blankSpec = {
  name: '', category_id: null, source: 'repeat', marginMonths: 0, order: 0,
  upliftRate: 0,
  crossFrom: null, crossFromCategory: null, crossFromMetric: '', crossRate: 20, clearanceCap: 0,
  bagsMode: 'fixed', bagsPerOrder: 1, baseBags: 2, extraBags: 1, upsellRateDefault: 15, upsellRates: {},
  mallRate: 0, legacyStart: 0, legacyRetention: 95, manualCounts: {},
};

/** クロス設定で「規格」を経由せず、カテゴリーの数値に直接連動させるための指標一覧 */
const CROSS_METRICS = {
  subNew: '定期新規数（当月の新規×定期率）',
  upsellUnits: 'アップセル初回発送数（新規のみ・アップセル後）',
  firstBase: 'お試し発送数（新規のみ・アップセル前）',
  first: '初月発送・全件（お試し＋本商品）',
  repeat: '2回目以降（継続）',
  legacy: '昨年度カーブ',
  all: '全件（初月＋2回目以降＋昨年度）',
};

const PRESET_RETENTION = [100, 76, 46, 38, 33, 29, 26, 23, 21, 20, 18, 17, 15, 14, 13, 12, 11, 10, 10, 9, 8, 8, 7, 6];
const PRESET_ACTIVITY = [118, 68, 59, 60, 56, 68, 58, 53, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60];

function CategoryFormModal({ open, category, onClose, onSave }) {
  const [form, setForm] = useState(blankCategory);
  const [withSpecs, setWithSpecs] = useState(true);
  useEffect(() => {
    if (!open) return;
    setWithSpecs(!category);
    setForm(category ? { ...blankCategory, ...category }
      : { ...blankCategory, retention: [...PRESET_RETENTION], activity: [...PRESET_ACTIVITY] });
  }, [open, category]);
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  return (
    <Modal open={open} title={category ? 'カテゴリーを編集' : 'カテゴリーを作成'}
      subtitle="ブランド単位で新規数と継続の前提を持ちます" onClose={onClose} size="lg"
      footer={<>
        <button className={secondaryBtn} onClick={onClose}>キャンセル</button>
        <button className={primaryBtn} disabled={!form.name.trim()} onClick={() => onSave(form, withSpecs)}>保存</button>
      </>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="カテゴリー名" hint="例: イヌメシ / ヘルシー / サプリ">
            <input className={inputClass} value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="定期の割合 (%)" hint="新規のうち定期に進む割合。単品買切を除きます">
            <NumField min={0} max={100} className={inputClass} value={form.subscriptionRate}
              onChange={(v) => set('subscriptionRate', v)} />
          </Field>
        </div>

        {!category && (
          <label className="flex items-start gap-2 rounded-xl border border-teal-200 bg-teal-50/50 p-4 text-xs text-gray-700">
            <input type="checkbox" className="mt-0.5 rounded border-gray-300 text-teal-600"
              checked={withSpecs} onChange={(e) => setWithSpecs(e.target.checked)} />
            <span>
              基本の規格も一緒に作る
              <span className="mt-1 block text-gray-600">
                「定期」「初回」「単品・サンプル」「見切り消化」の4つを用意します。
                作成後、設定タブでそれぞれの件数の元・袋数・期限を調整してください。
              </span>
            </span>
          </label>
        )}

        <p className="rounded-xl bg-gray-50 px-4 py-3 text-xs text-gray-600">
          月ごとの新規数とアップセル率は、シミュレーション画面の表から直接入力します。
          残存率・稼働率はヘルシーの実績値を初期値にしてあります。
        </p>

        <div className="grid grid-cols-2 gap-4 rounded-xl border border-gray-200 bg-gray-50/60 p-4">
          <Field label="昨年度からの継続 開始件数">
            <NumField min={0} className={inputClass} value={form.legacyStart}
              onChange={(v) => set('legacyStart', v)} />
          </Field>
          <Field label="その月次継続率 (%)">
            <NumField min={0} max={100} className={inputClass} value={form.legacyRetention}
              onChange={(v) => set('legacyRetention', v)} />
          </Field>
        </div>

        <button onClick={() => setForm((p) => ({ ...p, retention: [...PRESET_RETENTION], activity: [...PRESET_ACTIVITY] }))}
          className={secondaryBtn}>残存率・稼働率にヘルシーの実績値を入れる</button>
      </div>
    </Modal>
  );
}

function SpecFormModal({ open, spec, categories, allSpecs = [], months, onClose, onSave }) {
  const [form, setForm] = useState(blankSpec);
  useEffect(() => { if (open) setForm(spec ? { ...blankSpec, ...spec } : blankSpec); }, [open, spec]);
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  return (
    <Modal open={open} title={spec ? '規格を編集' : '規格を追加'}
      subtitle="1kg / 800g / 100g など、出荷単位ごとの設定です" onClose={onClose} size="lg"
      footer={<>
        <button className={secondaryBtn} onClick={onClose}>キャンセル</button>
        <button className={primaryBtn} disabled={!form.name.trim() || !form.category_id} onClick={() => onSave(form)}>保存</button>
      </>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="規格名" hint="例: 1kg / 800g / 100g">
            <input className={inputClass} value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="所属カテゴリー">
            <select className={inputClass} value={form.category_id ?? ''} onChange={(e) => set('category_id', e.target.value || null)}>
              <option value="">選択してください</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="表示順" hint="小さいほど上に並びます">
            <NumField className={inputClass} value={num(form.order)} onChange={(v) => set('order', v)} />
          </Field>
        </div>

        <Field label="出荷件数の元" hint={SPEC_SOURCES[form.source]?.hint}>
          <select className={inputClass} value={form.source} onChange={(e) => set('source', e.target.value)}>
            {SPEC_SOURCE_GROUPS.map((g) => (
              <optgroup key={g} label={g}>
                {Object.entries(SPEC_SOURCES).filter(([, v]) => v.group === g).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>

        {(form.source === 'legacy' || form.source === 'cohort_legacy') && (
          <div className="grid grid-cols-2 gap-4 rounded-xl border border-gray-200 bg-gray-50/60 p-4">
            <Field label={form.source === 'cohort_legacy' ? '開始時点の残り件数（追跡開始前からの既存客）' : '開始件数'}>
              <NumField min={0} className={inputClass} value={form.legacyStart}
                onChange={(v) => set('legacyStart', v)} />
            </Field>
            <Field label="月次継続率 (%)"><NumField min={0} max={100} className={inputClass} value={form.legacyRetention}
              onChange={(v) => set('legacyRetention', v)} /></Field>
          </div>
        )}

        {form.source === 'cross' && (
          <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-4">
            <h4 className="mb-2 text-xs font-semibold text-violet-800">クロス設定</h4>
            <div className="mb-3 flex gap-2">
              <button type="button" onClick={() => set('crossFromMetric', form.crossFromMetric || 'upsellUnits')}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${form.crossFromMetric ? 'border-violet-400 bg-violet-100 text-violet-800' : 'border-gray-300 bg-white text-gray-600'}`}>
                カテゴリーの数値に直接連動する
              </button>
              <button type="button" onClick={() => set('crossFromMetric', '')}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${!form.crossFromMetric ? 'border-violet-400 bg-violet-100 text-violet-800' : 'border-gray-300 bg-white text-gray-600'}`}>
                規格を指定する
              </button>
            </div>

            {form.crossFromMetric ? (
              <div className="grid grid-cols-2 gap-4">
                <Field label="参照カテゴリー" hint="規格を作らずに、カテゴリー全体の数値（100g/800gなどのサイズに分かれる前の人数）に直接連動します">
                  <select className={inputClass} value={form.crossFromCategory ?? ''} onChange={(e) => set('crossFromCategory', e.target.value || null)}>
                    <option value="">選択してください</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </Field>
                <Field label="参照する数値" hint="定期新規数・お試し発送数・アップセル初回発送数などを直接選べます">
                  <select className={inputClass} value={form.crossFromMetric} onChange={(e) => set('crossFromMetric', e.target.value)}>
                    {Object.entries(CROSS_METRICS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                </Field>
              </div>
            ) : (
              <Field label="参照先（他のカテゴリー・規格）" hint="別のカテゴリーの規格を選ぶと、そのカテゴリーの数字に連動します。（　）内は参照先の計算方法です">
                <select className={inputClass} value={form.crossFrom ?? ''} onChange={(e) => set('crossFrom', e.target.value || null)}>
                  <option value="">選択してください</option>
                  {categories.map((c) => (
                    <optgroup key={c.id} label={c.name}>
                      {allSpecs.filter((x) => x.category_id === c.id && x.id !== form.id).map((x) => (
                        <option key={x.id} value={x.id}>{x.name}（{SPEC_SOURCES[x.source]?.label ?? x.source}）</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Field>
            )}
            <Field label="連動率 (%)" hint="参照先100件のうち何件をこの規格に反映するか">
              <NumField min={0} className={`${inputClass} mt-3`} style={{ maxWidth: 160 }} value={num(form.crossRate)}
                onChange={(v) => set('crossRate', v)} />
            </Field>
          </div>
        )}

        {form.source === 'clearance' && (
          <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
            <Field label="月あたりの消化上限（袋）" hint="0 なら上限なし。捌ける在庫がある月だけ需要が発生します">
              <NumField min={0} className={inputClass} value={num(form.clearanceCap)}
                onChange={(v) => set('clearanceCap', v)} />
            </Field>
            <p className="mt-2 text-xs text-amber-800">
              他の規格の「使用できる残り期限」を切って定期便に出せなくなった在庫が、この区分の対象になります。
              商品ごとに上限を変えたい場合は、在庫一覧の出荷区分で袋数を入れてください。
            </p>
          </div>
        )}

        {form.source === 'manual' && (
          <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
            <p className="mb-2 text-xs font-medium text-gray-700">月ごとの件数</p>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {months.slice(0, 12).map((mo) => (
                <label key={mo.key} className="block">
                  <span className="mb-0.5 block text-xs text-gray-500">{mo.full}</span>
                  <NumField min={0} className={cellInput} value={num(form.manualCounts?.[mo.key])}
                    onChange={(v) => set('manualCounts', { ...form.manualCounts, [mo.key]: v })} />
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
          <h3 className="mb-2 text-sm font-semibold text-gray-900">1件あたりの袋数</h3>
          <div className="mb-3 grid grid-cols-2 gap-2 rounded-xl bg-gray-100 p-1">
            {[['fixed', '固定値'], ['upsell', 'アップセル率から算出']].map(([k, label]) => (
              <button key={k} onClick={() => set('bagsMode', k)}
                className={`rounded-lg px-3 py-2 text-xs font-medium transition ${form.bagsMode === k ? 'bg-white text-teal-600 shadow-sm' : 'text-gray-500'}`}>
                {label}
              </button>
            ))}
          </div>
          {form.bagsMode === 'fixed' ? (
            <Field label="1件あたりの袋数" hint="例: 1kg 3.4袋 / 800g 2.4袋 / 100g 1袋">
              <NumField step="0.1" min={0} className={inputClass} value={form.bagsPerOrder}
                onChange={(v) => set('bagsPerOrder', v)} />
            </Field>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <Field label="基本袋数"><NumField step="0.1" min={0} className={inputClass} value={form.baseBags}
                onChange={(v) => set('baseBags', v)} /></Field>
              <Field label="追加袋数"><NumField step="0.1" min={0} className={inputClass} value={form.extraBags}
                onChange={(v) => set('extraBags', v)} /></Field>
              <Field label="既定のアップセル率 (%)"><NumField min={0} className={inputClass} value={form.upsellRateDefault}
                onChange={(v) => set('upsellRateDefault', v)} /></Field>
              <p className="col-span-3 text-xs text-gray-500">
                袋数 = 基本 {form.baseBags} + 追加 {form.extraBags} × 率。率 {form.upsellRateDefault}% なら{' '}
                {(num(form.baseBags) + num(form.extraBags) * num(form.upsellRateDefault) / 100).toFixed(2)} 袋。
              </p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="使用できる残り期限（ヶ月）"
            hint="賞味期限の何ヶ月前まで出荷に使えるか。定期便は 2、サンプル・単品は 0">
            <NumField min={0} max={12} className={inputClass} value={num(form.marginMonths)}
              onChange={(v) => set('marginMonths', v)} />
          </Field>
          <Field label="モール販売の上乗せ (%)">
            <NumField min={0} className={inputClass} value={form.mallRate} onChange={(v) => set('mallRate', v)} />
          </Field>
        </div>

        <Field label="予測への割増率 (%)"
          hint="実績が予測を上回る分を、あらかじめ見込んでおく係数。シミュレーションの差異行に出る平均値を目安にしてください">
          <NumField step="0.1" className={inputClass} value={num(form.upliftRate)}
            onChange={(v) => set('upliftRate', v)} />
        </Field>
        <p className="rounded-xl bg-gray-50 px-4 py-3 text-xs text-gray-600">
          出荷袋数 ＝ 出荷件数 × 1件あたり袋数
          {num(form.mallRate) > 0 && ` × モール ${(1 + num(form.mallRate) / 100).toFixed(2)}`}
          {num(form.upliftRate) !== 0 && ` × 割増 ${(1 + num(form.upliftRate) / 100).toFixed(2)}`}
        </p>
        <p className="rounded-xl bg-gray-50 px-4 py-3 text-xs text-gray-600">
          残り期限を 2 ヶ月にすると、期限まで 2 ヶ月を切ったロットはこの規格では使いません。
          残り期限 0 の規格（サンプル・単品）があれば、そのロットはそちらで消費されます。
        </p>
      </div>
    </Modal>
  );
}

function SettingsTab({ data, onSaveMeta, onAddCategory, onEditCategory, onDeleteCategory, onAddSpec, onEditSpec, onDeleteSpec }) {
  const { categories, specs, products } = data;
  const specCount = useMemo(() => {
    const m = new Map();
    products.forEach((p) => p.spec_id && m.set(p.spec_id, (m.get(p.spec_id) ?? 0) + 1));
    return m;
  }, [products]);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">シミュレーションの起点</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="開始年">
            <NumField className={inputClass} value={data.startYM.year}
              onChange={(v) => onSaveMeta({ startYM: { ...data.startYM, year: v } })} />
          </Field>
          <Field label="開始月">
            <select className={inputClass} value={data.startYM.month}
              onChange={(e) => onSaveMeta({ startYM: { ...data.startYM, month: Number(e.target.value) } })}>
              {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1}月</option>)}
            </select>
          </Field>
          <Field label="表示する月数">
            <select className={inputClass} value={data.months ?? HORIZON} onChange={(e) => onSaveMeta({ months: Number(e.target.value) })}>
              {[12, 18, 24].map((m) => <option key={m} value={m}>{m}ヶ月</option>)}
            </select>
          </Field>
        </div>

        <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50/60 p-4">
          <h3 className="mb-2 text-sm font-semibold text-gray-900">安全在庫の決め方</h3>
          <div className="mb-3 grid grid-cols-2 gap-2 rounded-xl bg-gray-100 p-1">
            {[['fixed', '商品ごとに固定値'], ['avg', '直近の平均出荷数から自動']].map(([k, label]) => (
              <button key={k} onClick={() => onSaveMeta({ safetyMode: k })}
                className={`rounded-lg px-3 py-2 text-xs font-medium transition ${(data.safetyMode ?? 'fixed') === k ? 'bg-white text-teal-600 shadow-sm' : 'text-gray-500'}`}>
                {label}
              </button>
            ))}
          </div>
          {(data.safetyMode ?? 'fixed') === 'avg' && (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Field label="平均する月数">
                  <select className={inputClass} value={num(data.safetyMonths, 3)}
                    onChange={(e) => onSaveMeta({ safetyMonths: Number(e.target.value) })}>
                    {[1, 2, 3, 6, 12].map((v) => <option key={v} value={v}>{v}ヶ月</option>)}
                  </select>
                </Field>
                <Field label="起点の年">
                  <NumField className={inputClass}
                    value={(data.safetyBaseYM ?? data.stockBaseYM ?? data.startYM).year}
                    onChange={(v) => onSaveMeta({ safetyBaseYM: { ...(data.safetyBaseYM ?? data.stockBaseYM ?? data.startYM), year: v } })} />
                </Field>
                <Field label="起点の月" hint="この月を含めてさかのぼります">
                  <select className={inputClass}
                    value={(data.safetyBaseYM ?? data.stockBaseYM ?? data.startYM).month}
                    onChange={(e) => onSaveMeta({ safetyBaseYM: { ...(data.safetyBaseYM ?? data.stockBaseYM ?? data.startYM), month: Number(e.target.value) } })}>
                    {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1}月</option>)}
                  </select>
                </Field>
              </div>
              <p className="mt-2 text-xs text-gray-600">
                起点が {(data.safetyBaseYM ?? data.stockBaseYM ?? data.startYM).month} 月・{num(data.safetyMonths, 3)} ヶ月なら、
                {(() => {
                  const b = data.safetyBaseYM ?? data.stockBaseYM ?? data.startYM;
                  const n = num(data.safetyMonths, 3);
                  const list = Array.from({ length: n }, (_, i) => {
                    const dt = new Date(b.year, b.month - 1 - (n - 1 - i), 1);
                    return `${dt.getMonth() + 1}月`;
                  });
                  return list.join('〜');
                })()} の平均出荷数を各商品の安全在庫にします。
              </p>
            </>
          )}
        </div>

        <div className="mt-4 rounded-xl border border-teal-200 bg-teal-50/50 p-4">
          <div className="mb-2 flex items-center gap-1.5">
            <CalendarClock className="h-4 w-4 text-teal-600" />
            <h3 className="text-sm font-semibold text-gray-900">在庫の基準月</h3>
          </div>
          <p className="mb-3 text-xs text-gray-600">
            在庫一覧に入っている数量が、どの月の在庫かを指定します。この月から試算を始めます。
            それより前の月は、シミュレーションの手入力モードで実績を入れてください。
          </p>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Field label="基準の年">
              <NumField className={inputClass} value={data.stockBaseYM?.year ?? data.startYM.year}
                onChange={(v) => onSaveMeta({ stockBaseYM: { ...(data.stockBaseYM ?? data.startYM), year: v } })} />
            </Field>
            <Field label="基準の月">
              <select className={inputClass} value={data.stockBaseYM?.month ?? data.startYM.month}
                onChange={(e) => onSaveMeta({ stockBaseYM: { ...(data.stockBaseYM ?? data.startYM), month: Number(e.target.value) } })}>
                {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1}月</option>)}
              </select>
            </Field>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium text-gray-500">カテゴリーと規格</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              商材が増えたらここで追加します（例: サプリ、ケア用品）。カテゴリーごとに新規数と継続の前提を持ちます。
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={onAddSpec} className={secondaryBtn}>規格を追加</button>
            <button onClick={onAddCategory} className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700">
              <Plus className="h-4 w-4" />カテゴリーを追加
            </button>
          </div>
        </div>

        {categories.map((c) => {
          const mySpecs = specs.filter((s) => s.category_id === c.id);
          return (
            <div key={c.id} className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-gray-900">{c.name}</h3>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                    <span className="rounded-md bg-gray-100 px-2 py-0.5 text-gray-600">定期率 {num(c.subscriptionRate, 100)}%</span>
                    <span className="rounded-md bg-gray-100 px-2 py-0.5 text-gray-600">昨年度 {num(c.legacyStart)}件 / {num(c.legacyRetention, 90)}%</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button onClick={() => onEditCategory(c)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-teal-600"><Pencil className="h-4 w-4" /></button>
                  <button onClick={() => onDeleteCategory(c.id)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {mySpecs.length === 0 && <p className="text-xs text-gray-500">規格がありません。</p>}
                {mySpecs.map((s) => (
                  <div key={s.id} className="rounded-xl border border-gray-200 bg-gray-50/60 p-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{s.name}</p>
                        <p className="mt-0.5 text-xs text-gray-500">{SPEC_SOURCES[s.source]?.label}</p>
                        <div className="mt-1.5 flex flex-wrap gap-1 text-xs">
                          <span className="rounded bg-white px-1.5 py-0.5 text-gray-600 ring-1 ring-gray-200">
                            {s.bagsMode === 'upsell' ? `${s.baseBags}+${s.extraBags}×率` : `${num(s.bagsPerOrder, 1)}袋`}
                          </span>
                          <span className="rounded bg-white px-1.5 py-0.5 text-gray-600 ring-1 ring-gray-200">{specCount.get(s.id) ?? 0} 商品</span>
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-0.5">
                        <button onClick={() => onEditSpec(s)} className="rounded p-1 text-gray-400 hover:text-teal-600"><Pencil className="h-3.5 w-3.5" /></button>
                        <button onClick={() => onDeleteSpec(s.id)} className="rounded p-1 text-gray-400 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================
   商品・ロット
   ============================================================ */

const blankProduct = {
  code: '', name: '', spec_id: null, share: 0, monthlyBags: 0, streams: [], safety_stock: 0, lead_time_days: 0, order: 0, incoming: [],
  weightValue: 0, weightUnit: 'g', hidden: false, discontinued: false,
};

/** 商品の重量(1袋あたり)をグラムに揃える */
const weightPerBagG = (p) => (p?.weightUnit === 'kg' ? num(p?.weightValue) * 1000 : num(p?.weightValue));

function ProductFormModal({ open, product, categories, specs, months, onClose, onSave }) {
  const [form, setForm] = useState(blankProduct);
  useEffect(() => { if (open) setForm(product ? { ...blankProduct, ...product } : blankProduct); }, [open, product]);
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));
  const incoming = form.incoming ?? [];
  const catOf = (specId) => {
    const s = specs.find((x) => x.id === specId);
    return categories.find((c) => c.id === s?.category_id)?.name ?? '';
  };
  const productSpec = specs.find((x) => x.id === form.spec_id);
  const category = categories.find((c) => c.id === productSpec?.category_id) ?? null;

  return (
    <Modal open={open} title={product ? '商品を編集' : '商品を追加'} subtitle={product ? product.name : 'カテゴリーの規格に紐づけます'}
      onClose={onClose} size="lg"
      footer={<>
        <button className={secondaryBtn} onClick={onClose}>キャンセル</button>
        <button className={primaryBtn} disabled={!form.name.trim()} onClick={() => onSave(form)}>保存</button>
      </>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="商品コード"><input className={inputClass} value={form.code ?? ''} onChange={(e) => set('code', e.target.value)} /></Field>
          <Field label="カテゴリー / 規格" hint={form.spec_id ? `所属: ${catOf(form.spec_id)}` : '未設定だとシミュレーションに出ません'}>
            <select className={inputClass} value={form.spec_id ?? ''} onChange={(e) => set('spec_id', e.target.value || null)}>
              <option value="">未設定</option>
              {categories.map((c) => (
                <optgroup key={c.id} label={c.name}>
                  {specs.filter((s) => s.category_id === c.id).map((s) => <option key={s.id} value={s.id}>{c.name} / {s.name}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="商品名"><input className={inputClass} value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
          </div>
          <Field label="選択率 (%)" hint="規格の出荷袋数のうち、この商品が選ばれる割合">
            <NumField step="0.01" min={0} className={inputClass} value={form.share} onChange={(v) => set('share', v)} />
          </Field>
          <Field label="月あたり固定袋数" hint="0 以外を入れると、選択率ではなくこの袋数で計算します">
            <NumField min={0} className={inputClass} value={num(form.monthlyBags)}
              onChange={(v) => set('monthlyBags', v)} />
          </Field>
          <Field label="安全在庫数">
            <NumField min={0} className={inputClass} value={form.safety_stock} onChange={(v) => set('safety_stock', v)} />
          </Field>
          <Field label="表示順" hint="並び順を「手動」にしたとき、小さいほど上に出ます">
            <NumField className={inputClass} value={num(form.order)} onChange={(v) => set('order', v)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="1袋あたりの重量" hint="規格ごとに違う重量（100g・800g・1kg など）を入れます。発注時の資材原料の計算に使います">
              <div className="flex gap-2">
                <NumField min={0} step="0.01" className={inputClass} style={{ flex: '1 1 auto', minWidth: 0 }}
                  value={num(form.weightValue)} onChange={(v) => set('weightValue', v)} />
                <select className={inputClass} style={{ flex: '0 0 5.5rem', width: '5.5rem' }}
                  value={form.weightUnit ?? 'g'} onChange={(e) => set('weightUnit', e.target.value)}>
                  <option value="g">g</option>
                  <option value="kg">kg</option>
                </select>
              </div>
            </Field>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">追加の出荷区分（クロス設定）</h3>
              <p className="text-xs text-gray-500">
                同じ在庫を別の規格でも出す場合や、<strong>別のカテゴリーの人数に連動させたい場合（クロス）</strong>に登録します。
                規格は他のカテゴリーからも選べます（例: カテゴリーをイヌメシのままにして、規格だけヘルシーの「新規」を選ぶ、など）。双方向どちらでも設定できます。
              </p>
            </div>
            <button onClick={() => set('streams', [...(form.streams ?? []), { id: uid(), spec_id: null, share: 0, monthlyBags: 0 }])}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50">区分・クロスを追加</button>
          </div>
          {(form.streams ?? []).length === 0 ? <p className="text-xs text-gray-500">追加の区分・クロスはありません。</p> : (
            <div className="space-y-2">
              {(form.streams ?? []).map((st, i) => {
                const stSpec = specs.find((x) => x.id === st.spec_id);
                const stCat = categories.find((x) => x.id === stSpec?.category_id);
                const isCross = stCat && stCat.id !== category?.id;
                return (
                <div key={st.id} className="rounded-lg bg-white p-2">
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="block flex-1" style={{ minWidth: 180 }}>
                      <span className="mb-1 block text-xs text-gray-500">規格</span>
                      <select className={inputClass} value={st.spec_id ?? ''}
                        onChange={(e) => set('streams', form.streams.map((x, xi) => xi === i ? { ...x, spec_id: e.target.value || null } : x))}>
                        <option value="">選択してください</option>
                        {categories.map((c) => (
                          <optgroup key={c.id} label={c.name}>
                            {specs.filter((x) => x.category_id === c.id).map((x) => <option key={x.id} value={x.id}>{x.name}（{SPEC_SOURCES[x.source]?.label ?? x.source}）</option>)}
                          </optgroup>
                        ))}
                      </select>
                    </label>
                    <label className="block w-24">
                      <span className="mb-1 block text-xs text-gray-500">選択率 %</span>
                      <NumField step="0.01" min={0} className={inputClass} value={num(st.share)}
                        onChange={(v) => set('streams', form.streams.map((x, xi) => xi === i ? { ...x, share: v } : x))} />
                    </label>
                    <label className="block w-28">
                      <span className="mb-1 block text-xs text-gray-500">固定袋数/月</span>
                      <NumField min={0} className={inputClass} value={num(st.monthlyBags)}
                        onChange={(v) => set('streams', form.streams.map((x, xi) => xi === i ? { ...x, monthlyBags: v } : x))} />
                    </label>
                    <button onClick={() => set('streams', form.streams.filter((_, xi) => xi !== i))}
                      className="mb-1 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                  </div>
                  {isCross && (
                    <p className="mt-1 text-xs text-teal-700">
                      クロス設定：この商品のカテゴリー（{category?.name}）とは別に、{stCat.name}「{stSpec.name}」の数字に選択率{num(st.share)}%で連動します。
                    </p>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">納品予定</h3>
            <button onClick={() => set('incoming', [...incoming, { id: uid(), ym: months[0]?.key ?? '', quantity: 0, expiry: '' }])}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50">納品を追加</button>
          </div>
          {incoming.length === 0 ? <p className="text-xs text-gray-500">納品予定はありません。</p> : (
            <div className="space-y-2">
              {incoming.map((inc, i) => (
                <div key={inc.id} className="flex flex-wrap items-end gap-2 rounded-lg bg-white p-2">
                  <label className="block w-32">
                    <span className="mb-1 block text-xs text-gray-500">納品月</span>
                    <select className={inputClass} value={inc.ym}
                      onChange={(e) => set('incoming', incoming.map((x, xi) => xi === i ? { ...x, ym: e.target.value } : x))}>
                      {months.map((mo) => <option key={mo.key} value={mo.key}>{mo.full}</option>)}
                    </select>
                  </label>
                  <label className="block w-28">
                    <span className="mb-1 block text-xs text-gray-500">数量</span>
                    <NumField min={0} className={inputClass} value={inc.quantity}
                      onChange={(v) => set('incoming', incoming.map((x, xi) => xi === i ? { ...x, quantity: v } : x))} />
                  </label>
                  <label className="block w-40">
                    <span className="mb-1 block text-xs text-gray-500">賞味期限</span>
                    <input type="date" className={inputClass} value={inc.expiry ?? ''}
                      onChange={(e) => set('incoming', incoming.map((x, xi) => xi === i ? { ...x, expiry: e.target.value } : x))} />
                  </label>
                  <button onClick={() => set('incoming', incoming.filter((_, xi) => xi !== i))}
                    className="mb-1 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function LotEditorModal({ open, product, lots, specs, categories, onClose, onSave }) {
  const [rows, setRows] = useState([]);
  useEffect(() => { if (open && product) setRows(sortLots(lots).map((l) => ({ ...l }))); }, [open, product, lots]);
  if (!product) return null;
  const update = (i, key, val) => setRows((p) => p.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)));
  const total = rows.reduce((s, r) => s + num(r.quantity), 0);

  /* この商品が出荷に使う規格（主たる規格＋追加の区分） */
  const usedSpecIds = [product.spec_id, ...(product.streams ?? []).map((x) => x.spec_id)].filter(Boolean);
  const choices = specs.filter((x) => usedSpecIds.includes(x.id));
  const specLabel = (id) => {
    const sp = specs.find((x) => x.id === id);
    const c = categories.find((x) => x.id === sp?.category_id);
    return sp ? `${c?.name ?? ''} ${sp.name}`.trim() : '不明';
  };
  const toggle = (i, id) => setRows((p) => p.map((r, idx) => {
    if (idx !== i) return r;
    const cur = r.specIds ?? [];
    return { ...r, specIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
  }));

  return (
    <Modal open={open} title="ロットと賞味期限" subtitle={product.name} onClose={onClose} size="lg"
      footer={<>
        <button className={secondaryBtn} onClick={onClose}>キャンセル</button>
        <button className={primaryBtn} onClick={() => onSave(product.id, rows)}>保存</button>
      </>}>
      <div className="space-y-3">
        <div className="overflow-hidden rounded-xl border border-gray-200">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-200 bg-gray-50 text-xs font-medium text-gray-500">
              <th className="px-3 py-2 text-left">賞味期限</th><th className="px-3 py-2 text-left">状態</th>
              <th className="px-3 py-2 text-right">在庫数</th><th className="px-3 py-2"></th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {rows.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-xs text-gray-500">ロットがありません。</td></tr>}
              {rows.map((r, i) => (
                <tr key={r.id ?? i}>
                  <td className="px-3 py-2">
                    <input type="date" className="rounded-md border border-gray-200 px-2 py-1 text-sm outline-none focus:border-teal-500"
                      value={r.expiry ?? ''} onChange={(e) => update(i, 'expiry', e.target.value)} />
                  </td>
                  <td className="px-3 py-2"><ExpiryBadge expiry={r.expiry} /></td>
                  <td className="px-3 py-2">
                    {choices.length === 0 ? <span className="text-xs text-gray-400">区分なし</span> : (
                      <div className="flex flex-wrap gap-1">
                        {choices.map((c, ci) => {
                          const on = (r.specIds ?? []).includes(c.id);
                          return (
                            <button key={c.id} type="button" onClick={() => toggle(i, c.id)}
                              className={`rounded-md border px-1.5 py-0.5 text-xs transition ${on ? 'border-teal-300 bg-teal-50 text-teal-700' : 'border-gray-200 bg-white text-gray-400 hover:border-gray-300'}`}>
                              {on ? '✓ ' : ''}{c.name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {(r.specIds ?? []).length === 0 && choices.length > 0 && (
                      <p className="mt-0.5 text-xs text-gray-400">すべての区分で使用</p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="relative inline-block w-24">
                      <NumField min={0} step="0.1"
                        title="1袋あたりの原価。納品ごとに違って構いません"
                        className="w-full rounded-md border border-gray-200 py-1 pl-2 pr-5 text-right text-sm outline-none focus:border-teal-500"
                        value={lotCost(r) || ''} placeholder="0"
                        onChange={(v) => update(i, 'cost', v)} />
                      <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-gray-400">円</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <NumField min={0} className="w-24 rounded-md border border-gray-200 px-2 py-1 text-right text-sm outline-none focus:border-teal-500"
                      value={r.quantity} onChange={(v) => update(i, 'quantity', v)} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => setRows((p) => {
                        const r = p[i];
                        const half = Math.round(num(r.quantity) / 2);
                        const rest = num(r.quantity) - half;
                        const next = [...p];
                        next[i] = { ...r, quantity: half };
                        next.splice(i + 1, 0, { ...r, id: uid(), quantity: rest });
                        return next;
                      })}
                        title="同じ賞味期限のまま、数量と原価を分けてもう1行に分割します"
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-teal-600">
                        <Layers className="h-4 w-4" />
                      </button>
                      <button onClick={() => setRows((p) => p.filter((_, idx) => idx !== i))} className="rounded-lg p-1.5 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="border-t border-gray-200 bg-gray-50 text-xs">
              <td className="px-3 py-2 font-medium text-gray-600" colSpan={2}>合計</td>
              <td className="px-3 py-2 text-right font-semibold text-gray-900">{total.toLocaleString()}</td><td />
            </tr></tfoot>
          </table>
        </div>
        <button onClick={() => setRows((p) => [...p, { id: uid(), product_id: product.id, expiry: '', quantity: 0, specIds: [] }])}
          className="flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm text-gray-600 hover:border-teal-400 hover:text-teal-600">
          <Plus className="h-4 w-4" />ロットを追加
        </button>
        <div className="space-y-1 text-xs text-gray-500">
          <p>出荷区分を選ぶと、そのロットは選んだ区分でのみ使われます。何も選ばなければ全区分で使えます。</p>
          <p>区分ごとの「使用できる残り期限」も併せて効きます（定期便は期限2ヶ月前まで、など）。</p>
          <p>同じ賞味期限でも、原価が違う分は行を分けて登録できます（行右の<Layers className="mx-0.5 inline h-3 w-3" />ボタンで分割できます）。在庫一覧にもそれぞれ別々に表示されます。</p>
        </div>
      </div>
    </Modal>
  );
}

/* ============================================================
   入荷登録
   ============================================================ */

function IncomingModal({ open, product, months, onClose, onSave }) {
  const [rows, setRows] = useState([]);
  const [openParts, setOpenParts] = useState(null);
  useEffect(() => { if (open && product) { setRows([...(product.incoming ?? [])]); setOpenParts(null); } }, [open, product]);
  if (!product) return null;

  const upd = (i, k, v) => setRows((p) => p.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));
  const updPart = (i, key, v) => setRows((p) => p.map((r, idx) => (
    idx === i ? { ...r, costParts: { ...(r.costParts ?? {}), [key]: v } } : r)));
  const total = rows.reduce((s, r) => s + num(r.quantity), 0);
  const totalCost = rows.reduce((s, r) => s + num(r.quantity) * lotCost(r), 0);

  return (
    <Modal open={open} title="入荷（納品）登録" subtitle={product.name} onClose={onClose} size="lg"
      footer={<>
        <button className={secondaryBtn} onClick={onClose}>キャンセル</button>
        <button className={primaryBtn} onClick={() => onSave(product.id, rows)}>保存</button>
      </>}>
      <div className="space-y-3">
        <div className="rounded-xl bg-gray-50 px-4 py-3 text-xs text-gray-600">
          <p>登録した月に在庫へ加算され、シミュレーションの「納品予定」の行と在庫推移に反映されます。</p>
          <p className="mt-1">
            入荷月・賞味期限・数量はいつでも変更できます。数量を 0 にするか、ゴミ箱で削除すると取り消しになります。
          </p>
          <p className="mt-1 text-gray-500">
            「発注計画」と付いた行は発注アラートから登録されたものです。ここで直した内容は、
            発注アラートで再度「入荷予定に登録」すると上書きされます。
          </p>
        </div>
        <div className="overflow-hidden rounded-xl border border-gray-200">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-200 bg-gray-50 text-xs font-medium text-gray-500">
              <th className="px-3 py-2 text-left">入荷月</th><th className="px-3 py-2 text-left">賞味期限</th>
              <th className="px-3 py-2 text-right">数量</th>
              <th className="px-3 py-2 text-right">原価（1袋）</th>
              <th className="px-3 py-2 text-left">登録元</th><th className="px-3 py-2"></th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {rows.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-xs text-gray-500">入荷予定がありません。</td></tr>}
              {rows.map((r, i) => (
                <Fragment key={r.id ?? i}>
                <tr>
                  <td className="px-3 py-2">
                    <select className="rounded-md border border-gray-200 px-2 py-1 text-sm outline-none focus:border-teal-500"
                      value={r.ym} onChange={(e) => upd(i, 'ym', e.target.value)}>
                      {months.map((mo) => <option key={mo.key} value={mo.key}>{mo.full}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input type="date" className="rounded-md border border-gray-200 px-2 py-1 text-sm outline-none focus:border-teal-500"
                      value={r.expiry ?? ''} onChange={(e) => upd(i, 'expiry', e.target.value)} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <NumField min={0} className="w-28 rounded-md border border-gray-200 px-2 py-1 text-right text-sm outline-none focus:border-teal-500"
                      value={num(r.quantity)} onChange={(v) => upd(i, 'quantity', v)} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <div className="relative w-24">
                        <NumField min={0} step="0.1"
                          className="w-full rounded-md border border-gray-200 py-1 pl-2 pr-5 text-right text-sm outline-none focus:border-teal-500"
                          value={lotCost(r) || ''} placeholder="0"
                          onChange={(v) => upd(i, 'cost', v)}
                          disabled={COST_PARTS.some((x) => num(r.costParts?.[x.key]) > 0)} />
                        <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-gray-400">円</span>
                      </div>
                      <button onClick={() => setOpenParts(openParts === i ? null : i)}
                        title="費目ごとに分けて入力する"
                        className={`rounded p-1 text-xs ${COST_PARTS.some((x) => num(r.costParts?.[x.key]) > 0) ? 'bg-teal-50 text-teal-700' : 'text-gray-400 hover:bg-gray-100'}`}>
                        内訳
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded-md px-1.5 py-0.5 text-xs ${r.source === 'plan' ? 'bg-teal-50 text-teal-700' : 'bg-gray-100 text-gray-600'}`}>
                      {r.source === 'plan' ? '発注計画' : '手入力'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => setRows((p) => p.filter((_, idx) => idx !== i))}
                      className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                  </td>
                </tr>
                {openParts === i && (
                  <tr className="bg-gray-50">
                    <td colSpan={6} className="px-3 py-2">
                      <p className="mb-1.5 text-xs text-gray-600">
                        費目ごとに入れると、その合計が原価になります。すべて空欄なら上の単価を使います。
                      </p>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {COST_PARTS.map((x) => (
                          <label key={x.key} className="block">
                            <span className="mb-0.5 block text-xs text-gray-500">{x.label}</span>
                            <div className="relative">
                              <NumField min={0} step="0.1"
                                className="w-full rounded-md border border-gray-200 py-1 pl-2 pr-5 text-right text-xs outline-none focus:border-teal-500"
                                value={r.costParts?.[x.key] ?? ''} placeholder="—"
                                onChange={(v) => updPart(i, x.key, v)} />
                              <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-gray-400">円</span>
                            </div>
                          </label>
                        ))}
                      </div>
                      <p className="mt-1.5 text-right text-xs font-medium text-gray-700">
                        合計 ¥{lotCost(r).toFixed(1)}
                      </p>
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
            <tfoot><tr className="border-t border-gray-200 bg-gray-50 text-xs">
              <td className="px-3 py-2 font-medium text-gray-600" colSpan={2}>合計</td>
              <td className="px-3 py-2 text-right font-semibold text-gray-900">{total.toLocaleString()}</td>
              <td className="px-3 py-2 text-right text-gray-600">¥{Math.round(totalCost).toLocaleString()}</td>
              <td colSpan={2} />
            </tr></tfoot>
          </table>
        </div>
        <button onClick={() => setRows((p) => [...p, { id: uid(), ym: months[0]?.key ?? '', quantity: 0, expiry: '' }])}
          className="flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm text-gray-600 hover:border-teal-400 hover:text-teal-600">
          <Plus className="h-4 w-4" />入荷を追加
        </button>
      </div>
    </Modal>
  );
}

/* ============================================================
   在庫一覧
   ============================================================ */

async function readCsvText(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('shift_jis').decode(buf); }
}

function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * 受注明細CSV（顧客ID・購入商品（商品名）・対応状況・定期ステータス・定期回数・発送予定日）から、
 * 月ごとの新規数・キャンセル保留・アップセル率・800g/1kgの実績を集計して取り込む。
 * 毎月同じ形式のCSVを入れ替えて使える想定。
 * 行は「コース行」の直後に、その注文の「フレーバー行」が並ぶ構造を前提に、
 * コース行が出るたびに新しい注文として区切っていく。
 */
/** 商品名で絞り込みながら選べる検索付きプルダウン。商品数が多い場合の一覧選択に使う */
function ProductPicker({ products, value, onChange, placeholder = '商品名で検索…' }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selected = products.find((p) => p.id === value);
  const q = query.trim().toLowerCase();
  const filtered = q ? products.filter((p) => p.name.toLowerCase().includes(q)) : products;
  const shown = filtered.slice(0, 50);

  return (
    <div className="relative">
      <input
        type="text"
        value={open ? query : (selected?.name ?? '')}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={selected ? selected.name : placeholder}
        className={`w-full rounded-lg border py-1 pl-2 pr-6 text-xs outline-none focus:border-teal-500 ${
          selected ? 'border-gray-300 text-gray-700' : 'border-amber-300 bg-amber-50 text-amber-700'}`}
      />
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-56 w-full min-w-[220px] overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 text-xs shadow-lg">
          <button type="button" onMouseDown={() => { onChange(''); setQuery(''); setOpen(false); }}
            className="block w-full px-3 py-1.5 text-left text-gray-400 hover:bg-gray-50">
            選択しない
          </button>
          {shown.length === 0 && <div className="px-3 py-1.5 text-gray-400">一致する商品がありません</div>}
          {shown.map((p) => (
            <button key={p.id} type="button" onMouseDown={() => { onChange(p.id); setQuery(''); setOpen(false); }}
              className={`block w-full truncate px-3 py-1.5 text-left hover:bg-teal-50 ${p.id === value ? 'bg-teal-50 font-medium text-teal-800' : 'text-gray-700'}`}>
              {p.name}
            </button>
          ))}
          {filtered.length > shown.length && (
            <div className="px-3 py-1 text-[11px] text-gray-400">他に{filtered.length - shown.length}件あります。絞り込んでください</div>
          )}
        </div>
      )}
    </div>
  );
}

function MonthlyShipmentCsvImportModal({ open, categories, products, specs, onClose, onImport }) {
  const [fileName, setFileName] = useState('');
  const [notes, setNotes] = useState([]);
  const [catId, setCatId] = useState('');
  const [summary, setSummary] = useState(null);
  const [productMap, setProductMap] = useState({}); // key: `${size}|${flavor}` -> productId（手動で対応付け）
  const [sizeSpecMap, setSizeSpecMap] = useState({}); // key: '100g'|'800g'|'1kg' -> specId（手動で対応付け）

  useEffect(() => {
    if (open) {
      setFileName(''); setNotes([]); setSummary(null); setProductMap({}); setSizeSpecMap({});
      setCatId((prev) => prev || categories[0]?.id || '');
    }
  }, [open, categories]);

  /* このカテゴリーの規格一覧。サイズ選択のプルダウンの候補になる */
  const specsInCategory = (specs ?? []).filter((sp) => sp.category_id === catId);

  /* カテゴリーを選んだとき、規格名から一致しそうなものを自動で仮選択しておく（名前が違っていても手動で選び直せる） */
  useEffect(() => {
    if (specsInCategory.length === 0) return;
    setSizeSpecMap((prev) => {
      const next = { ...prev };
      ['100g', '800g', '1kg'].forEach((sz) => {
        if (next[sz] !== undefined) return;
        const guess = specsInCategory.find((sp) => sp.name.includes(sz));
        next[sz] = guess ? guess.id : '';
      });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catId, specs]);

  const statusBucket = (s) => (s === '発送完了' || s === '発送済み' ? 'confirmed' : 'cancel_pending');
  const classifyProduct = (name) => {
    if (!name) return 'unknown';
    if (name.includes('初回') || name.includes('お試し')) return 'trial';
    if (name.includes('800g') || name.includes('1kg')) return 'main';
    return 'unknown';
  };
  /* コース名から袋数を抜き出す。「【4袋】」だけでなく「2袋コース」のような表記にも対応する */
  const bagsInName = (name) => {
    const m = name.match(/(\d+)\s*袋/);
    return m ? Number(m[1]) : null;
  };
  const sizeOfName = (name) => (name.includes('800g') ? '800g' : name.includes('1kg') ? '1kg' : name.includes('100g') ? '100g' : null);
  /* フレーバー明細行（例：[ヘルシー]ミックス味 800g）から、味の名前だけを抜き出す */
  const flavorOfName = (name) => {
    const m = name.match(/\]\s*(.+?)\s*(?:100g|800g|1kg)/);
    return m ? m[1].trim() : null;
  };
  /* デントキュア・肉球クリームなどの同梱アドオン商品。注文明細の並びに混ざると、
     本来のフレーバー行が誤ってこちらに紐づいてしまうため、グルーピングの前に除外する。 */
  const isAddon = (name) => ['デントキュア', '北の極', '代品', '肉球クリーム', 'プレゼント'].some((k) => name.includes(k));
  /* 「わんこのヘルシー食卓」以外の別ブランド・アドオンの注文は対象外とする */
  const isRelated = (name) => (name.includes('わんこ') || name.includes('ヘルシー')) && !isAddon(name);

  const handleFile = async (file) => {
    setFileName(file.name);
    setSummary(null);
    const text = await readCsvText(file);
    const table = parseCsv(text);
    if (table.length < 2) { setNotes(['見出し行とデータ行が必要です。']); return; }

    const header = table[0].map((h) => h.trim());
    const find = (...names) => header.findIndex((h) => names.some((n) => h === n || h.includes(n)));
    const idx = {
      customer: find('顧客ID'), name: find('購入商品（商品名）', '購入商品(商品名)'), status: find('対応状況'), count: find('定期回数'), date: find('発送予定日'),
      qty: find('購入商品（個数）', '購入商品(個数)', '個数'),
    };
    if (idx.customer < 0 || idx.name < 0 || idx.status < 0 || idx.count < 0 || idx.date < 0) {
      setNotes(['「顧客ID」「購入商品（商品名）」「対応状況」「定期回数」「発送予定日」の列が見つかりません。']);
      return;
    }
    const hasQtyCol = idx.qty >= 0;

    /* 注文単位の行（【…】のような全角カッコで始まる）と、そのフレーバー明細行
       （[ヘルシー]のような半角カッコで始まる）が、同じ顧客IDでひとまとまりに並ぶ構造。
       「コース」という文字の有無では「【定期】…」「【単品】…」「お試しセット」なども
       注文行のため取りこぼすので、カッコの種類（全角＝注文行／半角＝フレーバー明細行）で判定する。
       また「メニュー変更」系の注文は、フレーバー明細が注文行より前に来ることがあるため、
       顧客IDが同じ行のかたまり（ブロック）ごとに処理し、前後どちらのフレーバー行も拾う。 */
    const orders = [];
    let blockCustomer = null;
    let block = [];
    const flushBlock = () => {
      let segments = [];
      let pending = [];
      block.forEach((r) => {
        const name = (r[idx.name] || '').trim();
        if (!name || isAddon(name)) return;
        if (!name.startsWith('[')) {
          segments.push({
            name, status: (r[idx.status] || '').trim(),
            count: Number(r[idx.count]) || 0,
            date: (r[idx.date] || '').trim(),
            flavors: pending,
          });
          pending = [];
        } else {
          const qty = hasQtyCol ? (Number(r[idx.qty]) || 1) : 1;
          if (segments.length > 0) segments[segments.length - 1].flavors.push({ name, qty });
          else pending.push({ name, qty });
        }
      });
      orders.push(...segments);
      block = [];
    };
    for (let i = 1; i < table.length; i++) {
      const r = table[i];
      const customer = (r[idx.customer] || '').trim();
      if (customer !== blockCustomer) {
        if (block.length > 0) flushBlock();
        blockCustomer = customer;
      }
      block.push(r);
    }
    if (block.length > 0) flushBlock();

    const byMonth = {};
    let noDate = 0;
    let unrelatedCount = 0;
    for (const o of orders) {
      if (!isRelated(o.name)) { unrelatedCount++; continue; }
      const parts = o.date.split(/[/-]/);
      if (parts.length < 2) { noDate++; continue; }
      const ym = `${parts[0].padStart(4, '0')}-${parts[1].padStart(2, '0')}`;
      if (!byMonth[ym]) {
        byMonth[ym] = {
          confirmed: 0, pending: 0, trial: 0, main: 0, repeat: 0,
          size: { '800g': { orders: 0, bags: 0 }, '1kg': { orders: 0, bags: 0 }, '100g': { orders: 0, bags: 0 }, '不明': { orders: 0, bags: 0 } },
          flavorSize: {},
        };
      }
      const bucket = statusBucket(o.status);
      const isNew = o.count === 1;

      if (isNew) {
        if (bucket === 'confirmed') {
          byMonth[ym].confirmed += 1;
          const ptype = classifyProduct(o.name);
          if (ptype === 'trial') byMonth[ym].trial += 1;
          else if (ptype === 'main') byMonth[ym].main += 1;
        } else {
          byMonth[ym].pending += 1;
        }
      } else if (bucket === 'confirmed') {
        byMonth[ym].repeat += 1;
      }

      if (bucket === 'confirmed') {
        /* サイズは、実際に発送したフレーバー明細（ここが実態）を必ず優先する。
           コース名が「800g定期コース」でも、初回は100gで届くことがあるなど、
           コース名と実際の発送サイズが食い違うことがあるため、コース名は
           フレーバー明細が1件も無い注文だけの代用にする。 */
        let size = null;
        if (o.flavors.length > 0) {
          const counts = {};
          o.flavors.forEach((f) => { const s = sizeOfName(f.name); if (s) counts[s] = (counts[s] || 0) + f.qty; });
          const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
          size = top ? top[0] : null;
        }
        if (!size) size = sizeOfName(o.name);
        /* 袋数は「個数」列があればフレーバー行の個数を合計するのが最も正確（1行が複数袋のことがあるため）。
           フレーバー行が無い注文は、コース名の「n袋」表記で代用する。 */
        const bags = o.flavors.length > 0
          ? o.flavors.reduce((s, f) => s + f.qty, 0)
          : (bagsInName(o.name) ?? 0);
        const bucket2 = size ?? '不明';
        byMonth[ym].size[bucket2].orders += 1;
        byMonth[ym].size[bucket2].bags += bags;

        /* サイズ×味ごとの袋数（各フレーバー行はそのサイズが分かるので、そのまま集計できる） */
        o.flavors.forEach((f) => {
          const fSize = sizeOfName(f.name);
          const flavor = flavorOfName(f.name);
          if (!fSize || !flavor) return;
          if (!byMonth[ym].flavorSize[fSize]) byMonth[ym].flavorSize[fSize] = {};
          byMonth[ym].flavorSize[fSize][flavor] = (byMonth[ym].flavorSize[fSize][flavor] || 0) + f.qty;
        });
      }
    }

    const monthKeys = Object.keys(byMonth).sort();
    if (monthKeys.length === 0) { setNotes(['集計できる行がありませんでした。「発送予定日」の形式をご確認ください。']); return; }
    setNotes([]);
    setSummary({ byMonth, monthKeys, totalOrders: orders.length, noDate, unrelatedCount, hasQtyCol });
  };

  const category = categories.find((c) => c.id === catId);

  /* このカテゴリーに属する商品だけを候補にする（主規格・追加の出荷区分どちらでも判定） */
  const productsInCategory = useMemo(() => {
    const specIds = new Set((specs ?? []).filter((sp) => sp.category_id === catId).map((sp) => sp.id));
    return (products ?? []).filter((p) => specIds.has(p.spec_id) || (p.streams ?? []).some((s) => specIds.has(s.spec_id)));
  }, [products, specs, catId]);

  /* CSVに出てきた「サイズ×味」の組み合わせを、月をまたいで1つにまとめる */
  const uniquePairs = useMemo(() => {
    if (!summary) return [];
    const seen = new Map();
    summary.monthKeys.forEach((ym) => {
      const fs = summary.byMonth[ym].flavorSize;
      ['100g', '800g', '1kg'].forEach((sz) => {
        Object.keys(fs[sz] ?? {}).forEach((flavor) => seen.set(`${sz}|${flavor}`, { size: sz, flavor }));
      });
    });
    return [...seen.values()];
  }, [summary]);

  /* 新しいファイル・カテゴリーを選んだときは、商品名から一致しそうなものを自動で仮選択しておく（あとで手動修正できる） */
  useEffect(() => {
    if (uniquePairs.length === 0) return;
    setProductMap((prev) => {
      const next = { ...prev };
      uniquePairs.forEach(({ size, flavor }) => {
        const key = `${size}|${flavor}`;
        if (next[key] !== undefined) return;
        const guess = productsInCategory.find((p) => p.name.includes(flavor) && p.name.includes(size))
          ?? productsInCategory.find((p) => p.name.includes(flavor));
        next[key] = guess ? guess.id : '';
      });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniquePairs, productsInCategory]);

  return (
    <Modal open={open} title="受注明細CSVから月次実績を取り込む" subtitle="顧客ID・購入商品（商品名）・対応状況・定期ステータス・定期回数・発送予定日の列を含むCSVを読み込みます" onClose={onClose} size="lg"
      footer={<>
        <button className={secondaryBtn} onClick={onClose}>キャンセル</button>
        <button className={primaryBtn} disabled={!summary || !catId}
          onClick={() => { onImport(catId, summary.byMonth, productMap, sizeSpecMap); onClose(); }}>
          この内容で取り込む
        </button>
      </>}>
      <div className="space-y-4">
        <Field label="取込先カテゴリー">
          <select className={inputClass} value={catId} onChange={(e) => setCatId(e.target.value)}>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>

        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 p-8 text-center hover:border-teal-400">
          <Upload className="h-8 w-8 text-gray-400" />
          <span className="text-sm text-gray-600">{fileName || 'CSVファイルを選択'}</span>
          <span className="text-xs text-gray-400">毎月、同じ形式のCSVに入れ替えて取り込めます</span>
          <input type="file" accept=".csv" className="hidden" onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} />
        </label>

        {notes.length > 0 && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {notes.map((n, i) => <p key={i}>{n}</p>)}
          </div>
        )}

        {summary && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">
              全{summary.totalOrders.toLocaleString()}注文。定期回数1回目 → 発送済みなら定期新規数（発送済み）、それ以外はキャンセル・保留。
              定期新規数のうち、初回・お試しの文言 → お試し発送、800g/1kgの文言 → 初回アップセル発送として、アップセル率を自動計算します。
              定期回数2回目以降は合算の件数のみ表示します。
              {summary.unrelatedCount > 0 && (
                <span className="text-amber-700"> 「わんこ」「ヘルシー」を含まない{summary.unrelatedCount}件（別ブランドの注文・代品）は集計対象外にしています。</span>
              )}
              {summary.hasQtyCol
                ? <span className="text-teal-700"> 「購入商品（個数）」列があるため、袋数はこの個数の合計から正確に計算しています。</span>
                : <span className="text-amber-700"> 「購入商品（個数）」列が無いため、袋数はコース名の「n袋」表記から推定しています（1行＝1袋とは限らないため、多少の誤差が出ます）。</span>}
            </p>
            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left">月</th>
                    <th className="px-3 py-2 text-right">定期新規数</th>
                    <th className="px-3 py-2 text-right">キャンセル・保留</th>
                    <th className="px-3 py-2 text-right">アップセル率</th>
                    <th className="px-3 py-2 text-right">2回目以降</th>
                    <th className="px-3 py-2 text-right">100g 件数/袋数</th>
                    <th className="px-3 py-2 text-right">800g 件数/袋数</th>
                    <th className="px-3 py-2 text-right">1kg 件数/袋数</th>
                    <th className="px-3 py-2 text-right">サイズ不明 件数/袋数</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {summary.monthKeys.map((ym) => {
                    const m = summary.byMonth[ym];
                    const denom = m.trial + m.main;
                    const rate = denom > 0 ? (m.main / denom) * 100 : null;
                    return (
                      <tr key={ym}>
                        <td className="px-3 py-2 text-gray-700">{ym}</td>
                        <td className="px-3 py-2 text-right text-teal-700">{m.confirmed.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-amber-700">{m.pending.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-violet-700">{rate === null ? '—' : `${rate.toFixed(1)}%`}</td>
                        <td className="px-3 py-2 text-right text-gray-600">{m.repeat.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-gray-700">{m.size['100g'].orders.toLocaleString()}件 / {m.size['100g'].bags.toLocaleString()}袋</td>
                        <td className="px-3 py-2 text-right text-gray-700">{m.size['800g'].orders.toLocaleString()}件 / {m.size['800g'].bags.toLocaleString()}袋</td>
                        <td className="px-3 py-2 text-right text-gray-700">{m.size['1kg'].orders.toLocaleString()}件 / {m.size['1kg'].bags.toLocaleString()}袋</td>
                        <td className="px-3 py-2 text-right text-gray-400">{m.size['不明'].orders.toLocaleString()}件 / {m.size['不明'].bags.toLocaleString()}袋</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div>
              <h4 className="mb-1.5 text-xs font-semibold text-gray-700">サイズ×味ごとの出荷袋数（月別）</h4>
              {summary.monthKeys.map((ym) => {
                const fs = summary.byMonth[ym].flavorSize;
                const sizes = ['100g', '800g', '1kg'].filter((sz) => fs[sz] && Object.keys(fs[sz]).length > 0);
                if (sizes.length === 0) return null;
                return (
                  <div key={ym} className="mb-3 overflow-hidden rounded-xl border border-gray-200">
                    <div className="bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600">{ym}</div>
                    <div className="grid grid-cols-1 gap-px bg-gray-100 sm:grid-cols-3">
                      {sizes.map((sz) => (
                        <div key={sz} className="bg-white p-2.5">
                          <div className="mb-1 text-xs font-semibold text-gray-700">{sz}</div>
                          <ul className="space-y-0.5">
                            {Object.entries(fs[sz]).sort((a, b) => b[1] - a[1]).map(([flavor, bags]) => (
                              <li key={flavor} className="flex justify-between text-xs text-gray-600">
                                <span>{flavor}</span>
                                <span className="font-medium text-gray-900">{bags.toLocaleString()}袋</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              <p className="text-xs text-gray-500">フレーバー明細が無い注文（コース名だけの注文）は、味が特定できないためこの内訳には含まれません。</p>
            </div>

            <div>
              <h4 className="mb-1.5 text-xs font-semibold text-gray-700">サイズと規格の対応付け（名前が一致しない場合は手動で選んでください）</h4>
              <div className="overflow-hidden rounded-xl border border-gray-200">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500">
                    <tr>
                      <th className="px-3 py-2 text-left">CSVのサイズ</th>
                      <th className="px-3 py-2 text-left">対応する規格</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {['100g', '800g', '1kg'].map((sz) => (
                      <tr key={sz}>
                        <td className="px-3 py-2 text-gray-600">{sz}</td>
                        <td className="px-3 py-2">
                          <select value={sizeSpecMap[sz] ?? ''} onChange={(e) => setSizeSpecMap((m) => ({ ...m, [sz]: e.target.value }))}
                            className={`w-full rounded-lg border py-1 pl-2 pr-6 text-xs outline-none focus:border-teal-500 ${
                              sizeSpecMap[sz] ? 'border-gray-300 text-gray-700' : 'border-amber-300 bg-amber-50 text-amber-700'}`}>
                            <option value="">反映しない</option>
                            {specsInCategory.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                ここで選んだ規格の「出荷件数」「1件あたり袋数」に、そのサイズの実績がそのまま反映されます。名前が「800g 定期」などと違っていても、ここで選べば大丈夫です。
              </p>
            </div>

            {uniquePairs.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-xs font-semibold text-gray-700">商品との対応付け（名前が一致しない場合は手動で選んでください）</h4>
                <div className="rounded-xl border border-gray-200">
                  <table className="w-full text-sm">
                    <thead className="rounded-t-xl bg-gray-50 text-xs text-gray-500">
                      <tr>
                        <th className="px-3 py-2 text-left">サイズ</th>
                        <th className="px-3 py-2 text-left">CSVの味</th>
                        <th className="px-3 py-2 text-left">対応する商品</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {uniquePairs.map(({ size, flavor }) => {
                        const key = `${size}|${flavor}`;
                        return (
                          <tr key={key}>
                            <td className="px-3 py-2 text-gray-600">{size}</td>
                            <td className="px-3 py-2 text-gray-600">{flavor}</td>
                            <td className="px-3 py-2" style={{ minWidth: 220 }}>
                              <ProductPicker products={productsInCategory} value={productMap[key] ?? ''}
                                onChange={(id) => setProductMap((p) => ({ ...p, [key]: id }))}
                                placeholder="選択しない（商品名で検索）" />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  ここで選んだ商品の、月ごとの実績（予測との差異の手入力値）に、上の袋数がそのまま反映されます。「選択してください」のままの行は反映されません。
                </p>
              </div>
            )}

            <p className="text-xs text-gray-500">
              「この内容で取り込む」を押すと、{category?.name ?? ''}の「定期新規数（発送済み）」「キャンセル・保留」「アップセル率」が月ごとに上書きされ、その入力方式に自動で切り替わります。
              サイズ（100g/800g/1kg）ごとの出荷件数・1件あたり袋数は、対応する規格の月ごとの手入力値にそのまま反映されます。
              「商品との対応付け」で選んだ商品には、味ごとの袋数が月ごとの実績としてあわせて反映されます。
              2回目以降の件数は、今のところこの確認画面での表示のみです。
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}


function CsvImportModal({ open, categories, specs, months, currentBase, onClose, onImport }) {
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState(null);
  const [notes, setNotes] = useState([]);
  const [specId, setSpecId] = useState('');
  const [skipZero, setSkipZero] = useState(true);
  const [skipNoExpiry, setSkipNoExpiry] = useState(false);
  const [baseYM, setBaseYM] = useState(currentBase ?? { year: 2026, month: 8 });
  const [lockPast, setLockPast] = useState(true);
  const [zeroMissing, setZeroMissing] = useState(false);
  const [replaceProducts, setReplaceProducts] = useState(false);

  useEffect(() => { if (open && currentBase) setBaseYM(currentBase); }, [open, currentBase]);

  const reset = () => { setFileName(''); setPreview(null); setNotes([]); };

  const handleFile = async (file) => {
    const table = parseCsv(await readCsvText(file));
    if (table.length < 2) { setNotes(['見出し行とデータ行が必要です。']); return; }

    /* 見出しが2段の月次在庫表にも、1段の在庫表にも対応する */
    const header = table[0].map((h) => h.trim());
    const find = (...names) => header.findIndex((h) => names.some((n) => h === n || h.includes(n)));
    const idx = {
      code: find('品番', '商品コード', 'コード'),
      name: find('商品名'),
      expiry: find('消費期限', '賞味期限'),
      lot: find('ロット'),
      end: find('期末在庫'),
      begin: find('期首在庫'),
      qty: find('在庫数'),
      spec1: find('規格1'),
      spec2: find('規格2'),
    };
    if (idx.code < 0 || idx.name < 0) { setNotes(['「品番」と「商品名」の列が見つかりません。']); setPreview(null); return; }

    /* 数量に使う列：期末在庫を最優先 */
    const qtyIdx = idx.end >= 0 ? idx.end : idx.qty >= 0 ? idx.qty : idx.begin;
    if (qtyIdx < 0) { setNotes(['数量の列（期末在庫 / 在庫数）が見つかりません。']); setPreview(null); return; }

    /* 2段見出しの表は3行目からデータ */
    const firstRow = table[1].every((c) => !String(c).trim() || Number.isNaN(Number(c))) && table[1][idx.code] === '' ? 2 : 1;

    const found = [];
    if (idx.end >= 0) found.push('「期末在庫」の列を在庫数として読み込みます。');
    if (idx.lot >= 0) found.push('「ロット」列は商品名の補足として保持します。');

    const byCode = new Map();
    let zero = 0, noExp = 0;

    table.slice(firstRow).forEach((cells) => {
      const code = (cells[idx.code] ?? '').trim();
      const name = (cells[idx.name] ?? '').trim();
      if (!code && !name) return;
      const qty = Number(String(cells[qtyIdx] ?? '').replace(/[,¥\s]/g, '')) || 0;
      const expiry = (cells[idx.expiry] ?? '').trim();
      if (skipZero && qty <= 0) { zero++; return; }
      if (skipNoExpiry && !expiry) { noExp++; return; }

      const spec = [cells[idx.spec1], cells[idx.spec2]].filter((v) => v && String(v).trim()).join(' ');
      const key = code || name;
      if (!byCode.has(key)) byCode.set(key, { code, name: spec ? `${name} ${spec}` : name, lots: [] });
      byCode.get(key).lots.push({ expiry, quantity: qty, lot: (cells[idx.lot] ?? '').trim() });
    });

    if (zero > 0) found.push(`在庫 0 の ${zero} 行を読み飛ばしました。`);
    if (noExp > 0) found.push(`消費期限が空の ${noExp} 行を読み飛ばしました。`);

    const products = [...byCode.values()];
    /* ファイル名に 2026-07 のような月があれば、その翌月を在庫の基準月として提案する */
    const hit = file.name.match(/(20\d{2})[-_\/]?(\d{1,2})/);
    if (hit) {
      const y = Number(hit[1]), mth = Number(hit[2]);
      if (mth >= 1 && mth <= 12) {
        const d = new Date(y, mth, 1);
        setBaseYM({ year: d.getFullYear(), month: d.getMonth() + 1 });
        found.push(`ファイル名から ${y}年${mth}月末の在庫と判断し、基準月を ${d.getFullYear()}年${d.getMonth() + 1}月にしました。`);
      }
    }

    setFileName(file.name);
    setNotes(found);
    setPreview({
      products,
      lotCount: products.reduce((s, x) => s + x.lots.length, 0),
      multiLot: products.filter((x) => x.lots.length > 1).length,
      withExpiry: products.reduce((s, x) => s + x.lots.filter((l) => l.expiry).length, 0),
      totalQty: products.reduce((s, x) => s + x.lots.reduce((t, l) => t + l.quantity, 0), 0),
    });
  };

  return (
    <Modal open={open} title="CSV取込" subtitle="月次在庫表の期末在庫をロット単位で読み込みます"
      onClose={() => { reset(); onClose(); }} size="lg"
      footer={<>
        <button className={secondaryBtn} onClick={() => { reset(); onClose(); }}>キャンセル</button>
        <button className={primaryBtn} disabled={!preview}
          onClick={() => { onImport(preview, { specId, baseYM, lockPast, zeroMissing, replaceProducts }); reset(); onClose(); }}>
          {preview ? `${preview.products.length} 商品を取り込む` : '取り込む'}
        </button>
      </>}>
      <div className="space-y-4">
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
          <p className="mb-1 font-medium text-gray-800">読み取る列</p>
          <p>品番 / 商品名 / 規格1・2 / 消費期限 / ロット / 期末在庫</p>
          <p className="mt-1 text-gray-500">
            同じ品番の行はロットとしてまとめます。期末在庫がない表では「在庫数」を使います。Shift_JIS のままで読めます。
          </p>
        </div>

        <div className="rounded-xl border border-teal-200 bg-teal-50/50 p-4">
          <div className="mb-2 flex items-center gap-1.5">
            <CalendarClock className="h-4 w-4 text-teal-600" />
            <h3 className="text-sm font-semibold text-gray-900">この在庫はいつ時点のものか</h3>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="基準の年">
              <NumField className={inputClass} value={baseYM.year}
                onChange={(v) => setBaseYM({ ...baseYM, year: v })} />
            </Field>
            <Field label="基準の月" hint="この月から在庫の試算を始めます">
              <select className={inputClass} value={baseYM.month}
                onChange={(e) => setBaseYM({ ...baseYM, month: Number(e.target.value) })}>
                {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1}月</option>)}
              </select>
            </Field>
          </div>
          <label className="mt-3 flex items-start gap-2 text-xs text-gray-700">
            <input type="checkbox" className="mt-0.5 rounded border-gray-300 text-teal-600"
              checked={lockPast} onChange={(e) => setLockPast(e.target.checked)} />
            <span>
              基準月より前の在庫を実績として固定する
              <span className="block text-gray-500">
                今表示されている在庫数をその月の実績として書き込み、以降の取込で上書きされないようにします。
              </span>
            </span>
          </label>
          <label className="mt-2 flex items-start gap-2 text-xs text-gray-700">
            <input type="checkbox" className="mt-0.5 rounded border-gray-300 text-teal-600"
              checked={replaceProducts} onChange={(e) => setReplaceProducts(e.target.checked)} />
            <span>
              取込前に既存の商品をすべて削除する
              <span className="block text-gray-500">
                商品コードの体系が変わったときに使います。出荷区分の割り当ても消えるので、取込後に設定し直してください。
              </span>
            </span>
          </label>
          <label className="mt-2 flex items-start gap-2 text-xs text-gray-700">
            <input type="checkbox" className="mt-0.5 rounded border-gray-300 text-teal-600"
              checked={zeroMissing} onChange={(e) => setZeroMissing(e.target.checked)} />
            <span>
              CSVにない商品の在庫を 0 にする
              <span className="block text-gray-500">
                チェックしない場合、CSVに出てこない商品は前回の在庫のまま残ります。
              </span>
            </span>
          </label>
        </div>

        <Field label="割り当てるカテゴリー / 規格" hint="取込後に在庫一覧から個別に変更できます">
          <select className={inputClass} value={specId} onChange={(e) => setSpecId(e.target.value)}>
            <option value="">未設定のまま取り込む</option>
            {categories.map((c) => (
              <optgroup key={c.id} label={c.name}>
                {specs.filter((x) => x.category_id === c.id).map((x) => <option key={x.id} value={x.id}>{c.name} / {x.name}</option>)}
              </optgroup>
            ))}
          </select>
        </Field>

        <div className="flex flex-wrap gap-4 text-xs">
          <label className="flex items-center gap-1.5 text-gray-700">
            <input type="checkbox" className="rounded border-gray-300 text-teal-600" checked={skipZero} onChange={(e) => setSkipZero(e.target.checked)} />
            期末在庫 0 の行を読み飛ばす
          </label>
          <label className="flex items-center gap-1.5 text-gray-700">
            <input type="checkbox" className="rounded border-gray-300 text-teal-600" checked={skipNoExpiry} onChange={(e) => setSkipNoExpiry(e.target.checked)} />
            消費期限のない行を読み飛ばす（資材を除く）
          </label>
        </div>

        <label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-300 bg-white px-6 py-8 text-center hover:border-teal-400">
          <Upload className="mb-2 h-6 w-6 text-gray-400" />
          <span className="text-sm font-medium text-gray-700">CSVファイルを選ぶ</span>
          <input type="file" accept=".csv,text/csv" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
        </label>

        {fileName && <p className="text-xs text-gray-500">読み込んだファイル: {fileName}</p>}

        {notes.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <ul className="space-y-0.5 text-xs text-amber-700">{notes.map((m, i) => <li key={i}>{m}</li>)}</ul>
          </div>
        )}

        {preview && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[['商品数', preview.products.length], ['ロット数', preview.lotCount],
                ['複数ロット', preview.multiLot], ['合計在庫', preview.totalQty]].map(([l, v]) => (
                <div key={l} className="rounded-xl border border-gray-200 bg-white px-3 py-2">
                  <div className="text-xs text-gray-500">{l}</div>
                  <div className="text-lg font-semibold text-gray-900">{v.toLocaleString()}</div>
                </div>
              ))}
            </div>
            <div className="max-h-48 overflow-y-auto rounded-xl border border-gray-200">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50 text-left text-gray-500">
                  <tr><th className="px-3 py-2">品番</th><th className="px-3 py-2">商品名</th>
                    <th className="px-3 py-2 text-right">ロット</th><th className="px-3 py-2 text-right">期末在庫</th></tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {preview.products.slice(0, 80).map((x, i) => (
                    <tr key={i}>
                      <td className="px-3 py-1.5 text-gray-500">{x.code}</td>
                      <td className="px-3 py-1.5 text-gray-900">{x.name}</td>
                      <td className="px-3 py-1.5 text-right">{x.lots.length}</td>
                      <td className="px-3 py-1.5 text-right">{x.lots.reduce((s, l) => s + l.quantity, 0).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** 出荷区分1行。規格・選択率・固定袋数をまとめて扱う */
function StreamRow({ categories, specs, primary, specId, share, monthlyBags, productCategoryId, onSpec, onShare, onBags, onRemove }) {
  const spec = specs.find((x) => x.id === specId);
  const cat = categories.find((x) => x.id === spec?.category_id);
  const fixed = num(monthlyBags) > 0;
  const clearance = spec?.source === 'clearance';
  const isCross = !primary && cat && productCategoryId && cat.id !== productCategoryId;

  return (
    <div>
    <div className="flex items-center gap-1">
      <select
        style={{ width: 190 }}
        className={`shrink-0 rounded-md border py-1 pl-2 pr-6 text-xs outline-none focus:border-teal-500 ${
          !specId ? 'border-amber-300 bg-amber-50 text-amber-700'
            : primary ? 'border-gray-300 text-gray-700'
              : isCross ? 'border-violet-300 bg-violet-50 text-violet-800'
                : 'border-indigo-200 bg-indigo-50/50 text-indigo-800'}`}
        value={specId ?? ''} onChange={(e) => onSpec(e.target.value || null)}>
        <option value="">{primary ? '未設定' : '区分を選択'}</option>
        {categories.map((c) => (
          <optgroup key={c.id} label={c.name}>
            {specs.filter((x) => x.category_id === c.id).map((x) => <option key={x.id} value={x.id}>{x.name}（{SPEC_SOURCES[x.source]?.label ?? x.source}）</option>)}
          </optgroup>
        ))}
      </select>

      {clearance ? (
        <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">在庫連動</span>
      ) : (
        <>
          <div className="relative shrink-0" style={{ width: 68 }}>
            <NumField step="0.01" min={0} disabled={fixed}
              title="この区分での選択率。出荷件数に比例します"
              className={`w-full rounded-md border py-1 pl-1.5 pr-4 text-right text-xs outline-none focus:border-teal-500 ${fixed ? 'border-gray-100 bg-gray-50 text-gray-300' : 'border-gray-300'}`}
              value={share} onChange={(v) => onShare(v)} />
            <span className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-xs text-gray-400">%</span>
          </div>
          <div className="relative shrink-0" style={{ width: 72 }}>
            <NumField min={0}
              title="月あたりの固定袋数。0以外にすると選択率より優先します"
              className={`w-full rounded-md border py-1 pl-1.5 pr-5 text-right text-xs outline-none focus:border-teal-500 ${fixed ? 'border-teal-300 bg-teal-50 font-medium text-teal-800' : 'border-gray-300'}`}
              value={monthlyBags} onChange={(v) => onBags(v)} />
            <span className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-xs text-gray-400">袋</span>
          </div>
        </>
      )}

      {cat && !primary && (
        <span className={`text-xs ${isCross ? 'font-medium text-violet-600' : 'text-gray-400'}`}>
          {cat.name}{isCross && '（クロス）'}
        </span>
      )}
      {onRemove && (
        <button title="この区分を外す" onClick={onRemove} className="rounded p-0.5 text-gray-400 hover:text-red-600">
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
    {isCross && (
      <p className="mt-0.5 text-[11px] text-violet-600">
        クロス：{cat.name}「{spec.name}」の数字に選択率{num(share)}%で連動します。
      </p>
    )}
    </div>
  );
}

function InventoryTable({ products, lots, categories, specs, safetyOf, sortMode = 'manual', onEdit, onDelete, onEditLots, onUpdateShare, onUpdateSpec, onUpdateStreams, onUpdateProduct, onReorder, onIncoming, onBulkHideZero, onBulkHideExpired, onBulkHideDiscontinued }) {
  const [query, setQuery] = useState('');
  const [filterSpec, setFilterSpec] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [confirmHide, setConfirmHide] = useState(false);
  const [bulkTarget, setBulkTarget] = useState('zero');
  const [expanded, setExpanded] = useState({});
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);

  /* 掴んだ行を、重ねた行の位置へ入れ替える */
  const handleDrop = (targetId) => {
    if (!dragId || dragId === targetId) { setDragId(null); setOverId(null); return; }
    const ordered = [...products].sort((a, b) => (num(a.order) - num(b.order)) || a.name.localeCompare(b.name, 'ja'));
    const from = ordered.findIndex((x) => x.id === dragId);
    const to = ordered.findIndex((x) => x.id === targetId);
    if (from < 0 || to < 0) { setDragId(null); setOverId(null); return; }
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    onReorder?.(ordered.map((x, i) => ({ id: x.id, order: (i + 1) * 10 })));
    setDragId(null); setOverId(null);
  };

  const lotsByProduct = useMemo(() => {
    const m = new Map();
    lots.forEach((l) => { if (!m.has(l.product_id)) m.set(l.product_id, []); m.get(l.product_id).push(l); });
    return m;
  }, [lots]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const today = todayIso();
    return products.map((p) => {
      const pl = sortLots(lotsByProduct.get(p.id) ?? []);
      const total = pl.reduce((s, l) => s + num(l.quantity), 0);
      /* 原価はロットごとに違うことがあるので、合計せず「単価」のまま集める。
         同じ単価のロットしかなければ1つに、違えば複数残す（平均しない） */
      const costs = [...new Set(pl.filter((l) => num(l.quantity) > 0 && lotCost(l) > 0).map((l) => lotCost(l)))];
      const withExp = pl.filter((l) => l.expiry && l.quantity > 0);
      return { p, lots: pl, total, costs, nearest: withExp[0]?.expiry ?? null,
        expired: withExp.filter((l) => l.expiry < today).reduce((s, l) => s + l.quantity, 0) };
    }).filter((r) => {
      if (!showHidden && r.p.hidden) return false;
      if (filterSpec === 'none' && r.p.spec_id) return false;
      if (filterSpec && filterSpec !== 'none' && r.p.spec_id !== filterSpec) return false;
      if (!q) return true;
      return [r.p.name, r.p.code].some((v) => (v ?? '').toLowerCase().includes(q));
    }).sort((a, b) => {
      switch (sortMode) {
        case 'name': return a.p.name.localeCompare(b.p.name, 'ja');
        case 'code': return (a.p.code || '').localeCompare(b.p.code || '', 'ja');
        case 'stock': return b.total - a.total;
        case 'expiry': return (a.nearest || '9999-12-31').localeCompare(b.nearest || '9999-12-31');
        case 'manual': return (num(a.p.order) - num(b.p.order)) || a.p.name.localeCompare(b.p.name, 'ja');
        default: return (num(b.p.share) - num(a.p.share)) || a.p.name.localeCompare(b.p.name, 'ja');
      }
    });
  }, [products, lotsByProduct, query, filterSpec, sortMode, showHidden]);

  const hiddenCount = products.filter((p) => p.hidden).length;
  const today = todayIso();
  const zeroStockVisibleCount = products.filter((p) => {
    if (p.hidden) return false;
    const stock = (lotsByProduct.get(p.id) ?? []).reduce((s, l) => s + num(l.quantity), 0);
    return stock <= 0;
  }).length;
  const expiredVisibleCount = products.filter((p) => {
    if (p.hidden) return false;
    const lots = lotsByProduct.get(p.id) ?? [];
    const stock = lots.reduce((s, l) => s + num(l.quantity), 0);
    if (stock <= 0) return false;
    const expired = lots.filter((l) => l.expiry && l.expiry < today).reduce((s, l) => s + num(l.quantity), 0);
    return expired >= stock;
  }).length;
  const discontinuedVisibleCount = products.filter((p) => !p.hidden && p.discontinued).length;
  const bulkOptions = [
    { key: 'zero', label: '在庫0の商品', count: zeroStockVisibleCount },
    { key: 'expired', label: 'すべて期限切れの商品', count: expiredVisibleCount },
    { key: 'discontinued', label: '廃番（定期に出せない）の商品', count: discontinuedVisibleCount },
  ].filter((o) => o.count > 0);
  const activeBulk = bulkOptions.find((o) => o.key === bulkTarget) ?? bulkOptions[0];

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* 検索は広く。入力内容が隠れないように最小幅を確保する */}
        <div className="relative min-w-0 flex-1" style={{ minWidth: 260 }}>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-8 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            placeholder="商品名・コードで検索" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button onClick={() => setQuery('')} title="検索条件を消す"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {/* 絞り込みは必要な幅だけ */}
        <select
          className="shrink-0 rounded-lg border border-gray-300 py-2 pl-2.5 pr-7 text-sm text-gray-700 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
          style={{ width: 200 }}
          value={filterSpec} onChange={(e) => setFilterSpec(e.target.value)}>
          <option value="">すべての区分</option>
          <option value="none">未設定の商品のみ</option>
          {categories.map((c) => (
            <optgroup key={c.id} label={c.name}>
              {specs.filter((s) => s.category_id === c.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </optgroup>
          ))}
        </select>
        <span className="shrink-0 text-xs text-gray-500">{rows.length} 件</span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 text-xs text-gray-600">
          <input type="checkbox" className="rounded border-gray-300 text-teal-600"
            checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          非表示の商品も表示する{hiddenCount > 0 && `（${hiddenCount}件）`}
        </label>
        {bulkOptions.length > 0 && activeBulk && (
          confirmHide ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-gray-600">{activeBulk.label} {activeBulk.count}件を非表示にします（削除はしません）。よろしいですか？</span>
              <button onClick={() => {
                const fn = activeBulk.key === 'zero' ? onBulkHideZero : activeBulk.key === 'expired' ? onBulkHideExpired : onBulkHideDiscontinued;
                fn?.();
                setConfirmHide(false);
              }}
                className="rounded-lg bg-gray-800 px-2.5 py-1.5 font-medium text-white hover:bg-gray-900">
                実行する
              </button>
              <button onClick={() => setConfirmHide(false)}
                className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 font-medium text-gray-600 hover:bg-gray-50">
                やめる
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <select value={activeBulk.key} onChange={(e) => setBulkTarget(e.target.value)}
                className="rounded-lg border border-gray-300 bg-white py-1.5 pl-2 pr-6 text-xs text-gray-700 outline-none focus:border-teal-500">
                {bulkOptions.map((o) => <option key={o.key} value={o.key}>{o.label}（{o.count}件）</option>)}
              </select>
              <button
                onClick={() => setConfirmHide(true)}
                className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
                <Ban className="h-3.5 w-3.5" />一括で非表示にする
              </button>
            </div>
          )
        )}
      </div>

      {sortMode === 'manual' && (
        <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
          左端の
          <GripVertical className="mx-1 inline h-3 w-3 text-gray-400" />
          を掴んで上下にドラッグすると並べ替えできます。ここで決めた順番がシミュレーションにも反映されます。
        </p>
      )}

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <ScrollXSynced>
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-20"><tr className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium text-gray-500">
              <th className="px-2 py-3" style={{ width: 56 }}></th><th className="px-3 py-3">商品</th>
              <th className="px-3 py-3">出荷区分（規格 / 選択率 / 固定袋数）</th><th className="px-3 py-3">最短の賞味期限</th>
              <th className="px-3 py-3 text-right">安全在庫</th>
              <th className="px-3 py-3 text-right">合計在庫</th>
              <th className="sticky right-0 top-0 z-30 bg-gray-50 px-3 py-3 text-right shadow-[-4px_0_6px_-2px_rgba(0,0,0,0.08)]">操作</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {rows.length === 0 && <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-gray-500">商品がありません。</td></tr>}
              {rows.map(({ p, lots: pl, total, costs, nearest, expired }) => {
                return (
                  <Fragment key={p.id}>
                    <tr
                      draggable={sortMode === 'manual'}
                      onDragStart={() => setDragId(p.id)}
                      onDragOver={(e) => { if (sortMode === 'manual' && dragId) { e.preventDefault(); setOverId(p.id); } }}
                      onDragLeave={() => setOverId((v) => (v === p.id ? null : v))}
                      onDrop={(e) => { e.preventDefault(); handleDrop(p.id); }}
                      onDragEnd={() => { setDragId(null); setOverId(null); }}
                      className={`transition ${dragId === p.id ? 'opacity-40' : ''} ${p.hidden ? 'bg-gray-50/70' : ''} ${
                        overId === p.id && dragId !== p.id ? 'border-t-2 border-teal-500 bg-teal-50/40' : 'hover:bg-gray-50/60'}`}>
                      <td className="px-2 py-3">
                        <div className="flex items-center gap-0.5">
                          {sortMode === 'manual' && (
                            <span title="ドラッグで並べ替え" className="cursor-grab select-none text-gray-300 hover:text-gray-500 active:cursor-grabbing">
                              <GripVertical className="h-4 w-4" />
                            </span>
                          )}
                          {pl.length > 0 && (
                            <button onClick={() => setExpanded((s) => ({ ...s, [p.id]: !s[p.id] }))} className="rounded p-0.5 text-gray-400 hover:text-gray-700">
                              {expanded[p.id] ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className={`font-medium ${p.hidden ? 'text-gray-400' : 'text-gray-900'}`}>
                          {p.name}
                          {p.hidden && <span className="ml-1.5 rounded bg-gray-100 px-1 py-0.5 text-xs font-normal text-gray-500">非表示</span>}
                          {p.discontinued && <span className="ml-1.5 rounded bg-amber-50 px-1 py-0.5 text-xs font-normal text-amber-700">廃番</span>}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-gray-400">
                          {p.code && <span>{p.code}</span>}
                          {pl.length > 1 && <span className="inline-flex items-center gap-0.5 rounded bg-gray-100 px-1 py-0.5 text-gray-600"><Layers className="h-3 w-3" />{pl.length}ロット</span>}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="space-y-1">
                          {/* 主たる出荷区分 */}
                          <StreamRow
                            categories={categories} specs={specs} primary
                            specId={p.spec_id} share={num(p.share)} monthlyBags={num(p.monthlyBags)}
                            productCategoryId={specs.find((x) => x.id === p.spec_id)?.category_id}
                            onSpec={(v) => onUpdateSpec(p.id, v)}
                            onShare={(v) => onUpdateShare(p.id, v)}
                            onBags={(v) => onUpdateProduct(p.id, { monthlyBags: v })}
                          />
                          {/* 追加の出荷区分 */}
                          {(p.streams ?? []).map((st, si) => (
                            <StreamRow key={st.id ?? si}
                              categories={categories} specs={specs}
                              specId={st.spec_id} share={num(st.share)} monthlyBags={num(st.monthlyBags)}
                              productCategoryId={specs.find((x) => x.id === p.spec_id)?.category_id}
                              onSpec={(v) => onUpdateStreams(p.id, (p.streams ?? []).map((x, xi) => (xi === si ? { ...x, spec_id: v } : x)))}
                              onShare={(v) => onUpdateStreams(p.id, (p.streams ?? []).map((x, xi) => (xi === si ? { ...x, share: v } : x)))}
                              onBags={(v) => onUpdateStreams(p.id, (p.streams ?? []).map((x, xi) => (xi === si ? { ...x, monthlyBags: v } : x)))}
                              onRemove={() => onUpdateStreams(p.id, (p.streams ?? []).filter((_, xi) => xi !== si))}
                            />
                          ))}
                          <button
                            onClick={() => onUpdateStreams(p.id, [...(p.streams ?? []), { id: uid(), spec_id: null, share: num(p.share), monthlyBags: 0 }])}
                            className="flex items-center gap-0.5 rounded-md border border-dashed border-gray-300 px-1.5 py-0.5 text-xs text-gray-500 hover:border-teal-400 hover:text-teal-600">
                            <Plus className="h-3 w-3" />区分・クロスを追加
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          {nearest ? <ExpiryBadge expiry={nearest} /> : <span className="text-xs text-gray-400">期限なし</span>}
                          {costs.length === 1 && (
                            <span className="whitespace-nowrap text-xs text-gray-500">原価 ¥{Math.round(costs[0]).toLocaleString()}</span>
                          )}
                          {costs.length > 1 && (
                            <span title={costs.map((c) => `¥${Math.round(c).toLocaleString()}`).join(' / ')}
                              className="whitespace-nowrap rounded bg-amber-50 px-1 text-xs text-amber-700">
                              原価がロットで異なる（{costs.length}種類・下で確認）
                            </span>
                          )}
                        </div>
                        {expired > 0 && <div className="mt-0.5 flex items-center gap-1 text-xs text-red-600"><Ban className="h-3 w-3" />期限切れ {expired.toLocaleString()}</div>}
                      </td>
                      <td className="px-3 py-3 text-right text-gray-600">
                        {(() => { const sv = safetyOf ? safetyOf(p.id) : null;
                          return sv === null ? num(p.safety_stock).toLocaleString()
                            : <span className="rounded-md bg-teal-50 px-1.5 py-0.5 text-xs text-teal-700">{sv.toLocaleString()} 自動</span>; })()}
                      </td>
                      <td className={`px-3 py-3 text-right font-medium ${(() => { const sv = safetyOf ? safetyOf(p.id) : num(p.safety_stock); return total <= (sv ?? 0) ? 'text-amber-700' : 'text-gray-900'; })()}`}>
                        {total.toLocaleString()}
                      </td>
                      <td className="sticky right-0 z-10 bg-white px-3 py-3 shadow-[-4px_0_6px_-2px_rgba(0,0,0,0.08)]">
                        <div className="flex items-center justify-end gap-1">
                          <button title="入荷（納品）登録" onClick={() => onIncoming(p)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-teal-600"><Truck className="h-4 w-4" /></button>
                          <button title="ロットと賞味期限" onClick={() => onEditLots(p)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-teal-600"><Layers className="h-4 w-4" /></button>
                          <button title={p.hidden ? '表示に戻す' : '非表示にする'} onClick={() => onUpdateProduct(p.id, { hidden: !p.hidden })}
                            className={`rounded-lg p-1.5 hover:bg-gray-100 ${p.hidden ? 'text-teal-600' : 'text-gray-400 hover:text-gray-700'}`}>
                            {p.hidden ? <Search className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
                          </button>
                          <button title={p.discontinued ? '廃番を解除する' : '廃番（定期に出せない）にする'} onClick={() => onUpdateProduct(p.id, { discontinued: !p.discontinued })}
                            className={`rounded-lg p-1.5 hover:bg-gray-100 ${p.discontinued ? 'text-amber-600' : 'text-gray-400 hover:text-gray-700'}`}>
                            <AlertTriangle className="h-4 w-4" />
                          </button>
                          <button title="編集" onClick={() => onEdit(p)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-teal-600"><Pencil className="h-4 w-4" /></button>
                          <button title="削除" onClick={() => onDelete(p.id)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                        </div>
                      </td>
                    </tr>
                    {expanded[p.id] && pl.map((l, li) => (
                      <tr key={l.id ?? li} className="bg-gray-50/50 text-xs">
                        <td /><td className="py-1.5 pl-3 text-gray-500">{li + 1}番目に使用</td>
                        <td className="py-1.5"><ExpiryBadge expiry={l.expiry} /></td>
                        <td className="py-1.5 text-gray-500">{lotCost(l) > 0 ? `原価 ¥${Math.round(lotCost(l)).toLocaleString()}` : ''}</td>
                        <td /><td className="py-1.5 pr-3 text-right text-gray-700">{num(l.quantity).toLocaleString()}</td>
                        <td className="sticky right-0 z-10 bg-gray-50/50" />
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </ScrollXSynced>
      </div>
    </div>
  );
}

/* ============================================================
   サンプルデータ
   ============================================================ */

function seedData() {
  const startYM = { year: 2026, month: 4 };
  const months = buildMonths(startYM, HORIZON);

  /* ---- ヘルシー ---- */
  const healthy = {
    ...blankCategory, id: uid(), name: 'ヘルシー', subscriptionRate: 100,
    retention: [...PRESET_RETENTION], activity: [...PRESET_ACTIVITY],
    legacyStart: 1293, legacyRetention: 90, newCustomers: {},
    upsellRates: {}, upsellRateDefault: 15,
    /* 受注明細CSVでの運用が前提のカテゴリーなので、サンプルデータでも
       「発送済み／キャンセル・保留で入力」をオンにし、4月分の実績を入れておく */
    useConfirmedModel: true,
    confirmedNew: { '2026-04': 395 },
    pendingCancelNew: { '2026-04': 24 },
    repeatActual: { '2026-04': 1228 },
    rowNotes: {
      subNew: 'ECforce の受注管理 → 定期受注\n作成日を当月で絞り、定期回数を 1 にした件数',
    },
  };
  /* PDFのアップセル率 */
  const upSeq = [13, 13, 13, 17, 20, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15];
  const hSeq = [399, 900, 999, 995, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500];
  months.forEach((mo, i) => {
    healthy.newCustomers[mo.key] = hSeq[i] ?? 1500;
    healthy.upsellRates[mo.key] = upSeq[i] ?? 15;
  });

  /* ---- イヌメシ ---- */
  const inumeshi = {
    ...blankCategory, id: uid(), name: 'イヌメシ', subscriptionRate: 64,
    retention: [100, 45, 33, 27, 25, 20, 18, 17, 16, 13, 12, 11, 10, 9, 9, 8, 8, 7, 7, 6, 6, 5, 5, 4],
    activity: rate24(100).map((v, i) => (i === 0 ? 120 : 100)),
    legacyStart: 197, legacyRetention: 90, newCustomers: {},
  };
  const iSeq = [14, 8, 14, 26, 10, 10, 10, 10, 10, 10, 10, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  months.forEach((mo, i) => { inumeshi.newCustomers[mo.key] = iSeq[i] ?? 0; });

  /* 定期便は賞味期限の2ヶ月前まで。サンプル・単品は期限まで使える */
  /* 表示順は 100g → 800g → 1kg */
  const s100 = { ...blankSpec, id: uid(), order: 0, name: '100g 初回', category_id: healthy.id, source: 'first_base', bagsMode: 'fixed', bagsPerOrder: 1, marginMonths: 2 };
  /* 800g は「全出荷件数 − 100g − 1kg」。途中でサイズ変更した分も拾える */
  const s800 = { ...blankSpec, id: uid(), order: 1, name: '800g 定期', category_id: healthy.id, source: 'cohort_legacy', bagsMode: 'fixed', bagsPerOrder: 2.4, mallRate: 8, marginMonths: 2, legacyStart: 800, legacyRetention: 95 };
  const s1kg = { ...blankSpec, id: uid(), order: 2, name: '1kg 定期', category_id: healthy.id, source: 'legacy', bagsMode: 'fixed', bagsPerOrder: 3.4, legacyStart: 657, legacyRetention: 95, marginMonths: 2 };
  /* サンプルは初回件数に連動させる（新規のお客様に同梱するため） */
  const sTan = { ...blankSpec, id: uid(), order: 3, name: '単品・サンプル', category_id: healthy.id, source: 'first', bagsMode: 'fixed', bagsPerOrder: 1, marginMonths: 0 };
  /* 見切り消化：定期に出せなくなった在庫を月200袋まで捌く */
  const sClr = { ...blankSpec, id: uid(), order: 5, name: '見切り消化', category_id: healthy.id, source: 'clearance', bagsMode: 'fixed', bagsPerOrder: 1, marginMonths: 0, clearanceCap: 200 };
  const sInu = { ...blankSpec, id: uid(), name: '通常 定期', category_id: inumeshi.id, source: 'all', bagsMode: 'fixed', bagsPerOrder: 22.1, marginMonths: 2 };
  const sInuS = { ...blankSpec, id: uid(), name: 'サンプル・単品', category_id: inumeshi.id, source: 'first', bagsMode: 'fixed', bagsPerOrder: 1, marginMonths: 0 };
  /* クロスセル：規格を経由せず、イヌメシ自身のカテゴリーの「新規・アップセル初回発送数」に直接連動させる
     （継続顧客・全件ではなく、新規のみ。規格を作る必要はない）。 */
  const sInuX = {
    ...blankSpec, id: uid(), name: 'クロスセル', category_id: inumeshi.id, source: 'cross',
    bagsMode: 'fixed', bagsPerOrder: 1, marginMonths: 0,
    crossFromCategory: inumeshi.id, crossFromMetric: 'upsellUnits', crossRate: 20,
  };
  const sInuC = { ...blankSpec, id: uid(), name: '見切り消化', category_id: inumeshi.id, source: 'clearance', bagsMode: 'fixed', bagsPerOrder: 1, marginMonths: 0, clearanceCap: 100 };
  /* ヘルシー→イヌメシの同梱枠。規格を経由せず、ヘルシーの「新規・アップセル初回発送数」に直接連動する。
     カテゴリーの数値（100g/800gなどのサイズに分かれる前の人数）を直接参照するので、
     ヘルシー側に専用の規格を作る必要がない。streams（追加の出荷区分）は参照先の袋数に
     依存してしまうため使わず、必ずこの「クロス（source: 'cross'）」を使う。 */
  const sInuFromHtoI = {
    ...blankSpec, id: uid(), order: 3.6, name: 'ヘルシー同梱（新規・本商品件数より）', category_id: inumeshi.id, source: 'cross',
    bagsMode: 'fixed', bagsPerOrder: 1, marginMonths: 0,
    crossFromCategory: healthy.id, crossFromMetric: 'upsellUnits', crossRate: 10,
  };

  const products = [];
  const lots = [];

  /* 発注書シートの単価。納品ごとに変わる前提の初期値 */
  const costTable = {
    mix1k: 789.5, fish1k: 839.5, potato1k: 1039.5, horse1k: 999.5,
    mix800: 631.6, fish800: 671.6, potato800: 831.6, horse800: 799.6,
    mix100: 90.5, fish100: 95.5, potato100: 115.5, horse100: 108.5,
    gensen: 906.0, teishibou: 940.8, teirin: 1056.0,
  };
  const add = (name, code, spec, share, stock, expiry, safety = 0, monthlyBags = 0, streams = []) => {
    const id = uid();
    products.push({ ...blankProduct, id, code, name, spec_id: spec.id, share, monthlyBags, streams, safety_stock: safety });
    if (stock > 0) lots.push({ id: uid(), product_id: id, expiry, quantity: stock, specIds: [] });
  };
  /* サンプルは選択率で件数に連動、見切りは在庫連動（上限のみ） */
  /* サンプル・単品は同じ味の構成比を使う。見切りは在庫連動なので率を持たない */
  const sample = (rate) => ([
    { id: uid(), spec_id: sTan.id, share: rate, monthlyBags: 0 },
    { id: uid(), spec_id: sClr.id, share: 0, monthlyBags: 0 },
  ]);
  const inuSample = (rate, htoi = 0) => ([
    { id: uid(), spec_id: sInuS.id, share: rate, monthlyBags: 0 },
    { id: uid(), spec_id: sInuX.id, share: rate, monthlyBags: 0 },
    { id: uid(), spec_id: sInuC.id, share: 0, monthlyBags: 0 },
    /* ヘルシーの新規・本商品件数に連動して同梱する。
       sInuFromHtoI が「件数」を先に計算してから自分の袋数(bagsPerOrder)に換算しているので、
       ここでは通常の商品と同じように share で配分するだけでよい（袋数は正しく揃っている）。 */
    ...(htoi > 0 ? [{ id: uid(), spec_id: sInuFromHtoI.id, share: htoi, monthlyBags: 0 }] : []),
  ]);

  /* 複数ロットをそのまま登録する。期限の近いロットはサンプル区分専用にする */
  const addMulti = (name, code, spec, share, lotDefs, safety = 0, streams = []) => {
    const id = uid();
    products.push({ ...blankProduct, id, code, name, spec_id: spec.id, share, streams, safety_stock: safety });
    const sorted = [...lotDefs].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    sorted.forEach(([expiry, quantity], i) => {
      /* 最も期限の近いロットは、サンプル区分を持つ商品ならそちら専用にしておく */
      const sampleSpec = streams[0]?.spec_id;
      const specIds = i === 0 && sorted.length > 1 && sampleSpec ? [sampleSpec] : [];
      /* 原価は納品ごとに変わるため、ロットごとに少しずらしておく */
      const base = costTable[code] ?? 0;
      const cost = base > 0 ? Math.round(base * (1 + i * 0.02) * 10) / 10 : 0;
      lots.push({ id: uid(), product_id: id, expiry: expiry || '', quantity, specIds, cost, costParts: {} });
    });
  };

  /* ヘルシー：1kg / 800g / 100g */
  addMulti('ヘルシーミックス 1kg', 'mix1k', s1kg, 54.69, [['2027-04-30', 278], ['2027-05-31', 1594], ['2027-07-31', 376]], 200, sample(54.69));
  addMulti('ヘルシー魚 1kg', 'fish1k', s1kg, 29.68, [['2027-05-31', 601], ['2027-07-31', 848]], 200, sample(29.68));
  addMulti('ヘルシーさつまいも 1kg', 'potato1k', s1kg, 15.63, [['2027-03-31', 16], ['2027-06-30', 950]], 100, sample(15.63));
  add('ヘルシーミックス 800g', 'mix800', s800, 40.60, 1251, '2027-04-30', 300);
  add('ヘルシー魚 800g', 'fish800', s800, 38.30, 639, '2027-04-30', 300);
  add('ヘルシーさつまいも 800g', 'potato800', s800, 4.10, 734, '2027-06-30', 100);
  add('ヘルシー馬肉 800g', 'horse800', s800, 17.00, 986, '2027-04-30', 200);
  add('ヘルシー馬肉 1kg', 'horse1k', s1kg, 0, 0, '', 100);
  add('ヘルシーミックス 100g', 'mix100', s100, 100, 421, '2027-04-30', 200);
  add('ヘルシー魚 100g', 'fish100', s100, 100, 381, '2027-04-30', 200);
  add('ヘルシーさつまいも 100g', 'potato100', s100, 100, 409, '2027-04-30', 200);
  add('ヘルシー馬肉 100g', 'horse100', s100, 100, 873, '2027-04-30', 200);

  /* 単品（1kg）: 月あたり固定袋数で計算する */
  addMulti('自然派わんこの厳選ごはん(1kg)', 'gensen', sTan, 0, [['2027-02-28', 53], ['2027-04-30', 198], ['2027-07-31', 81]], 50);
  addMulti('低脂肪フード(1kg)', 'teishibou', sTan, 0, [['2027-04-30', 31], ['2027-07-31', 258]], 50);
  addMulti('低リンフード(1kg)', 'teirin', sTan, 0, [['2027-02-28', 1], ['2027-04-30', 121]], 50);

  /* イヌメシ：PDFの選択率と 2026/04 時点の在庫 */
  /* イヌメシ：実在庫CSVの品番・消費期限・期末在庫。複数ロットはそのまま持つ */
  const inuShares = {
    'set-kidney1': 13.9, 'set-kidney2': 7.5, 'set-kidney3': 7.0, 'set-kidney5': 6.3, 'set-kidney4': 5.1,
    'set-daily2': 4.7, 'set-daily3': 2.2, 'set-daily5': 1.8,
  };
  const inuLots = [
    ['01　[キドニー]鶏の豆乳スープ', 'set-kidney1', [["2026-11-11", 732], ["2027-06-01", 3015]]],
    ['29[キドニー]ポークビーンズ', 'set-kidney2', [["2026-12-04", 721], ["2027-06-05", 500]]],
    ['30[キドニー]ツナごはん', 'set-kidney3', [["2027-05-01", 802], ["2027-06-11", 300]]],
    ['02　[キドニー]鶏とまとリゾット', 'set-kidney5', [["2027-01-06", 33], ["2027-02-04", 546], ["2027-06-12", 300]]],
    ['03 [キドニー]豚肉ときのこのクリームパスタ', 'set-kidney4', [["2026-11-28", 538], ["2027-06-03", 500]]],
    ['05 [デイリー]肉じゃが', 'set-daily2', [["2026-12-01", 440]]],
    ['06 [デイリー]鶏とまと煮', 'set-daily3', [["2026-12-03", 867]]],
    ['08 [デイリー]白身魚のおじや', 'set-daily5', [["2026-11-10", 51], ["2027-05-13", 284]]],
    ['04 [デイリー]鶏ごぼう煮', 'set-daily1', [["2027-01-05", 460]]],
    ['07 [デイリー]ミートパスタ', 'set-daily4', [["2026-11-25", 149], ["2027-06-12", 487]]],
    ['09 [タミー]鶏わんこそば', 'set-tummy1', [["2027-01-07", 986]]],
    ['11 [タミー]サーモンおからパスタ', 'set-tummy3', [["2027-01-06", 819]]],
    ['10 [タミー]馬肉おかゆ', 'set-tummy2', [["2027-01-08", 1846]]],
    ['12[タミー]牛レバーポテト', 'set-tummy4', [["2027-01-16", 1034]]],
    ['13　[タミー]鶏レバーお好み焼き', 'set-tummy5', [["2027-01-14", 400]]],
    ['23 牛レバー炒め', 'set-ureter5', [["2027-01-16", 329]]],
    ['22 鶏汁', 'set-ureter4', [["2026-12-02", 142], ["2027-05-13", 227]]],
    ['21 豚汁', 'set-ureter3', [["2027-05-12", 364]]],
    ['白身魚のつみれ', 'set-ureter2', [["2026-10-31", 29], ["2027-01-09", 526]]],
    ['19 かしわごはん', 'set-ureter1', [["2026-12-05", 276]]],
    ['14 [ディアー]チキンハンバーグ', 'set-dia1', [["2027-01-13", 1018]]],
    ['16 [ディアー]アジそば', 'set-dia3', [["2027-01-15", 267]]],
    ['15 [ディアー]大根のそぼろ煮', 'set-dia2', [["2026-12-08", 241]]],
    ['17 [ディアー]カレイ炒飯', 'set-dia4', [["2026-10-20", 232], ["2027-06-04", 304]]],
    ['26　[キドニー]鹿肉と彩り野菜のソテー', 'set-kidney6', [["2027-02-04", 91], ["2027-05-12", 1016]]],
    ['27　[タミー]ツナとかぼちゃの和風煮', 'set-tummy6', [["2027-05-02", 103], ["2027-06-04", 301]]],
    ['25　[ディアー]鹿肉と根菜の和風煮', 'set-dia6', [["2027-01-05", 243]]],
    ['28　白身魚の和風とまとスープ', 'set-ureter6', [["2026-12-09", 726]]],
    ['24　[デイリー]サバとりんごのほぐし煮', 'set-daily6', [["2027-05-13", 268]]],
  ];
  inuLots.forEach(([name, code, lotDefs], i) => {
    const share = inuShares[code] ?? Math.max(1, Math.round((100 - 48.5) / Math.max(1, inuLots.length - 8) * 10) / 10);
    /* イヌメシは全商品が「通常 定期」と「サンプル・単品」の2区分を持つ */
    /* 上位3品はヘルシーの新規のお客様にも同梱する（選択率10%） */
    costTable[code] = 200 + (i % 10) * 11;   // 200〜299円/個
    addMulti(name, code, sInu, share, lotDefs, 300, inuSample(share, i < 3 ? 10 : 0));
  });

  /* 動作確認用：鶏の豆乳スープ（set-kidney1）の2027-06-01ロットは、
     同じ賞味期限のまま原価が2種類に分かれる例として、1000袋@202円 / 2015袋@204円に分割しておく。 */
  {
    const target = products.find((x) => x.code === 'set-kidney1');
    if (target) {
      const idx = lots.findIndex((l) => l.product_id === target.id && l.expiry === '2027-06-01');
      if (idx >= 0) {
        const orig = lots[idx];
        lots.splice(idx, 1,
          { ...orig, id: uid(), quantity: 1000, cost: 202 },
          { ...orig, id: uid(), quantity: 2015, cost: 204 },
        );
      }
    }
  }

  /* 単品は月あたり固定袋数で計算する */
  const setFixed = (code, bags) => {
    const t = products.find((x) => x.code === code);
    if (t) t.monthlyBags = bags;
  };
  setFixed('gensen', 50); setFixed('teishibou', 80); setFixed('teirin', 40);

  /* 1kg商品には重量を設定しておく（発注登録での資材の自動計算のデモ用） */
  ['gensen', 'teishibou', 'teirin'].forEach((code) => {
    const t = products.find((x) => x.code === code);
    if (t) { t.weightValue = 1000; t.weightUnit = 'g'; }
  });

  return {
    startYM, months: HORIZON, overrides: {}, purchaseOrders: [],
    stockBaseYM: { year: 2026, month: 8 },
    safetyMode: 'avg', safetyMonths: 3, safetyBaseYM: { year: 2026, month: 7 },
    categories: [healthy, inumeshi],
    specs: [s100, s800, s1kg, sTan, sClr, sInu, sInuS, sInuX, sInuFromHtoI, sInuC],
    products, lots,
    materials: [
      { id: uid(), name: 'パウチ袋（100g用）', unit: '枚', cost: 8, stock: 2000, note: '1袋につき1枚使う例', kind: 'perbag', perBagQty: 1, orderUnit: 0, supplier: '中央包材', trackStock: true },
      { id: uid(), name: 'パウチ袋（800g用）', unit: '枚', cost: 15, stock: 800, note: '1袋につき1枚使う例', kind: 'perbag', perBagQty: 1, orderUnit: 0, supplier: '中央包材', trackStock: true },
      { id: uid(), name: '賞味期限ラベル', unit: '枚', cost: 1.5, stock: 5000, note: '1袋につき1枚使う例', kind: 'perbag', perBagQty: 1, orderUnit: 0, supplier: 'ラベル印刷社', trackStock: true },
      { id: uid(), name: 'ALBOCEL', unit: 'kg', cost: 100, stock: 0, note: '仕入先へは17.5kg単位でのみ発注可能', kind: 'blend', blendRatio: 2.5, orderUnit: 17.5, supplier: '北の原料商事', trackStock: true },
      { id: uid(), name: '商品本体（受注生産）', unit: 'kg', cost: 900, stock: 0, note: '完全受注生産のため在庫は持たない。配合割合100%で、発注数×商品重量がそのまま使用量になる例', kind: 'blend', blendRatio: 100, orderUnit: 0, supplier: '', trackStock: false },
      { id: uid(), name: 'ラベル張り作業料', unit: '個', cost: 5, stock: 0, note: '第2倉庫（サブ倉庫）でのラベル張り工賃。1袋につき1回の例。発注書は送らないため仕入先は空欄でよい', kind: 'perbag', perBagQty: 1, orderUnit: 0, supplier: '', trackStock: false },
    ],
  };
}

/* ============================================================
   納品管理
   ============================================================ */

/** 新しい発注の初期値 */
const blankPo = () => ({
  id: uid(), product_id: null, orderDate: todayIso(), dueDate: '',
  unit: 'bag', orderQty: 0, gramsPerBag: 1000,
  supplier: '', note: '', status: 'ordered', receipts: [],
  materials: [], manufactureRecords: [],
});

/** 資材の単位候補 */
const MATERIAL_UNITS = ['個', '枚', 'kg', 'g', 'm', '本', '袋', 'ロール'];

/** 資材の種別。原料は配合割合、または1袋あたりの使用個数から使用量を自動計算する */
const MATERIAL_KINDS = {
  fixed:  { label: '資材（数量を直接入力）', hint: '発注のたびに数量を自分で入力するもの' },
  perbag: { label: '資材（1袋あたりの使用量で自動計算）', hint: 'パウチ袋・ラベルなど、商品1袋につき使う個数が決まっているもの（例: 1袋につき1枚）' },
  blend:  { label: '原料（配合割合で自動計算）', hint: 'ALBOCELなど、商品の重量 × 配合割合で使用量を自動計算するもの' },
};

const blankMaterial = () => ({
  id: uid(), name: '', unit: '個', cost: 0, stock: 0, note: '', kind: 'fixed', blendRatio: 0, perBagQty: 0,
  orderUnit: 0, minOrderQty: 0, orderUnitFreeAbove: 0, priceTiers: [],
  supplier: '', trackStock: true,
});

/**
 * 発注に紐づく資材の使用量を、資材の在庫に反映する。
 * oldUsage（変更前）と newUsage（変更後）の差分だけ在庫を増減させるので、
 * 新規登録（oldUsage=[]）・編集（差分）・削除（newUsage=[]）のどれでも安全に使える。
 * trackStock が false の資材（完全受注生産で在庫を持たないものなど）は、在庫の増減対象外とする。
 * 在庫は 0 を下限とし、マイナス在庫にはしない（入庫の記録がなく使用だけが続くと、
 * 実態と合わないマイナスの数字が延々と残ってしまうため）。0まで減った後は、それ以上は減らさない。
 */
const applyMaterialUsage = (materials, oldUsage = [], newUsage = []) => {
  const oldMap = new Map((oldUsage ?? []).map((u) => [u.material_id, num(u.qty)]));
  const newMap = new Map((newUsage ?? []).map((u) => [u.material_id, num(u.qty)]));
  const ids = new Set([...oldMap.keys(), ...newMap.keys()].filter(Boolean));
  if (ids.size === 0) return materials;
  return materials.map((m) => {
    if (!ids.has(m.id) || m.trackStock === false) return m;
    const delta = (newMap.get(m.id) || 0) - (oldMap.get(m.id) || 0);
    return delta ? { ...m, stock: Math.max(0, num(m.stock) - delta) } : m;
  });
};

const materialUsageForPo = (po) => (po?.excludeMaterialUsage ? [] : (po?.materials ?? []));

/** 発注1件に登録された資材の原価合計 */
const poMaterialCost = (po) => (po.materials ?? []).reduce((s2, m) => s2 + num(m.qty) * num(m.unitCost), 0);

/**
 * 「原料」「1袋あたりの使用量」種別の資材の使用量を自動計算する。
 *   ・原料（blend）: 使用量(g) = 発注数（袋換算） × 商品の1袋あたりの重量(g) × 配合割合(%)
 *     資材の単位が kg なら kg に、それ以外は g のまま返す。
 *   ・1袋あたりの使用量（perbag）: 使用量 = 発注数（袋換算） × 1袋あたりの使用個数
 * 「資材」種別（数量を直接入力するもの）や、商品未選択のときは null を返す。
 */
const computeAutoQty = (mat, bags, perBagG) => {
  if (!mat) return null;
  if (mat.kind === 'blend') {
    const totalG = num(bags) * num(perBagG) * (num(mat.blendRatio) / 100);
    const qty = mat.unit === 'kg' ? totalG / 1000 : totalG;
    return Math.round(qty * 100) / 100;
  }
  if (mat.kind === 'perbag') {
    return Math.round(num(bags) * num(mat.perBagQty) * 100) / 100;
  }
  return null;
};

/**
 * 「原料」「1袋あたりの使用量」種別の資材の、フード1袋あたりの使用量。
 *   ・原料（blend）: 商品の1袋あたりの重量(g) × 配合割合(%)。資材の単位に合わせて kg にも換算する。
 *   ・1袋あたりの使用量（perbag）: 登録した個数をそのまま返す。
 */
const autoQtyPerBag = (mat, perBagG) => {
  if (!mat) return null;
  if (mat.kind === 'blend') {
    const g = num(perBagG) * (num(mat.blendRatio) / 100);
    return mat.unit === 'kg' ? g / 1000 : g;
  }
  if (mat.kind === 'perbag') return num(mat.perBagQty);
  return null;
};

/**
 * 実際に仕入先へ発注する数量の目安。
 * 「必要量（使用量）− 現在庫」の不足分をもとに、資材の発注ルールを適用する。
 *   ・発注単位（例: 140kg単位）があれば、その倍数に切り上げる
 *   ・ただし「単位縛りが外れる数量」以上になったら、単位への切り上げはせず不足分をそのまま使う
 *     （例: 140kg単位・1トン以上は単位なし → 999kgまでは140刻み、1,000kg以上はそのままの数量）
 *   ・最低発注量があれば、それを下回らないよう引き上げる
 * 不足がない（在庫で足りる）場合は 0。
 * trackStock が false の資材（完全受注生産で在庫を持たないもの）は、在庫を差し引かず必要量そのものを使う。
 */
const suggestOrderQty = (mat, neededQty) => {
  if (!mat) return null;
  const shortfall = mat.trackStock === false
    ? Math.max(0, num(neededQty))
    : Math.max(0, num(neededQty) - num(mat.stock));
  if (shortfall <= 0) return 0;

  const unit = num(mat.orderUnit);
  const freeAbove = num(mat.orderUnitFreeAbove);
  const unitApplies = unit > 0 && !(freeAbove > 0 && shortfall >= freeAbove);

  let qty = unitApplies ? Math.ceil((shortfall - 1e-9) / unit) * unit : shortfall;

  const min = num(mat.minOrderQty);
  if (min > 0 && qty < min) qty = min;

  return Math.round(qty * 1000) / 1000;
};

/**
 * 数量帯ごとの単価（スケールメリット）を適用したときの、実際の単価。
 * priceTiers は [{ minQty, price }, ...]。数量がその最低数量以上になっている、
 * 一番数量の大きい階層の単価を使う。どの階層にも届かない場合は資材の基本単価（cost）を使う。
 */
const priceForQty = (mat, qty) => {
  if (!mat) return 0;
  const tiers = [...(mat.priceTiers ?? [])]
    /* 単価が未入力（0円）の階層は「まだ設定していない」とみなして無視する。
       そうしないと、単価を入れる前に階層を追加しただけで基本単価が永久に上書きされてしまう */
    .filter((t) => num(t.minQty) >= 0 && num(t.price) > 0)
    .sort((a, b) => num(a.minQty) - num(b.minQty));
  let price = num(mat.cost);
  for (const t of tiers) {
    if (num(qty) >= num(t.minQty)) price = num(t.price);
    else break;
  }
  return price;
};

/**
 * すべての進行中の発注書（複数の商品にまたがる）を横断して、資材ごとの必要量を合算する。
 * ALBOCELのように複数商品で使われる原料は、1つの発注書だけでは正しい発注単位に丸められないため、
 * 全体の合計量を先に出してから、発注単位での切り上げ・在庫の差し引きを行う。
 * 完了済み（poStatus === 'done' または手動の 'completed'）・取消の発注書は、通常は対象外にする。
 * includeCompleted を true にすると、過去の時期を見返すときのように、完了済みの発注書も含めて集計する。
 */
const aggregateMaterialUsage = (purchaseOrders, { includeCompleted = false } = {}) => {
  const usage = new Map(); // material_id -> { qty, pos: Set<po_id> }
  (purchaseOrders ?? []).forEach((po) => {
    if (po.status === 'canceled') return;
    if (!includeCompleted && (poStatus(po) === 'done' || poStatus(po) === 'completed')) return;
    materialUsageForPo(po).forEach((m) => {
      if (!m.material_id || num(m.qty) <= 0) return;
      const cur = usage.get(m.material_id) ?? { qty: 0, poIds: new Set() };
      cur.qty += num(m.qty);
      cur.poIds.add(po.id);
      usage.set(m.material_id, cur);
    });
  });
  return usage;
};

/**
 * 資材ごとの合算結果を、発注単位での切り上げ・仕入先ごとのグルーピングまで仕上げる。
 * includeFulfilled が false（既定）のときは、在庫で足りていて発注目安が0になったものは除外する
 * （＝「今まだ発注が必要なものだけ」を見せるデフォルトの表示）。
 * includeFulfilled が true のときは、発注目安が0になっていても、必要量が元々あった資材はそのまま残す
 * （＝過去の時期を選んで「その時期は何がどれだけ必要だったか」を見返すための表示）。
 */
const buildMaterialPurchaseOrder = (materials, purchaseOrders, { includeFulfilled = false } = {}) => {
  const usage = aggregateMaterialUsage(purchaseOrders, { includeCompleted: includeFulfilled });
  const rows = [];
  usage.forEach(({ qty, poIds }, materialId) => {
    const mat = materials.find((x) => x.id === materialId);
    if (!mat) return;
    const orderQty = suggestOrderQty(mat, qty);
    if (!includeFulfilled && (!orderQty || orderQty <= 0)) return;
    /* スケールメリット（数量帯ごとの単価）は、全体の発注数量に対して適用したほうが実態に近い */
    const priceBasis = orderQty > 0 ? orderQty : qty;
    const price = priceForQty(mat, priceBasis);
    rows.push({
      material: mat, usage: qty, orderQty, poCount: poIds.size, price, estCost: price * priceBasis,
      fulfilled: !orderQty || orderQty <= 0,
    });
  });
  const groups = new Map();
  rows.forEach((row) => {
    const key = row.material.supplier?.trim() || '仕入先未設定';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ja'));
};

/** 納品1回分の初期値 */
const blankReceipt = () => ({
  id: uid(), date: todayIso(), quantity: 0, expiry: '',
  cost: 0, costParts: {}, stages: {}, note: '', applied: true,
});

/** 発注1件の編集。納品を何回でもぶら下げられる */
function PoModal({ open, po, products, categories, specs, materials, onClose, onSave, onDelete }) {
  const [form, setForm] = useState(null);
  const [openCostParts, setOpenCostParts] = useState(null);
  useEffect(() => { if (open) { setForm(po ? JSON.parse(JSON.stringify(po)) : null); setOpenCostParts(null); } }, [open, po]);

  const matList = materials ?? [];
  const product = products.find((x) => x.id === form?.product_id);
  const perBagG = weightPerBagG(product);
  const orderedBags = form ? poOrderedInBags(form) : 0;

  if (!open || !form) return null;

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));
  const spec = specs.find((x) => x.id === product?.spec_id);
  const cat = categories.find((x) => x.id === spec?.category_id);

  const updR = (i, k, v) => setForm((p) => ({
    ...p, receipts: (p.receipts ?? []).map((r, idx) => (idx === i ? { ...r, [k]: v } : r)),
  }));
  const updStage = (i, k, v) => setForm((p) => ({
    ...p, receipts: (p.receipts ?? []).map((r, idx) => (
      idx === i ? { ...r, stages: { ...(r.stages ?? {}), [k]: v } } : r)),
  }));
  const addR = () => setForm((p) => ({
    ...p,
    receipts: [...(p.receipts ?? []), {
      id: uid(), date: todayIso(), quantity: 0, expiry: '', cost: num(p.unitCost), costParts: {},
      stages: {}, applied: true, note: '',
    }],
  }));

  /**
   * 資材1行の実際の使用量。「原料」「1袋あたりの使用量」種別は毎回その場で計算し、
   * 保存済みの数字には頼らない。そのため発注数や商品を変えた直後でも必ず最新の値になる。
   * 「資材」種別は入力欄の数量をそのまま使う。
   */
  const lineQty = (m) => {
    const mat = matList.find((x) => x.id === m.material_id);
    const q = computeAutoQty(mat, orderedBags, perBagG);
    return q !== null ? q : num(m.qty);
  };
  /**
   * 資材1行の単価。資材マスタの単価・価格階層を毎回その場で計算する（保存されたスナップショットには頼らない）。
   * そのため資材在庫タブで単価を直しても、この発注書を開き直さなくても即座に反映される。
   */
  const lineUnitCost = (m) => {
    const mat = matList.find((x) => x.id === m.material_id);
    return priceForQty(mat, lineQty(m));
  };

  const addMat = () => setForm((p) => ({
    ...p,
    materials: [...(p.materials ?? []), { id: uid(), material_id: matList[0]?.id ?? '', qty: 0 }],
  }));
  const updMat = (i, k, v) => setForm((p) => ({
    ...p,
    materials: (p.materials ?? []).map((m, idx) => (idx === i ? { ...m, [k]: v } : m)),
  }));
  const rmMat = (i) => setForm((p) => ({ ...p, materials: (p.materials ?? []).filter((_, idx) => idx !== i) }));

  const materializedMaterials = (form.materials ?? []).map((m) => ({ ...m, qty: lineQty(m), unitCost: lineUnitCost(m) }));
  const materialCostTotal = materializedMaterials.reduce((s2, m) => s2 + num(m.qty) * num(m.unitCost), 0);
  const missingWeight = materializedMaterials.some((m) => matList.find((x) => x.id === m.material_id)?.kind === 'blend') && perBagG <= 0;
  /* 発注時点の見込み単価（1袋あたり）。資材原価の合計を発注数で割って自動計算する */
  const estimatedUnitCost = orderedBags > 0 ? materialCostTotal / orderedBags : 0;

  /**
   * 納品1回分の原価（1袋あたり）を、仕入先（会社）ごとに按分する。
   * 発注に登録した資材（原料・資材）の金額を、「この納品の数量 ÷ 発注全体の数量」の割合で配分する。
   * 累計ではなく、この納品1回分だけの金額。
   * 資材の単価が未入力（0円）のときは自動計算ができないため、auto を 0 のまま返す。
   * その場合は呼び出し側で、その仕入先ごとに手入力できるようにする。
   */
  const receiptSupplierParts = (r) => {
    const ratio = orderedBags > 0 ? num(r.quantity) / orderedBags : 0;
    const bySupplier = new Map();
    materializedMaterials.forEach((m) => {
      if (!m.material_id) return;
      const mat = matList.find((x) => x.id === m.material_id);
      const perBag = num(r.quantity) > 0 ? (num(m.qty) * ratio * num(m.unitCost)) / num(r.quantity) : 0;
      const key = mat?.supplier?.trim() || '仕入先未設定';
      /* 資材が1つも金額を持っていなくても、資材が登録されている以上は一覧に出す（手入力できるように） */
      if (!bySupplier.has(key)) bySupplier.set(key, 0);
      bySupplier.set(key, bySupplier.get(key) + perBag);
    });
    return bySupplier;
  };
  /** 仕入先1件分の、この納品での金額。自動計算が0（資材の単価が未入力）のときは、手入力した値を使う */
  const receiptSupplierAmount = (r, supplier, auto) => (auto > 0 ? auto : num(r.costParts?.[supplier]));
  const receiptTotalCost = (r) => {
    const parts = receiptSupplierParts(r);
    let total = 0;
    parts.forEach((auto, supplier) => { total += receiptSupplierAmount(r, supplier, auto); });
    return total + num(r.costParts?.other);
  };
  const materializedReceipts = (form.receipts ?? []).map((r) => {
    const parts = receiptSupplierParts(r);
    const finalParts = {};
    parts.forEach((auto, supplier) => {
      const v = receiptSupplierAmount(r, supplier, auto);
      if (v > 0) finalParts[supplier] = v;
    });
    const other = num(r.costParts?.other);
    if (other > 0) finalParts.other = other;
    return { ...r, costParts: finalParts, cost: receiptTotalCost(r) };
  });

  /* 発注が必要な資材を、仕入先ごとにまとめる（簡易発注書） */
  const supplierGroups = (() => {
    const rows = materializedMaterials
      .map((m) => {
        const mat = matList.find((x) => x.id === m.material_id);
        if (!mat) return null;
        const orderQty = num(mat.orderUnit) > 0
          ? suggestOrderQty(mat, m.qty)
          : Math.max(0, num(m.qty) - num(mat.stock));
        if (!orderQty || orderQty <= 0) return null;
        return { material: mat, orderQty };
      })
      .filter(Boolean);
    const groups = new Map();
    rows.forEach(({ material, orderQty }) => {
      const key = material.supplier?.trim() || '仕入先未設定';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ material, orderQty });
    });
    return [...groups.entries()];
  })();

  const received = poReceived(form);
  const remaining = poRemaining(form);
  const status = poStatus(form);
  /* イヌメシは「製造済みだが未ラベル」という第2倉庫での中間状態を別に持つ。
     未製造 = 発注数 − 製造済み数量／未ラベル張り = 製造済み数量 − 納品済み（＝ラベル張り済み）
     製造済み数量は「納品①」（製造完了・第2倉庫への移動を日付ごとに記録したもの）の合計から出す */
  const manufacturedQty = (form.manufactureRecords ?? []).reduce((s2, r) => s2 + num(r.quantity), 0);
  const notLabeled = cat?.name === 'イヌメシ' ? Math.max(0, manufacturedQty - received) : 0;
  const notManufactured = cat?.name === 'イヌメシ' ? Math.max(0, orderedBags - manufacturedQty) : remaining;

  const addMR = () => setForm((p) => ({
    ...p, manufactureRecords: [...(p.manufactureRecords ?? []), { id: uid(), date: todayIso(), quantity: 0, note: '' }],
  }));
  const updMR = (i, k, v) => setForm((p) => ({
    ...p, manufactureRecords: (p.manufactureRecords ?? []).map((r, idx) => (idx === i ? { ...r, [k]: v } : r)),
  }));
  const rmMR = (i) => setForm((p) => ({ ...p, manufactureRecords: (p.manufactureRecords ?? []).filter((_, idx) => idx !== i) }));

  return (
    <Modal open={open} title={po?.id ? '発注を編集' : '発注を登録'}
      subtitle={product ? `${product.name}${cat ? `（${cat.name}）` : ''}` : '商品を選んでください'}
      onClose={onClose} size="xl"
      footer={<>
        {po?.id && onDelete && (
          <button className="mr-auto rounded-lg border border-red-300 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
            onClick={() => onDelete(po.id)}>この発注を削除</button>
        )}
        <button className={secondaryBtn} onClick={onClose}>キャンセル</button>
        <button className={primaryBtn} disabled={!form.product_id} onClick={() => onSave({ ...form, unitCost: estimatedUnitCost, materials: materializedMaterials, receipts: materializedReceipts })}>保存</button>
      </>}>
      <div className="space-y-5">
        {/* 発注の情報 */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="sm:col-span-3">
            <Field label="商品">
              <select className={inputClass} value={form.product_id ?? ''} onChange={(e) => set('product_id', e.target.value)}>
                <option value="">選択してください</option>
                {categories.map((c) => (
                  <optgroup key={c.id} label={c.name}>
                    {products.filter((x) => specs.some((sp) => sp.id === x.spec_id && sp.category_id === c.id))
                      .map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </optgroup>
                ))}
                <optgroup label="未設定">
                  {products.filter((x) => !x.spec_id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </optgroup>
              </select>
            </Field>
          </div>

          <Field label="発注日">
            <input type="date" className={inputClass} value={form.orderDate ?? ''} onChange={(e) => set('orderDate', e.target.value)} />
          </Field>
          <Field label="納品予定日">
            <input type="date" className={inputClass} value={form.dueDate ?? ''} onChange={(e) => set('dueDate', e.target.value)} />
          </Field>
          <Field label="仕入先">
            <input className={inputClass} value={form.supplier ?? ''} onChange={(e) => set('supplier', e.target.value)} placeholder="例: 北の自然工房" />
          </Field>

          <Field label="発注数">
            <NumField min={0} className={inputClass} value={num(form.orderQty)} onChange={(v) => set('orderQty', v)} />
          </Field>
          <Field label="発注の単位">
            <select className={inputClass} value={form.unit ?? 'bag'} onChange={(e) => set('unit', e.target.value)}>
              {Object.entries(PO_UNITS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          {form.unit === 'kg' && (
            <Field label="1袋あたりの内容量 (g)" hint="重量発注を袋数に換算します">
              <NumField min={0} className={inputClass} value={num(form.gramsPerBag)} onChange={(v) => set('gramsPerBag', v)} />
            </Field>
          )}
          <Field label="発注時の単価（目安）" hint="下の「資材」に登録した内容から自動計算します（資材原価 合計 ÷ 発注数）。手入力はできません。">
            <div className={`${inputClass} bg-gray-50 text-right text-gray-700`}>
              ¥{estimatedUnitCost.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </div>
            {orderedBags > 0 && materialCostTotal === 0 && (
              <p className="mt-1 text-[11px] text-amber-600">下の「資材」に何も登録されていないため、まだ0円です。</p>
            )}
          </Field>
          <label className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 sm:col-span-3">
            <input type="checkbox" className="rounded border-amber-300 text-amber-600"
              checked={form.excludeMaterialUsage === true}
              onChange={(e) => set('excludeMaterialUsage', e.target.checked)} />
            この発注では資材を使用しない（資材在庫から差し引かない）
          </label>
        </div>

        {/* 進捗 */}
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div className={`grid grid-cols-2 gap-3 ${cat?.name === 'イヌメシ' ? 'sm:grid-cols-3 lg:grid-cols-6' : 'sm:grid-cols-4'}`}>
            <div>
              <div className="text-xs text-gray-500">状態</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${PO_STATUS[status].tone}`}>
                  {PO_STATUS[status].label}
                </span>
                {status !== 'canceled' && (
                  status === 'completed' ? (
                    <button onClick={() => set('status', 'ordered')}
                      className="rounded-md border border-gray-300 bg-white px-1.5 py-0.5 text-xs text-gray-600 hover:bg-gray-50">
                      完了を取り消す
                    </button>
                  ) : (
                    <button onClick={() => set('status', 'completed')}
                      className="rounded-md border border-violet-300 bg-violet-50 px-1.5 py-0.5 text-xs text-violet-700 hover:bg-violet-100">
                      完了にする
                    </button>
                  )
                )}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">発注（袋換算）</div>
              <div className="text-sm font-semibold text-gray-900">{Math.round(orderedBags).toLocaleString()}</div>
              {form.unit === 'kg' && <div className="text-xs text-gray-400">{num(form.orderQty)}kg ÷ {num(form.gramsPerBag)}g</div>}
            </div>
            {cat?.name === 'イヌメシ' && (
              <div>
                <div className="text-xs text-gray-500">製造済み数量</div>
                <div className="text-sm font-semibold text-gray-900">{Math.round(manufacturedQty).toLocaleString()}</div>
                <div className="mt-0.5 text-[11px] text-gray-400">「納品①」の合計（下で日付ごとに記録）</div>
              </div>
            )}
            <div>
              <div className="text-xs text-gray-500">{cat?.name === 'イヌメシ' ? '納品済み（＝ラベル張り済み）' : '納品済み'}</div>
              <div className="text-sm font-semibold text-teal-700">{Math.round(received).toLocaleString()}</div>
            </div>
            {cat?.name === 'イヌメシ' && (
              <div>
                <div className="text-xs text-gray-500">未ラベル張り</div>
                <div className={`text-sm font-semibold ${notLabeled > 0.5 ? 'text-sky-700' : 'text-gray-400'}`}>
                  {Math.round(notLabeled).toLocaleString()}
                </div>
                <div className="mt-0.5 text-[11px] text-gray-400">製造済み − 納品済み</div>
              </div>
            )}
            <div>
              <div className="text-xs text-gray-500">未製造</div>
              <div className={`text-sm font-semibold ${notManufactured > 0.5 ? 'text-amber-700' : 'text-gray-400'}`}>
                {Math.round(notManufactured).toLocaleString()}
              </div>
            </div>
          </div>
          {status !== 'completed' && received > 0 && received !== orderedBags && (
            <p className="mt-3 border-t border-gray-200 pt-2 text-xs text-gray-500">
              歩留まりなどで発注数と納品数がぴったり一致しないことがあります。これ以上納品がない場合は「完了にする」を押してください。
              未製造扱いのまま残らず、発注アラートにも再提案されなくなります。
            </p>
          )}
          {status !== 'completed' && remaining > 0.5 && product && (
            <p className="mt-3 border-t border-gray-200 pt-2 text-xs text-amber-700">
              未製造の {Math.round(remaining).toLocaleString()} 袋は、
              {form.dueDate ? `納品予定日（${form.dueDate}）` : '納品予定日が未入力のため今月'}
              に届くものとして仮に在庫へ加算され、発注アラートの必要数もその分減ります。
            </p>
          )}
        </div>

        {/* 納品①（イヌメシのみ：製造完了・第2倉庫への移動を日付ごとに記録） */}
        {cat?.name === 'イヌメシ' && (
          <div className="rounded-xl border border-gray-200 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">納品①（製造完了・第2倉庫への移動）</h3>
                <p className="text-xs text-gray-500">何月に製造が終わったかを、日付ごとに記録します。在庫や最終納品の計算には影響しません。</p>
              </div>
              <button onClick={addMR} className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50">
                納品①を追加
              </button>
            </div>
            {(form.manufactureRecords ?? []).length === 0 ? (
              <p className="rounded-lg bg-gray-50 px-3 py-3 text-xs text-gray-500">まだ記録がありません。</p>
            ) : (
              <div className="space-y-2">
                {(form.manufactureRecords ?? []).map((r, i) => (
                  <div key={r.id} className="flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 bg-white p-2">
                    <label className="block w-40">
                      <span className="mb-1 block text-xs text-gray-500">製造完了日</span>
                      <input type="date" className={inputClass} value={r.date ?? ''} onChange={(e) => updMR(i, 'date', e.target.value)} />
                    </label>
                    <label className="block w-32">
                      <span className="mb-1 block text-xs text-gray-500">数量（袋）</span>
                      <NumField min={0} className={inputClass} value={num(r.quantity)} onChange={(v) => updMR(i, 'quantity', v)} />
                    </label>
                    <label className="block flex-1" style={{ minWidth: 160 }}>
                      <span className="mb-1 block text-xs text-gray-500">メモ</span>
                      <input className={inputClass} value={r.note ?? ''} onChange={(e) => updMR(i, 'note', e.target.value)} placeholder="任意" />
                    </label>
                    <button onClick={() => rmMR(i)} className="mb-1 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                  </div>
                ))}
                <p className="text-right text-xs font-medium text-gray-700">納品①合計：{Math.round(manufacturedQty).toLocaleString()}袋</p>
              </div>
            )}
          </div>
        )}

        {/* 納品（イヌメシは最終納品） */}
        <div className="rounded-xl border border-gray-200 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">{cat?.name === 'イヌメシ' ? '最終納品（メイン倉庫）' : '納品'}</h3>
              <p className="text-xs text-gray-500">分納のたびに1行ずつ追加します。「在庫へ反映」を外すと試算に含めません。</p>
            </div>
            <button onClick={addR} className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50">
              納品を追加
            </button>
          </div>

          {(form.receipts ?? []).length === 0 ? (
            <p className="rounded-lg bg-gray-50 px-3 py-3 text-xs text-gray-500">まだ納品がありません。</p>
          ) : (
            <div className="space-y-3">
              {(form.receipts ?? []).map((r, i) => {
                const parts = receiptSupplierParts(r);
                const otherCost = num(r.costParts?.other);
                const totalCost = receiptTotalCost(r);
                const hasParts = parts.size > 0;
                return (
                <div key={r.id} className="rounded-xl border border-gray-200 bg-white p-3">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                    <Field label="納品日">
                      <input type="date" className={inputClass} value={r.date ?? ''} onChange={(e) => updR(i, 'date', e.target.value)} />
                    </Field>
                    <Field label="納品数（袋）">
                      <NumField min={0} className={inputClass} value={num(r.quantity)} onChange={(v) => updR(i, 'quantity', v)} />
                    </Field>
                    <Field label="賞味期限">
                      <input type="date" className={inputClass} value={r.expiry ?? ''} onChange={(e) => updR(i, 'expiry', e.target.value)} />
                    </Field>
                    <Field label="原価（1袋）">
                      <div className="flex items-center gap-1">
                        <div className={`${inputClass} bg-gray-50 text-right text-gray-700`}>¥{totalCost.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                        <button onClick={() => setOpenCostParts(openCostParts === i ? null : i)}
                          title="仕入先ごとの内訳を見る・その他費用を入力する"
                          className={`shrink-0 rounded p-1.5 text-xs ${openCostParts === i || hasParts || otherCost > 0 ? 'bg-teal-50 text-teal-700' : 'text-gray-400 hover:bg-gray-100'}`}>
                          内訳
                        </button>
                      </div>
                    </Field>
                    <div className="flex items-end pb-2">
                      <label className="flex items-center gap-1.5 text-xs text-gray-700">
                        <input type="checkbox" className="rounded border-gray-300 text-teal-600"
                          checked={r.applied !== false} onChange={(e) => updR(i, 'applied', e.target.checked)} />
                        在庫へ反映
                      </label>
                    </div>
                  </div>

                  {openCostParts === i && (
                    <div className="mt-2 rounded-lg bg-gray-50 p-2.5">
                      <p className="mb-1.5 text-xs text-gray-600">
                        「資材」タブに登録した仕入先ごとに、この納品分（{num(r.quantity).toLocaleString()}袋 ÷ 発注全体 {Math.round(orderedBags).toLocaleString()}袋）で自動按分しています。累計ではなく、この納品1回分だけの金額です。
                        資材の単価が未入力の仕入先は、ここで直接金額を入力できます。
                      </p>
                      {hasParts ? (
                        <ul className="mb-2 space-y-1">
                          {[...parts.entries()].map(([supplier, auto]) => (
                            <li key={supplier} className="flex items-center justify-between gap-2 text-xs text-gray-700">
                              <span>{supplier}</span>
                              {auto > 0 ? (
                                <span className="font-medium">¥{auto.toLocaleString(undefined, { maximumFractionDigits: 2 })} / 袋</span>
                              ) : (
                                <div className="flex items-center gap-1">
                                  <span className="text-gray-400">単価未設定 →</span>
                                  <div className="relative w-28">
                                    <NumField min={0} step="0.1"
                                      className="w-full rounded-md border border-gray-200 py-1 pl-2 pr-5 text-right text-xs outline-none focus:border-teal-500"
                                      value={r.costParts?.[supplier] ?? ''} placeholder="0"
                                      onChange={(v) => updR(i, 'costParts', { ...(r.costParts ?? {}), [supplier]: v })} allowEmpty />
                                    <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-gray-400">円</span>
                                  </div>
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mb-2 text-xs text-gray-400">この発注には「資材」が登録されていないため、自動計算分はありません。</p>
                      )}
                      <label className="block">
                        <span className="mb-0.5 block text-xs text-gray-500">その他費用（1袋あたり・手入力／原料の本体原価や加工費など、資材で賄えない分）</span>
                        <div className="relative w-40">
                          <NumField min={0} step="0.1"
                            className="w-full rounded-md border border-gray-200 py-1 pl-2 pr-5 text-right text-xs outline-none focus:border-teal-500"
                            value={r.costParts?.other ?? ''} placeholder="0"
                            onChange={(v) => updR(i, 'costParts', { ...(r.costParts ?? {}), other: v })} allowEmpty />
                          <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-gray-400">円</span>
                        </div>
                      </label>
                      <p className="mt-1.5 text-right text-xs font-semibold text-gray-800">合計 ¥{totalCost.toLocaleString(undefined, { maximumFractionDigits: 2 })} / 袋</p>
                    </div>
                  )}

                  <div className="mt-2 border-t border-gray-100 pt-2">
                    <input className={`${inputClass} text-xs`} placeholder="メモ（例: 残り500kgは10月納品）"
                      value={r.note ?? ''} onChange={(e) => updR(i, 'note', e.target.value)} />
                  </div>

                  <div className="mt-2 flex justify-end">
                    <button onClick={() => setForm((p) => ({ ...p, receipts: p.receipts.filter((_, idx) => idx !== i) }))}
                      className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 資材 */}
        <div className="rounded-xl border border-gray-200 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">資材</h3>
              <p className="text-xs text-gray-500">
                この発注で使う資材と価格を登録すると、原価に反映され、資材在庫から自動で差し引かれます。
                「原料」種別の資材は、配合割合から使用量を自動計算します。
              </p>
            </div>
            <button onClick={addMat} disabled={matList.length === 0}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50">
              資材を追加
            </button>
          </div>

          {missingWeight && (
            <p className="mb-2 rounded-lg border-2 border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
              ⚠ 「{product?.name ?? 'この商品'}」には「1袋あたりの重量」が設定されていません（現在 {perBagG}g）。
              商品編集画面でこの商品自体の重量を入れてください。1kgの商品で重量を設定していても、
              800gなど別の規格の商品には反映されません（規格ごとに別々の商品として重量を持っています）。
            </p>
          )}

          {matList.length === 0 ? (
            <p className="rounded-lg bg-gray-50 px-3 py-3 text-xs text-gray-500">
              資材が登録されていません。「資材在庫」タブから先に登録してください。
            </p>
          ) : (form.materials ?? []).length === 0 ? (
            <p className="rounded-lg bg-gray-50 px-3 py-3 text-xs text-gray-500">まだ資材がありません。</p>
          ) : (
            <div className="space-y-2">
              {(form.materials ?? []).map((m, i) => {
                const mat = matList.find((x) => x.id === m.material_id);
                const isBlend = mat?.kind === 'blend';
                const isPerBag = mat?.kind === 'perbag';
                const isAuto = isBlend || isPerBag;
                const qty = lineQty(m);
                const unitCost = priceForQty(mat, qty);
                const orderQty = mat && (num(mat.orderUnit) > 0 || mat.trackStock === false) ? suggestOrderQty(mat, qty) : null;
                return (
                  <div key={m.id} className="rounded-lg border border-gray-200 bg-white p-2">
                    {isBlend && (
                      <div className="mb-1.5 rounded-md bg-gray-50 px-2 py-1 text-[11px] text-gray-500">
                        内訳：発注数 {Math.round(orderedBags).toLocaleString()}袋 × 商品重量 {perBagG.toLocaleString()}g × 配合割合 {num(mat.blendRatio)}%
                        {' '}＝ {(orderedBags * perBagG * (num(mat.blendRatio) / 100)).toLocaleString(undefined, { maximumFractionDigits: 0 })}g
                        （{mat.unit}換算で {qty.toLocaleString()}{mat.unit}）
                        {perBagG <= 0 && <span className="ml-1 font-medium text-amber-600">← 商品重量が0のため使用量も0になっています</span>}
                      </div>
                    )}
                    {isPerBag && (
                      <div className="mb-1.5 rounded-md bg-gray-50 px-2 py-1 text-[11px] text-gray-500">
                        内訳：発注数 {Math.round(orderedBags).toLocaleString()}袋 × 1袋あたり {num(mat.perBagQty).toLocaleString()}{mat.unit}
                        {' '}＝ {qty.toLocaleString()}{mat.unit}
                        {num(mat.perBagQty) <= 0 && <span className="ml-1 font-medium text-amber-600">← 資材の「1袋あたりの使用量」が0のため使用量も0になっています</span>}
                      </div>
                    )}
                    <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-6">
                      <div className="sm:col-span-2">
                        <Field label="資材">
                          <select className={inputClass} value={m.material_id ?? ''} onChange={(e) => updMat(i, 'material_id', e.target.value)}>
                            <option value="">選択してください</option>
                            {matList.map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.name}
                                {x.kind === 'blend' ? `（原料 ${num(x.blendRatio)}%）` : ''}
                                {x.kind === 'perbag' ? `（1袋あたり${num(x.perBagQty)}${x.unit}）` : ''}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      <Field label={`数量${mat ? `（${mat.unit}）` : ''}`}>
                        {isAuto ? (
                          <div className={`${inputClass} bg-gray-50 text-right text-gray-700`}>{qty.toLocaleString()}</div>
                        ) : (
                          <NumField min={0} className={inputClass} value={num(m.qty)} onChange={(v) => updMat(i, 'qty', v)} />
                        )}
                      </Field>
                      <Field label="単価" hint="資材の単価から自動計算されます">
                        <div className={`${inputClass} bg-gray-50 text-right text-gray-700`}>
                          ¥{unitCost.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </div>
                        {mat && (mat.priceTiers ?? []).length > 0 && (
                          <div className="mt-1 text-[11px] text-gray-400">この数量の価格階層を適用</div>
                        )}
                      </Field>
                      <div className="text-xs text-gray-500">
                        小計<br />¥{Math.round(qty * unitCost).toLocaleString()}
                        {mat && mat.trackStock === false && <div className="text-gray-400">在庫管理対象外</div>}
                        {mat && mat.trackStock !== false && <div className="text-gray-400">在庫 {num(mat.stock).toLocaleString()}{mat.unit}</div>}
                        {isBlend && (
                          <div className="text-amber-600">
                            自動計算（{num(mat.blendRatio)}%）
                            <br />1袋あたり ¥{(autoQtyPerBag(mat, perBagG) * unitCost).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </div>
                        )}
                        {isPerBag && (
                          <div className="text-amber-600">
                            自動計算（1袋あたり{num(mat.perBagQty).toLocaleString()}{mat.unit}）
                            <br />1袋あたり ¥{(autoQtyPerBag(mat, perBagG) * unitCost).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </div>
                        )}
                      </div>
                      <div className="flex justify-end">
                        <button onClick={() => rmMat(i)} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                      </div>
                    </div>
                    {orderQty !== null && (
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg bg-teal-50/60 px-2.5 py-1.5 text-xs text-teal-800">
                        <span>必要量 {qty.toLocaleString()}{mat.unit}</span>
                        {mat.trackStock !== false && <span>− 現在庫 {num(mat.stock).toLocaleString()}{mat.unit}</span>}
                        <span className="font-semibold">
                          → 発注目安 {orderQty.toLocaleString()}{mat.unit}
                          {orderQty > 0 && num(mat.orderUnit) > 0 && (
                            num(mat.orderUnitFreeAbove) > 0 && orderQty >= num(mat.orderUnitFreeAbove)
                              ? '（単位縛り解除・必要量そのまま）'
                              : ` （${num(mat.orderUnit).toLocaleString()}${mat.unit}単位で切り上げ）`
                          )}
                          {orderQty > 0 && num(mat.minOrderQty) > 0 && orderQty === num(mat.minOrderQty) && num(mat.minOrderQty) > num(qty) && ' （最低発注量）'}
                        </span>
                        {mat.trackStock === false && <span className="text-teal-600">在庫管理なし（受注生産）</span>}
                        {mat.supplier && <span className="text-teal-600">仕入先: {mat.supplier}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="text-right text-xs font-medium text-gray-700">
                資材原価 合計：¥{Math.round(materialCostTotal).toLocaleString()}
              </div>

              {supplierGroups.length > 0 && (
                <div className="rounded-xl border border-teal-200 bg-teal-50/40 p-3">
                  <h4 className="mb-2 text-xs font-semibold text-teal-900">簡易発注書（仕入先ごと）</h4>
                  <div className="space-y-2">
                    {supplierGroups.map(([supplier, rows]) => (
                      <div key={supplier} className="rounded-lg bg-white p-2">
                        <div className="text-xs font-semibold text-gray-800">{supplier}</div>
                        <ul className="mt-1 space-y-0.5">
                          {rows.map(({ material, orderQty: q }) => (
                            <li key={material.id} className="flex justify-between text-xs text-gray-600">
                              <span>{material.name}</span>
                              <span className="font-medium text-gray-900">{q.toLocaleString()}{material.unit}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-teal-700">
                    このPO単体での目安です。仕入先が未設定の資材は「仕入先未設定」としてまとめています（資材在庫タブから設定できます）。
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** 納品管理の一覧 */
function DeliveryBoard({ data, onEdit, onNew }) {
  const { purchaseOrders = [], products, specs, categories } = data;
  const [catId, setCatId] = useState('');
  const [statusFilter, setStatusFilter] = useState('open');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState({});

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const catOfProduct = useMemo(() => {
    const specCat = new Map(specs.map((sp) => [sp.id, sp.category_id]));
    return (pid) => specCat.get(productById.get(pid)?.spec_id) ?? null;
  }, [specs, productById]);
  /* ヘルシーに絞り込んで見ているときは、「ラベル張り済み」列自体を出さない（イヌメシだけの概念のため） */
  const selectedCatName = categories.find((c) => c.id === catId)?.name;
  const showLabelCol = !catId || selectedCatName === 'イヌメシ';

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return purchaseOrders.map((po) => {
      const product = productById.get(po.product_id);
      const status = poStatus(po);
      const cat = categories.find((c) => c.id === catOfProduct(po.product_id)) ?? null;
      const received = poReceived(po);
      const remaining = poRemaining(po);
      const isInumeshi = cat?.name === 'イヌメシ';
      const manufacturedQty = (po.manufactureRecords ?? []).reduce((s2, r) => s2 + num(r.quantity), 0);
      const notLabeled = isInumeshi ? Math.max(0, manufacturedQty - received) : 0;
      const notManufactured = isInumeshi ? Math.max(0, poOrderedInBags(po) - manufacturedQty) : remaining;
      return {
        po, product, status,
        ordered: poOrderedInBags(po),
        received, remaining, notLabeled, notManufactured,
        cat,
        lastDate: (po.receipts ?? []).map((r) => r.date).filter(Boolean).sort().pop() ?? '',
      };
    }).filter((r) => {
      if (catId && r.cat?.id !== catId) return false;
      if (statusFilter === 'open' && (r.status === 'done' || r.status === 'completed' || r.status === 'canceled')) return false;
      if (statusFilter !== 'open' && statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (!q) return true;
      return [r.product?.name, r.product?.code, r.po.supplier].some((v) => (v ?? '').toLowerCase().includes(q));
    }).sort((a, b) => (b.po.orderDate ?? '').localeCompare(a.po.orderDate ?? ''));
  }, [purchaseOrders, productById, catOfProduct, categories, catId, statusFilter, query]);

  const filters = [
    { key: 'open', label: '進行中' },
    { key: 'ordered', label: '発注済み' },
    { key: 'partial', label: '一部納品' },
    { key: 'done', label: '納品完了' },
    { key: 'completed', label: '完了（手動）' },
    { key: 'all', label: 'すべて' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1" style={{ minWidth: 240 }}>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            placeholder="商品名・コード・仕入先で検索" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select className="shrink-0 rounded-lg border border-gray-300 py-2 pl-2.5 pr-7 text-sm outline-none focus:border-teal-500"
          style={{ width: 180 }} value={catId} onChange={(e) => setCatId(e.target.value)}>
          <option value="">すべてのカテゴリー</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button onClick={onNew} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700">
          <Plus className="h-4 w-4" />発注を登録
        </button>
      </div>

      <div className="flex flex-wrap gap-1">
        {filters.map((f) => (
          <button key={f.key} onClick={() => setStatusFilter(f.key)}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${statusFilter === f.key ? 'bg-teal-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {f.label}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <ScrollXSynced>
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-20">
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium text-gray-500">
                <th className="px-2 py-3" style={{ width: 32 }}></th>
                <th className="px-3 py-3">状態</th>
                <th className="px-3 py-3">商品</th>
                <th className="px-3 py-3">発注日 / 納品予定</th>
                <th className="px-3 py-3 text-right">発注数</th>
                <th className="px-3 py-3 text-right">納品済み</th>
                {showLabelCol && <th className="px-3 py-3 text-right">未ラベル張り</th>}
                <th className="px-3 py-3 text-right">未製造</th>
                <th className="px-3 py-3">仕入先</th>
                <th className="sticky right-0 top-0 z-30 bg-gray-50 px-3 py-3 text-right shadow-[-4px_0_6px_-2px_rgba(0,0,0,0.08)]">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-12 text-center text-sm text-gray-500">
                  発注がありません。「発注を登録」から追加してください。
                </td></tr>
              )}
              {rows.map(({ po, product, status, ordered, received, notLabeled, notManufactured, cat }) => {
                const open = expanded[po.id];
                const receipts = po.receipts ?? [];
                return (
                  <Fragment key={po.id}>
                    <tr className="hover:bg-gray-50/60">
                      <td className="px-2 py-3">
                        {receipts.length > 0 && (
                          <button onClick={() => setExpanded((v) => ({ ...v, [po.id]: !v[po.id] }))}
                            className="rounded p-0.5 text-gray-400 hover:text-gray-700">
                            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${PO_STATUS[status].tone}`}>
                          {PO_STATUS[status].label}
                        </span>
                        {receipts.length > 1 && <div className="mt-0.5 text-xs text-gray-400">{receipts.length}回に分納</div>}
                      </td>
                      <td className="px-3 py-3">
                        <div className="font-medium text-gray-900">{product?.name ?? '不明な商品'}</div>
                        <div className="text-xs text-gray-400">
                          {product?.code && <span className="mr-1">{product.code}</span>}
                          {cat && <span className="rounded bg-teal-50 px-1 text-teal-700">{cat.name}</span>}
                          {(po.materials ?? []).length > 0 && (
                            <span className="ml-1 rounded bg-amber-50 px-1 text-amber-700">
                              資材 ¥{Math.round(poMaterialCost(po)).toLocaleString()}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-600">
                        <div>{po.orderDate || '—'}</div>
                        <div className="text-gray-400">予定 {po.dueDate || '—'}</div>
                      </td>
                      <td className="px-3 py-3 text-right text-gray-900">
                        {Math.round(ordered).toLocaleString()}
                        {po.unit === 'kg' && (
                          <div className="text-xs text-gray-400">{num(po.orderQty).toLocaleString()}kg</div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right font-medium text-teal-700">
                        {Math.round(received).toLocaleString()}
                      </td>
                      {showLabelCol && (
                        <td className="px-3 py-3 text-right font-medium text-sky-700">
                          {cat?.name === 'イヌメシ' ? Math.round(notLabeled).toLocaleString() : <span className="text-base font-bold text-gray-500">×</span>}
                        </td>
                      )}
                      <td className={`px-3 py-3 text-right font-medium ${notManufactured > 0.5 ? 'text-amber-700' : 'text-gray-300'}`}>
                        {notManufactured > 0.5 ? Math.round(notManufactured).toLocaleString() : '—'}
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-600">{po.supplier || '—'}</td>
                      <td className="sticky right-0 z-10 bg-white px-3 py-3 text-right shadow-[-4px_0_6px_-2px_rgba(0,0,0,0.08)]">
                        <button onClick={() => onEdit(po)}
                          className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50">
                          納品を記録
                        </button>
                      </td>
                    </tr>

                    {open && receipts.map((r) => (
                      <tr key={r.id} className="bg-gray-50/60 text-xs">
                        <td />
                        <td className="px-3 py-2">
                          <span className={`rounded px-1.5 py-0.5 ${r.applied === false ? 'bg-gray-200 text-gray-500' : 'bg-emerald-100 text-emerald-800'}`}>
                            {r.applied === false ? '未反映' : '在庫へ反映'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-gray-600">
                          納品 {r.date || '—'}
                          {r.expiry && <span className="ml-2 text-gray-400">期限 {r.expiry}</span>}
                        </td>
                        <td className="px-3 py-2 text-gray-500">
                          {STAGE_FIELDS.filter((f) => r.stages?.[f.key] !== undefined && r.stages?.[f.key] !== '')
                            .map((f) => `${f.label} ${Number(r.stages[f.key]).toLocaleString()}`).join(' / ') || '—'}
                        </td>
                        <td />
                        <td className="px-3 py-2 text-right text-gray-900">{num(r.quantity).toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-gray-500">
                          {num(r.cost) > 0 ? `¥${num(r.cost).toLocaleString()}` : '—'}
                        </td>
                        <td colSpan={2} className="px-3 py-2 text-gray-500">{r.note || ''}</td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </ScrollXSynced>
        <p className="border-t border-gray-100 bg-gray-50/60 px-4 py-2 text-xs text-gray-500">
          「在庫へ反映」を付けた納品が、賞味期限と原価を持ったロットとして在庫に加わります。
          途中経過（メーカー在庫・協力先在庫・検査ロスなど）は記録だけで、在庫の計算には影響しません。
        </p>
      </div>
    </div>
  );
}

/* ============================================================
   資材在庫
   ============================================================ */

/** 資材1件の追加・編集。在庫数もここで手動調整できる */
function MaterialFormModal({ open, material, materials, onClose, onSave, onDelete }) {
  const [form, setForm] = useState(null);
  const [addingSupplier, setAddingSupplier] = useState(false);
  useEffect(() => {
    if (!open) return;
    setForm(material ? { ...material } : blankMaterial());
    setAddingSupplier(false);
  }, [open, material]);
  if (!open || !form) return null;

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  /* すでに登録済みの資材から、仕入先の候補を集める（イヌメシとヘルシーなど、カテゴリーごとに違っても自然に反映される） */
  const supplierOptions = [...new Set(
    (materials ?? []).map((m) => (m.supplier || '').trim()).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, 'ja'));
  const showTextInput = addingSupplier || (form.supplier && !supplierOptions.includes(form.supplier));

  return (
    <Modal open={open} title={material?.id ? '資材を編集' : '資材を登録'}
      subtitle="発注登録の画面で選べるようになります"
      onClose={onClose}
      footer={<>
        {material?.id && onDelete && (
          <button className="mr-auto rounded-lg border border-red-300 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
            onClick={() => onDelete(material.id)}>この資材を削除</button>
        )}
        <button className={secondaryBtn} onClick={onClose}>キャンセル</button>
        <button className={primaryBtn} disabled={!form.name} onClick={() => onSave(form)}>保存</button>
      </>}>
      <div className="space-y-4">
        <Field label="資材名">
          <input className={inputClass} value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="例: パウチ袋（100g用）、ALBOCEL" />
        </Field>
        <Field label="種別">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {Object.entries(MATERIAL_KINDS).map(([k, v]) => (
              <label key={k}
                className={`cursor-pointer rounded-lg border p-2.5 text-xs transition ${form.kind === k ? 'border-teal-500 bg-teal-50/60' : 'border-gray-200 hover:border-gray-300'}`}>
                <div className="flex items-center gap-1.5 font-medium text-gray-800">
                  <input type="radio" className="text-teal-600" name="material-kind" checked={form.kind === k} onChange={() => set('kind', k)} />
                  {v.label}
                </div>
                <p className="mt-1 text-gray-500">{v.hint}</p>
              </label>
            ))}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="単位">
            <select className={inputClass} value={form.unit ?? '個'} onChange={(e) => set('unit', e.target.value)}>
              {MATERIAL_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </Field>
          <Field label="単価" hint="発注登録時の初期値として使われます">
            <NumField min={0} step="0.1" className={inputClass} value={num(form.cost)} onChange={(v) => set('cost', v)} />
          </Field>
        </div>
        <Field label="仕入先（発注先メーカー）" hint="発注登録画面の「簡易発注書」や「資材発注書（全体）」で、この仕入先ごとにまとめて表示されます">
          {showTextInput ? (
            <div className="flex gap-2">
              <input className={inputClass} value={form.supplier ?? ''} onChange={(e) => set('supplier', e.target.value)}
                placeholder="例: 北の森自然工房" autoFocus />
              {supplierOptions.length > 0 && (
                <button type="button" onClick={() => { setAddingSupplier(false); set('supplier', supplierOptions[0]); }}
                  className="shrink-0 rounded-lg border border-gray-300 px-2.5 text-xs text-gray-600 hover:bg-gray-50">
                  一覧から選ぶ
                </button>
              )}
            </div>
          ) : (
            <select className={inputClass} value={form.supplier ?? ''}
              onChange={(e) => {
                if (e.target.value === '__new__') { setAddingSupplier(true); set('supplier', ''); }
                else set('supplier', e.target.value);
              }}>
              <option value="">未設定</option>
              {supplierOptions.map((s) => <option key={s} value={s}>{s}</option>)}
              <option value="__new__">＋ 新しい仕入先を入力…</option>
            </select>
          )}
        </Field>
        {form.kind === 'blend' && (
          <Field label="配合割合 (%)" hint="例: ALBOCELは2.5%。商品本体の中身そのものを資材として計上したい場合は100%にすると、発注数×商品の重量がそのまま使用量になります。発注登録の画面で「商品の重量 × この割合」から使用量を自動計算します（単位は上のkg/gに合わせて換算されます）">
            <NumField min={0} step="0.01" className={inputClass} value={num(form.blendRatio)} onChange={(v) => set('blendRatio', v)} />
          </Field>
        )}
        {form.kind === 'perbag' && (
          <Field label="1袋あたりの使用量" hint={`例: パウチ袋なら1袋につき1${form.unit || '個'}。発注登録の画面で「発注数 × この数」から使用量を自動計算します。`}>
            <div className="flex items-center gap-2">
              <NumField min={0} step="0.01" className={inputClass} style={{ flex: '1 1 auto', minWidth: 0 }}
                value={num(form.perBagQty)} onChange={(v) => set('perBagQty', v)} />
              <span className="shrink-0 text-xs text-gray-400">{form.unit || ''} / 袋</span>
            </div>
          </Field>
        )}
        <div className="rounded-xl border border-gray-200 p-3">
          <div className="mb-2 text-xs font-semibold text-gray-700">発注ルール（数量の制約）</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="最低発注量" hint="これを下回る量は発注できない場合に入力します。空欄・0なら制限なしです。">
              <div className="flex items-center gap-2">
                <NumField min={0} step="0.01" className={inputClass} style={{ flex: '1 1 auto', minWidth: 0 }}
                  value={num(form.minOrderQty)} onChange={(v) => set('minOrderQty', v)} />
                <span className="shrink-0 text-xs text-gray-400">{form.unit || ''}</span>
              </div>
            </Field>
            <Field label="発注単位" hint="この数量の倍数でしか発注できない場合に入力します（例: 140kg単位）。空欄・0なら制限なしです。">
              <div className="flex items-center gap-2">
                <NumField min={0} step="0.01" className={inputClass} style={{ flex: '1 1 auto', minWidth: 0 }}
                  value={num(form.orderUnit)} onChange={(v) => set('orderUnit', v)} />
                <span className="shrink-0 text-xs text-gray-400">{form.unit || ''} 単位</span>
              </div>
            </Field>
          </div>
          {num(form.orderUnit) > 0 && (
            <Field label="単位縛りが外れる数量" hint={`必要量がこの数量以上になったら、上の発注単位の縛りをやめて必要量そのままにします。例: 「発注単位140kg・ここを1000kg」にすると、999kgまでは140kg刻み、1,000kg以上は自由な数量で発注できます。空欄・0なら常に発注単位の縛りが適用されます。`}>
              <div className="mt-3 flex items-center gap-2">
                <NumField min={0} step="1" className={inputClass} style={{ flex: '1 1 auto', minWidth: 0 }}
                  value={num(form.orderUnitFreeAbove)} onChange={(v) => set('orderUnitFreeAbove', v)} />
                <span className="shrink-0 text-xs text-gray-400">{form.unit || ''} 以上で解除</span>
              </div>
            </Field>
          )}
        </div>

        <div className="rounded-xl border border-gray-200 p-3">
          <div className="mb-1 flex items-center justify-between">
            <div className="text-xs font-semibold text-gray-700">数量帯ごとの単価（スケールメリット）</div>
            <button type="button"
              onClick={() => set('priceTiers', [...(form.priceTiers ?? []), { id: uid(), minQty: 0, price: num(form.cost) }])}
              className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50">
              階層を追加
            </button>
          </div>
          <p className="mb-2 text-xs text-gray-500">
            発注数量に応じて単価が変わる場合に設定します（例: 300{form.unit}以上でkg単価が下がる、など）。
            上の「単価」は基本単価として扱い、ここで登録した最低数量に達するたびに単価が切り替わります。
          </p>
          {(form.priceTiers ?? []).length === 0 ? (
            <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-400">階層はまだありません（常に基本単価が使われます）。</p>
          ) : (
            <div className="space-y-2">
              {[...(form.priceTiers ?? [])].sort((a, b) => num(a.minQty) - num(b.minQty)).map((t) => {
                const i = (form.priceTiers ?? []).findIndex((x) => x.id === t.id);
                return (
                  <div key={t.id}>
                    <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-5">
                      <Field label={`最低数量（${form.unit || ''}）`}>
                        <NumField min={0} className={inputClass}
                          value={num(t.minQty)}
                          onChange={(v) => set('priceTiers', (form.priceTiers ?? []).map((x, xi) => (xi === i ? { ...x, minQty: v } : x)))} />
                      </Field>
                      <Field label="単価">
                        <NumField min={0} step="0.1" className={inputClass}
                          value={num(t.price)}
                          onChange={(v) => set('priceTiers', (form.priceTiers ?? []).map((x, xi) => (xi === i ? { ...x, price: v } : x)))} />
                      </Field>
                      <button type="button"
                        onClick={() => set('priceTiers', (form.priceTiers ?? []).filter((x) => x.id !== t.id))}
                        className="mb-0.5 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                    </div>
                    {num(t.price) <= 0 && (
                      <p className="mt-0.5 text-[11px] text-amber-600">⚠ 単価が未入力のため、この階層は無視され、基本単価（または下の階層）が使われます。</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <Field label="在庫の管理" hint="完全受注生産で在庫を持たない資材・原料（例: 商品本体の中身そのもの）は、オフにしてください。発注のたびに在庫が増減しなくなり、発注目安も在庫を差し引かず必要量そのものになります。">
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
            <input type="checkbox" className="text-teal-600" checked={form.trackStock !== false}
              onChange={(e) => set('trackStock', e.target.checked)} />
            {form.trackStock !== false ? '在庫を管理する（発注のたびに自動で増減）' : '在庫は管理しない（完全受注生産・常に0扱い）'}
          </label>
        </Field>
        {form.trackStock !== false ? (
          <Field label="在庫" hint="発注に資材を使うと自動で減ります。0未満にはなりません。棚卸などで数量を直接直したいときはここを書き換えてください">
            <NumField min={0} className={inputClass} value={num(form.stock)} onChange={(v) => set('stock', Math.max(0, v))} />
          </Field>
        ) : (
          <Field label="在庫" hint="「在庫の管理」がオフのため、常に在庫0・発注のたびの増減なしとして扱われます">
            <div className={`${inputClass} bg-gray-50 text-gray-400`}>対象外（常に0）</div>
          </Field>
        )}
        <Field label="メモ">
          <input className={inputClass} value={form.note ?? ''} onChange={(e) => set('note', e.target.value)} placeholder="仕入先や規格などの任意メモ" />
        </Field>
      </div>
    </Modal>
  );
}

/** 資材在庫の一覧タブ */
/** 資材の納品確定。実際に届いた数量を確認してから在庫に加算する */
function MaterialReceiveModal({ open, material, suggestedQty, onClose, onConfirm }) {
  const [qty, setQty] = useState(0);
  useEffect(() => { if (open) setQty(suggestedQty ?? 0); }, [open, suggestedQty]);
  if (!open || !material) return null;
  return (
    <Modal open={open} title="納品確定" subtitle={material.name} onClose={onClose}
      footer={<>
        <button className={secondaryBtn} onClick={onClose}>キャンセル</button>
        <button className={primaryBtn} onClick={() => onConfirm(material.id, qty)}>納品確定・在庫に追加する</button>
      </>}>
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          実際に届いた数量を入力してください。「納品確定」を押すと、その分だけ在庫が増えます。
        </p>
        <Field label={`納品数量（${material.unit}）`}>
          <NumField min={0} className={inputClass} value={num(qty)} onChange={setQty} />
        </Field>
        <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">
          現在庫 {num(material.stock).toLocaleString()}{material.unit} → 確定後は {(num(material.stock) + num(qty)).toLocaleString()}{material.unit} になります。
        </p>
      </div>
    </Modal>
  );
}

function MaterialsBoard({ materials, purchaseOrders, onAdd, onEdit, onDelete, onQuickStock, onReceiveMaterial }) {
  const [query, setQuery] = useState('');
  const [periodFilter, setPeriodFilter] = useState('all');
  const [receiveTarget, setReceiveTarget] = useState(null);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q ? materials.filter((m) => m.name.toLowerCase().includes(q)) : materials;
    return [...rows].sort((a, b) => a.name.localeCompare(b.name));
  }, [materials, query]);

  /* 発注書の時期（納品予定日、なければ発注日）でグルーピングし、選べるようにする */
  const periods = useMemo(() => {
    const set = new Set();
    (purchaseOrders ?? []).forEach((po) => {
      const ym = (po.dueDate || po.orderDate || '').slice(0, 7);
      if (ym) set.add(ym);
    });
    return [...set].sort();
  }, [purchaseOrders]);
  const periodLabel = (ym) => {
    const [y, mo] = ym.split('-');
    return `${y}年${Number(mo)}月`;
  };
  const filteredPOs = useMemo(() => {
    if (periodFilter === 'all') return purchaseOrders ?? [];
    return (purchaseOrders ?? []).filter((po) => (po.dueDate || po.orderDate || '').slice(0, 7) === periodFilter);
  }, [purchaseOrders, periodFilter]);

  const supplierGroups = useMemo(
    () => buildMaterialPurchaseOrder(materials, filteredPOs, { includeFulfilled: periodFilter !== 'all' }),
    [materials, filteredPOs, periodFilter]
  );
  const supplierCount = supplierGroups.length;
  const combinedCount = supplierGroups.filter(([, rows]) => rows.some((row) => row.poCount > 1)).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <input className={`${inputClass} pl-8`} placeholder="資材名で検索" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button onClick={onAdd} className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700">
          <Plus className="h-4 w-4" />資材を追加
        </button>
      </div>

      {(supplierGroups.length > 0 || periods.length > 0) && (
        <div className="rounded-2xl border border-teal-200 bg-teal-50/40 p-4">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-teal-900">資材発注書（全体）</h3>
            <div className="flex items-center gap-2">
              {periods.length > 0 && (
                <select value={periodFilter} onChange={(e) => setPeriodFilter(e.target.value)}
                  className="rounded-md border border-teal-200 bg-white px-2 py-1 text-xs text-teal-800 outline-none focus:border-teal-500">
                  <option value="all">すべての時期</option>
                  {periods.map((ym) => <option key={ym} value={ym}>{periodLabel(ym)}分の発注書</option>)}
                </select>
              )}
              <span className="text-xs text-teal-700">仕入先 {supplierCount}件{combinedCount > 0 && ` ／ うち複数商品分をまとめて計算 ${combinedCount}件`}</span>
            </div>
          </div>
          <p className="mb-3 text-xs text-teal-700">
            {periodFilter === 'all'
              ? '既定では、まだ発注が必要なもの（在庫で足りていないもの）だけを表示しています。納品完了・取消の発注書、在庫で足りている資材は表示されません。'
              : `${periodLabel(periodFilter)}が納品予定日（未入力の発注書は発注日）の発注書を、完了済みも含めてそのまま集計しています。すでに在庫で満たされているものも「手配済み」として残します。`}
            同じ原料を複数の商品で使っている場合は、ここで合計してから発注単位に切り上げています。
          </p>
          {supplierGroups.length === 0 ? (
            <p className="rounded-lg bg-white px-3 py-3 text-xs text-gray-500">
              {periodFilter === 'all' ? '今、発注が必要な資材はありません。' : 'この時期の発注書には資材が登録されていません。'}
            </p>
          ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {supplierGroups.map(([supplier, rows]) => (
              <div key={supplier} className="rounded-xl border border-gray-200 bg-white p-3">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-sm font-semibold text-gray-900">{supplier}</span>
                  <span className="text-xs text-gray-500">概算 ¥{Math.round(rows.reduce((s2, r) => s2 + r.estCost, 0)).toLocaleString()}</span>
                </div>
                <ul className="space-y-1.5">
                  {rows.map((row) => (
                    <li key={row.material.id} className="text-xs text-gray-600">
                      <div className="flex items-center justify-between gap-2">
                        <span>{row.material.name}</span>
                        <div className="flex items-center gap-1.5">
                          {row.fulfilled ? (
                            <>
                              <span className="font-semibold text-gray-900">{row.usage.toLocaleString()}{row.material.unit}</span>
                              <span className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-500">手配済み</span>
                            </>
                          ) : (
                            <>
                              <span className="font-semibold text-gray-900">{row.orderQty.toLocaleString()}{row.material.unit}</span>
                              <button onClick={() => setReceiveTarget({ material: row.material, suggestedQty: row.orderQty })}
                                className="rounded-md border border-teal-300 bg-teal-50 px-1.5 py-0.5 text-[11px] font-medium text-teal-700 hover:bg-teal-100">
                                納品確定
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="text-[11px] text-gray-400">
                        {row.fulfilled ? '発注した数量（最初の必要量）' : '最初の必要量'} {row.usage.toLocaleString()}{row.material.unit}
                        {!row.fulfilled && row.orderQty !== row.usage && <span className="ml-1">・今の発注目安 {row.orderQty.toLocaleString()}{row.material.unit}</span>}
                        {row.poCount > 1 && <span className="ml-1 text-amber-600">（発注書{row.poCount}件分を合算）</span>}
                        {num(row.material.orderUnit) > 0 && <span className="ml-1">・{num(row.material.orderUnit).toLocaleString()}{row.material.unit}単位</span>}
                        {row.material.trackStock === false && <span className="ml-1">・在庫管理なし</span>}
                      </div>
                      <div className="text-[11px] text-gray-400">
                        目安単価 ¥{row.price.toLocaleString()}{(row.material.priceTiers ?? []).length > 0 && <span className="ml-1 text-amber-600">（この数量の階層適用）</span>} ・ 概算 ¥{Math.round(row.estCost).toLocaleString()}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          )}
        </div>
      )}

      <MaterialReceiveModal open={!!receiveTarget} material={receiveTarget?.material} suggestedQty={receiveTarget?.suggestedQty}
        onClose={() => setReceiveTarget(null)}
        onConfirm={(id, qty) => { onReceiveMaterial(id, qty); setReceiveTarget(null); }} />

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        {materials.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <PackageOpen className="h-8 w-8 text-gray-300" />
            <p className="text-sm text-gray-500">まだ資材が登録されていません。</p>
            <p className="text-xs text-gray-400">パウチ袋やラベルなど、発注に使う資材をここで管理します。</p>
          </div>
        ) : list.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-gray-500">条件に一致する資材がありません。</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">資材名</th>
                <th className="px-3 py-2 text-left font-medium">種別</th>
                <th className="px-3 py-2 text-left font-medium">仕入先</th>
                <th className="px-3 py-2 text-left font-medium">単位</th>
                <th className="px-3 py-2 text-right font-medium">単価</th>
                <th className="px-3 py-2 text-right font-medium">発注単位</th>
                <th className="px-3 py-2 text-right font-medium">在庫</th>
                <th className="px-3 py-2 text-left font-medium">メモ</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {list.map((m) => (
                <tr key={m.id} className="hover:bg-gray-50/60">
                  <td className="px-4 py-2 font-medium text-gray-900">{m.name}</td>
                  <td className="px-3 py-2">
                    {m.kind === 'blend' ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
                        原料 {num(m.blendRatio)}%
                      </span>
                    ) : m.kind === 'perbag' ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-sky-50 px-1.5 py-0.5 text-xs text-sky-700">
                        1袋{num(m.perBagQty)}{m.unit}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">資材</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{m.supplier || <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2 text-gray-500">{m.unit}</td>
                  <td className="px-3 py-2 text-right text-gray-700">¥{num(m.cost).toLocaleString()}</td>
                  <td className="px-3 py-2 text-right text-gray-500">
                    {num(m.orderUnit) > 0 ? (
                      <>
                        {num(m.orderUnit).toLocaleString()}{m.unit}単位
                        {num(m.orderUnitFreeAbove) > 0 && <div className="text-[11px] text-gray-400">{num(m.orderUnitFreeAbove).toLocaleString()}{m.unit}以上で解除</div>}
                      </>
                    ) : num(m.minOrderQty) > 0 ? (
                      `最低${num(m.minOrderQty).toLocaleString()}${m.unit}`
                    ) : '—'}
                    {(m.priceTiers ?? []).length > 0 && <div className="text-[11px] text-amber-600">価格階層 {m.priceTiers.length}件</div>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {m.trackStock === false ? (
                      <span className="text-xs text-gray-400">対象外（受注生産）</span>
                    ) : (
                      <div className="flex items-center justify-end gap-1.5">
                        <span className={`font-semibold ${num(m.stock) <= 0 ? 'text-red-600' : 'text-gray-900'}`}>
                          {num(m.stock).toLocaleString()}
                        </span>
                        <div className="flex items-center overflow-hidden rounded-md border border-gray-200">
                          <button title="在庫を1減らす" onClick={() => onQuickStock(m.id, -1)}
                            className="px-1.5 py-0.5 text-gray-500 hover:bg-gray-100">−</button>
                          <button title="在庫を1増やす" onClick={() => onQuickStock(m.id, 1)}
                            className="border-l border-gray-200 px-1.5 py-0.5 text-gray-500 hover:bg-gray-100">＋</button>
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-500">{m.note || ''}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => onEdit(m)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-teal-600"><Pencil className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-xs text-gray-500">
        「資材」は発注登録のたびに数量を直接入力します。「原料」は配合割合(%)を登録しておくと、発注登録の画面で商品の重量から使用量が自動計算されます。
        どちらも、発注に使われた分だけここでの在庫から自動で差し引かれます。棚卸などで数を直接直したいときは、行の＋／−ボタンか「編集」から数量を書き換えてください。
      </p>
    </div>
  );
}

/* ============================================================
   発注アラート
   ============================================================ */

/** 発注計画を入荷予定として登録する前の確認画面 */
function ApplyOrdersModal({ open, target, months, onClose, onConfirm }) {
  const [shelfMonths, setShelfMonths] = useState(12);
  const [lines, setLines] = useState([]);

  useEffect(() => {
    if (!open || !target) return;
    setLines(target.orders.map((o) => ({
      id: uid(), ym: o.arrive.key, quantity: o.qty,
      expiry: iso(new Date(o.arrive.year, o.arrive.month - 1 + 12, 0)),
    })));
  }, [open, target]);

  if (!target) return null;
  const already = (target.product.incoming ?? []).filter((x) => x.source === 'plan').length;
  const manual = (target.product.incoming ?? []).filter((x) => x.source !== 'plan' && x.source !== 'po' && x.source !== 'po-pending').length;

  /* 着荷月の選択肢は、2年分の全期間ではなく、実際に不足した月だけに絞る */
  const shortageMonths = [...new Map(target.orders.map((o) => [o.arrive.key, o.arrive])).values()]
    .sort((a, b) => a.index - b.index);

  const applyShelf = (v) => {
    setShelfMonths(v);
    setLines((prev) => prev.map((l) => {
      const mo = months.find((x) => x.key === l.ym);
      if (!mo) return l;
      return { ...l, expiry: iso(new Date(mo.year, mo.month - 1 + v, 0)) };
    }));
  };

  const upd = (i, k, v) => setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, [k]: v } : l)));
  const total = lines.reduce((s, l) => s + num(l.quantity), 0);

  return (
    <Modal open={open} title="発注計画を入荷予定として登録"
      subtitle={target.product.name} onClose={onClose} size="lg"
      footer={<>
        <button className={secondaryBtn} onClick={onClose}>キャンセル</button>
        <button className={primaryBtn} onClick={() => onConfirm(target.product.id, lines)}>
          {lines.length} 件を登録
        </button>
      </>}>
      <div className="space-y-4">
        <div className="rounded-xl border border-teal-200 bg-teal-50/60 p-3 text-xs text-gray-700">
          <p className="mb-1 font-medium text-gray-900">登録すると、次の3か所に反映されます</p>
          <ul className="space-y-0.5 text-gray-600">
            <li>・シミュレーションの「納品予定」の行に、その月の入荷として出ます</li>
            <li>・同じ月から在庫数が増え、以降の在庫推移が変わります</li>
            <li>・在庫一覧のトラックアイコン（入荷登録）から、あとで修正・削除できます</li>
          </ul>
          <p className="mt-2 text-gray-500">
            発注そのものを取引先へ送るわけではありません。あくまで「この月にこれだけ入ってくる予定」という試算上の登録です。
          </p>
        </div>

        {already > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
            この商品には発注計画から登録した入荷予定が {already} 件あります。登録するとそれらは新しい内容に置き換わります。
            {manual > 0 && `手で登録した ${manual} 件はそのまま残ります。`}
          </div>
        )}

        <Field label="賞味期間（着荷月から何ヶ月）" hint="入荷するロットの賞味期限を自動で入れます。行ごとに直せます">
          <select className={inputClass} value={shelfMonths} onChange={(e) => applyShelf(Number(e.target.value))}>
            {[3, 6, 9, 12, 18, 24].map((v) => <option key={v} value={v}>{v}ヶ月</option>)}
          </select>
        </Field>

        <div className="overflow-hidden rounded-xl border border-gray-200">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-200 bg-gray-50 text-xs font-medium text-gray-500">
              <th className="px-3 py-2 text-left">着荷月</th><th className="px-3 py-2 text-left">賞味期限</th>
              <th className="px-3 py-2 text-right">数量</th><th className="px-3 py-2"></th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {lines.map((l, i) => (
                <tr key={l.id}>
                  <td className="px-3 py-2">
                    <select className="rounded-md border border-gray-200 px-2 py-1 text-sm outline-none focus:border-teal-500"
                      value={l.ym} onChange={(e) => upd(i, 'ym', e.target.value)}>
                      {shortageMonths.map((mo) => <option key={mo.key} value={mo.key}>{mo.full}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input type="date" className="rounded-md border border-gray-200 px-2 py-1 text-sm outline-none focus:border-teal-500"
                      value={l.expiry ?? ''} onChange={(e) => upd(i, 'expiry', e.target.value)} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <NumField min={0} className="w-28 rounded-md border border-gray-200 px-2 py-1 text-right text-sm outline-none focus:border-teal-500"
                      value={num(l.quantity)} onChange={(v) => upd(i, 'quantity', v)} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                      className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="border-t border-gray-200 bg-gray-50 text-xs">
              <td className="px-3 py-2 font-medium text-gray-600" colSpan={2}>合計</td>
              <td className="px-3 py-2 text-right font-semibold text-gray-900">{total.toLocaleString()}</td><td />
            </tr></tfoot>
          </table>
        </div>
      </div>
    </Modal>
  );
}

function OrderAlerts({ data, onEdit, onApply }) {
  const [coverMonths, setCoverMonths] = useState(3);
  const [roundTo, setRoundTo] = useState(100);
  const [minQty, setMinQty] = useState(0);
  const [onlyUrgent, setOnlyUrgent] = useState(false);
  const [edits, setEdits] = useState({});   // 手で直した発注数・発注月
  const [applyTarget, setApplyTarget] = useState(null);

  const months = useMemo(() => buildMonths(data.startYM, data.months ?? HORIZON), [data.startYM, data.months]);
  const calc = useMemo(() => compute(data, months), [data, months]);

  /* 今月と基準月のうち、遅いほうを発注計画の起点にする */
  const startIdx = useMemo(() => {
    const today = new Date();
    const curKey = ymKey(today.getFullYear(), today.getMonth() + 1);
    const curIdx = months.findIndex((mo) => mo.key === curKey);
    return Math.max(calc.baseIndex, curIdx >= 0 ? curIdx : 0);
  }, [months, calc.baseIndex]);

  const specName = useMemo(() => {
    const m = new Map();
    data.specs.forEach((sp) => {
      const c = data.categories.find((x) => x.id === sp.category_id);
      m.set(sp.id, `${c?.name ?? '?'} / ${sp.name}`);
    });
    return (id) => m.get(id) ?? '未設定';
  }, [data.specs, data.categories]);

  /* 安全在庫の対象期間のラベル（例: 2026/5〜2026/7） */
  const safetyLabel = useMemo(() => {
    const from = Math.max(0, calc.safetyEndIdx - calc.safetyMonths + 1);
    const a = months[from], b = months[calc.safetyEndIdx];
    return a && b ? (a.key === b.key ? a.full : `${a.full}〜${b.full}`) : '';
  }, [calc.safetyEndIdx, calc.safetyMonths, months]);

  const plans = useMemo(() => {
    const list = [];
    calc.productResults.forEach((r) => {
      const stockOv = (key) => calc.getOv('stock', r.product.id, key);
      const plan = planOrders(r.rows, r.product, { coverMonths, roundTo, minQty, baseIndex: calc.baseIndex, startIdx, stockOv, safety: r.safety });
      if (plan.orders.length === 0) return;

      /* 発注計画は「次回」「次々回」の2件だけを見る。3件目以降（先の見込み）は出さない */
      const orders = plan.orders.slice(0, 2).map((o, i) => {
        const e = edits[`${r.product.id}|${i}`] ?? {};
        const arriveIdx = e.arriveIdx ?? o.arriveIdx;
        return {
          ...o,
          qty: e.qty ?? o.qty,
          arriveIdx,
          arrive: months[arriveIdx] ?? o.arrive,
          edited: e.qty !== undefined || e.arriveIdx !== undefined,
        };
      });

      const first = orders[0];
      const deadline = iso(new Date(new Date(first.arrive.year, first.arrive.month - 1, 1).getTime() - num(r.product.lead_time_days) * DAY));
      list.push({
        product: r.product, spec: specName(r.product.spec_id),
        stock: (calc.lotsByProduct.get(r.product.id) ?? []).reduce((s, l) => s + num(l.quantity), 0),
        orders, ltMonths: plan.ltMonths, first, deadline,
        daysLeft: daysBetween(todayIso(), deadline),
        totalQty: orders.reduce((s, o) => s + o.qty, 0),
        zeroIso: r.zeroIso, safetyIso: r.safetyIso, safety: r.safety,
        safetyDetail: (() => {
          if (calc.safetyMode !== 'avg') return '商品ごとの固定値';
          const from = Math.max(0, calc.safetyEndIdx - calc.safetyMonths + 1);
          const parts = [];
          for (let i = from; i <= calc.safetyEndIdx; i++) {
            parts.push(`${months[i]?.full ?? ''} ${Math.round(r.streams.reduce((sum, st) => sum + (st.demand[i] ?? 0), 0)).toLocaleString()}`);
          }
          return `${parts.join(' / ')} の平均`;
        })(),
        registered: (r.product.incoming ?? []).length,
        hasMore: plan.orders.length > 2,
      });
    });
    return list.sort((x, y) => x.daysLeft - y.daysLeft);
  }, [calc, coverMonths, roundTo, minQty, startIdx, specName, edits, months]);

  const shown = onlyUrgent ? plans.filter((x) => x.daysLeft <= 60) : plans;
  const urgent = plans.filter((x) => x.daysLeft <= 30).length;
  const late = plans.filter((x) => x.first.late).length;
  const editCount = Object.keys(edits).length;

  const setEdit = (pid, i, field, value) =>
    setEdits((prev) => {
      const key = `${pid}|${i}`;
      const cur = { ...(prev[key] ?? {}) };
      if (value === '' || value === null) delete cur[field];
      else cur[field] = Number(value);
      const next = { ...prev };
      if (Object.keys(cur).length === 0) delete next[key];
      else next[key] = cur;
      return next;
    });

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-900">発注の条件</h2>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-gray-500">発注は {months[startIdx]?.full} 以降で計画します</span>
            <span className={`rounded-lg px-2 py-1 ${calc.safetyMode === 'avg' ? 'bg-teal-50 text-teal-700' : 'bg-gray-100 text-gray-600'}`}>
              安全在庫: {calc.safetyMode === 'avg' ? `${safetyLabel} の平均出荷数` : '商品ごとの固定値'}
            </span>
            {editCount > 0 && (
              <>
                <span className="rounded-lg bg-violet-50 px-2 py-1 text-violet-700">手直し {editCount} 件</span>
                <button onClick={() => setEdits({})} className="rounded-lg border border-gray-300 px-2 py-1 font-medium text-gray-600 hover:bg-gray-50">手直しを戻す</button>
              </>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="1回でカバーする月数">
            <select className={inputClass} value={coverMonths} onChange={(e) => setCoverMonths(Number(e.target.value))}>
              {[1, 2, 3, 4, 6, 12].map((m) => <option key={m} value={m}>{m}ヶ月分</option>)}
            </select>
          </Field>
          <Field label="発注単位">
            <select className={inputClass} value={roundTo} onChange={(e) => setRoundTo(Number(e.target.value))}>
              {[1, 10, 50, 100, 500, 1000].map((m) => <option key={m} value={m}>{m} 袋単位</option>)}
            </select>
          </Field>
          <Field label="最小発注数">
            <NumField min={0} className={inputClass} value={minQty} onChange={(v) => setMinQty(v)} />
          </Field>
          <div className="flex items-end">
            <label className="flex items-center gap-2 pb-2 text-sm text-gray-700">
              <input type="checkbox" className="rounded border-gray-300 text-teal-600" checked={onlyUrgent} onChange={(e) => setOnlyUrgent(e.target.checked)} />
              60日以内のみ表示
            </label>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="mb-1 text-xs text-gray-500">発注が必要な商品</div>
          <div className="text-xl font-bold text-gray-900">{plans.length} <span className="text-xs font-normal text-gray-400">件</span></div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-gray-500">
            <AlertTriangle className={`h-4 w-4 ${urgent > 0 ? 'text-red-500' : 'text-teal-600'}`} />30日以内に発注
          </div>
          <div className={`text-xl font-bold ${urgent > 0 ? 'text-red-600' : 'text-gray-900'}`}>{urgent} <span className="text-xs font-normal text-gray-400">件</span></div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="mb-1 text-xs text-gray-500">リードタイムが間に合わない商品</div>
          <div className={`text-xl font-bold ${late > 0 ? 'text-red-600' : 'text-gray-900'}`}>{late} <span className="text-xs font-normal text-gray-400">件</span></div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <ScrollXSynced>
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-20">
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium text-gray-500">
                <th className="px-3 py-3">状態</th>
                <th className="px-3 py-3">商品</th>
                <th className="px-3 py-3 text-right">現在庫</th>
                <th className="px-3 py-3 text-right">安全在庫</th>
                <th className="px-3 py-3">在庫が尽きる日</th>
                <th className="px-3 py-3">発注計画（数量・着荷月を直せます）</th>
                <th className="px-3 py-3 text-right">合計</th>
                <th className="sticky right-0 top-0 z-30 bg-gray-50 px-3 py-3 shadow-[-4px_0_6px_-2px_rgba(0,0,0,0.08)]"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {shown.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-sm text-gray-500">発注が必要な商品はありません。</td></tr>
              )}
              {shown.map((a) => (
                <tr key={a.product.id} className="align-top hover:bg-gray-50/60">
                  <td className="px-3 py-3">
                    <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${
                      a.first.late || a.daysLeft <= 0 ? 'bg-red-100 text-red-800'
                        : a.daysLeft <= 30 ? 'bg-red-50 text-red-700'
                          : a.daysLeft <= 60 ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-600'}`}>
                      {a.first.late ? '間に合わない' : a.daysLeft <= 30 ? '急ぎ' : a.daysLeft <= 60 ? '準備' : '余裕あり'}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <div className="font-medium text-gray-900">{a.product.name}</div>
                    <div className="text-xs text-gray-400">{a.spec}</div>
                    <div className="text-xs text-gray-400">
                      L/T {num(a.product.lead_time_days)}日（約{a.ltMonths}ヶ月）
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right text-gray-900">{a.stock.toLocaleString()}</td>
                  <td className="px-3 py-3 text-right">
                    <div className={`font-medium ${a.stock <= a.safety ? 'text-amber-700' : 'text-gray-900'}`}>
                      {num(a.safety).toLocaleString()}
                    </div>
                    {calc.safetyMode === 'avg' ? (
                      <div className="text-xs text-teal-600" title={a.safetyDetail}>
                        {safetyLabel} の平均
                      </div>
                    ) : <div className="text-xs text-gray-400">固定値</div>}
                  </td>
                  <td className="px-3 py-3">
                    {a.zeroIso ? (
                      <>
                        <div className="font-medium text-red-600">{fmtJp(a.zeroIso)}</div>
                        <div className="text-xs text-gray-500">
                          あと {Math.max(0, daysBetween(todayIso(), a.zeroIso))} 日
                        </div>
                      </>
                    ) : <span className="text-xs text-gray-400">期間中は尽きません</span>}
                    {a.safetyIso && (
                      <div className="mt-0.5 text-xs text-amber-600">安全在庫割れ {fmtJp(a.safetyIso)}</div>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <div className="space-y-1.5">
                      {a.orders.map((o, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="w-10 shrink-0 text-gray-400">{i === 0 ? '次回' : '次々回'}</span>
                          <span className={`rounded px-1.5 py-0.5 font-medium ${o.late ? 'bg-red-50 text-red-700' : 'bg-teal-50 text-teal-700'}`}>
                            {o.order.full} 発注
                          </span>
                          <span className="text-gray-400">→</span>
                          <select
                            className={`rounded-md border px-1.5 py-0.5 text-xs outline-none focus:border-teal-500 ${o.edited ? 'border-violet-300 bg-violet-50' : 'border-gray-200'}`}
                            value={o.arriveIdx}
                            onChange={(e) => setEdit(a.product.id, i, 'arriveIdx', e.target.value)}>
                            {months.slice(startIdx).map((mo) => <option key={mo.key} value={mo.index}>{mo.full} 着</option>)}
                          </select>
                          <NumField min={0}
                            title={`${coverMonths}ヶ月分の出荷 ${Math.round(o.demandAhead ?? 0).toLocaleString()} + 安全在庫 ${num(a.safety).toLocaleString()} − その時点の在庫 ${o.stockBefore.toLocaleString()} を ${roundTo} 袋単位に切り上げ`}
                            className={`w-24 rounded-md border px-1.5 py-0.5 text-right text-xs outline-none focus:border-teal-500 ${o.edited ? 'border-violet-300 bg-violet-50 font-semibold text-violet-900' : 'border-gray-200'}`}
                            value={o.qty} onChange={(v) => setEdit(a.product.id, i, 'qty', v)} allowEmpty />
                          <span className="text-gray-500">袋</span>
                          {o.late && <span className="text-red-600">L/Tが足りません</span>}
                        </div>
                      ))}
                      {a.hasMore && (
                        <div className="pl-10 text-xs text-gray-400">この先さらに発注が必要になる見込みです（3回目以降は非表示）</div>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right font-semibold text-teal-700">{a.totalQty.toLocaleString()}</td>
                  <td className="sticky right-0 z-10 bg-white px-3 py-3 text-right shadow-[-4px_0_6px_-2px_rgba(0,0,0,0.08)]">
                    <div className="flex flex-col items-end gap-1">
                      <button onClick={() => setApplyTarget(a)}
                        className="whitespace-nowrap rounded-lg bg-teal-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-teal-700">
                        入荷予定に登録…
                      </button>
                      <button onClick={() => onEdit(a.product)}
                        className="whitespace-nowrap rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50">
                        入荷予定を見る
                      </button>
                      {a.registered > 0 && (
                        <span className="whitespace-nowrap text-xs text-teal-600">登録済み {a.registered} 件</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollXSynced>
        <ApplyOrdersModal open={!!applyTarget} target={applyTarget} months={months}
          onClose={() => setApplyTarget(null)}
          onConfirm={(pid, lines) => { onApply(pid, lines); setApplyTarget(null); }} />

        <p className="border-t border-gray-100 bg-gray-50/60 px-4 py-2 text-xs text-gray-500">
          在庫が安全在庫を割る月を探し、廃棄と手入力した実在庫も差し引いたうえで発注量を出しています。
          数量と着荷月はその場で直せます（紫が手直し）。
          「入荷予定に登録…」は、確認画面を挟んでから、シミュレーションの納品予定と在庫推移に反映します。
        </p>
      </div>
    </div>
  );
}

/** 何も入っていない初期状態 */
function emptyData() {
  const now = new Date();
  const startYM = { year: now.getFullYear(), month: now.getMonth() + 1 };
  return {
    startYM, months: HORIZON, overrides: {}, purchaseOrders: [],
    stockBaseYM: { ...startYM },
    safetyMode: 'avg', safetyMonths: 3,
    safetyBaseYM: { year: startYM.month === 1 ? startYM.year - 1 : startYM.year, month: startYM.month === 1 ? 12 : startYM.month - 1 },
    categories: [], specs: [], products: [], lots: [], materials: [],
  };
}

/** データの入れ替え・消去 */
function DataMenuModal({ open, data, onClose, onReplace }) {
  const [confirm, setConfirm] = useState(null);
  useEffect(() => { if (open) setConfirm(null); }, [open]);

  const actions = [
    {
      key: 'empty', label: 'すべて消して空にする', tone: 'danger',
      desc: 'カテゴリー・規格・商品・在庫・入荷予定・手入力をすべて消します。CSVから作り直すときに使います。',
      run: () => onReplace(emptyData()),
    },
    {
      key: 'products', label: '商品と在庫だけ消す', tone: 'warn',
      desc: 'カテゴリーと規格の設定は残したまま、商品・ロット・入荷予定・手入力の在庫を消します。',
      run: () => onReplace({ ...data, products: [], lots: [], overrides: {} }),
    },
    {
      key: 'sample', label: 'サンプルデータを入れ直す', tone: 'normal',
      desc: '動作確認用のデータで上書きします。商品コードが実データと違うため、CSVを使う場合は入れないでください。',
      run: () => onReplace(seedData()),
    },
  ];

  return (
    <Modal open={open} title="データの操作" subtitle="この操作は取り消せません。全員のデータが変わります" onClose={onClose} size="lg"
      footer={<button className={secondaryBtn} onClick={onClose}>閉じる</button>}>
      <div className="space-y-3">
        <div className="rounded-xl bg-gray-50 px-4 py-3 text-xs text-gray-600">
          現在の登録数：カテゴリー {data.categories.length} / 規格 {data.specs.length} / 商品 {data.products.length} / ロット {data.lots.length}
        </div>
        {actions.map((a) => (
          <div key={a.key} className={`rounded-xl border p-4 ${a.tone === 'danger' ? 'border-red-200 bg-red-50/40' : a.tone === 'warn' ? 'border-amber-200 bg-amber-50/40' : 'border-gray-200'}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-gray-900">{a.label}</p>
                <p className="mt-0.5 text-xs text-gray-600">{a.desc}</p>
              </div>
              {confirm === a.key ? (
                <div className="flex shrink-0 gap-2">
                  <button onClick={() => { a.run(); onClose(); }}
                    className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700">実行する</button>
                  <button onClick={() => setConfirm(null)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600">やめる</button>
                </div>
              ) : (
                <button onClick={() => setConfirm(a.key)}
                  className="shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                  実行
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/* ============================================================
   エラー表示
   ============================================================ */

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null, info: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { this.setState({ info }); console.error(error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    const { error, info } = this.state;
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="mx-auto max-w-3xl rounded-2xl border border-red-200 bg-white p-6">
          <div className="mb-3 flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-600" />
            <h1 className="text-base font-semibold text-gray-900">画面の描画でエラーが起きました</h1>
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-gray-900 p-4 text-xs text-gray-100">
{String(error?.name ?? 'Error')}: {String(error?.message ?? error)}
{'\n'}{String(error?.stack ?? '').split('\n').slice(0, 12).join('\n')}
{info?.componentStack ? '\n--- componentStack ---' + info.componentStack.split('\n').slice(0, 10).join('\n') : ''}
          </pre>
          <div className="mt-4 flex gap-2">
            <button onClick={() => this.setState({ error: null, info: null })} className={secondaryBtn}>再描画する</button>
            <button onClick={async () => {
              try { await window.storage.delete(STORAGE_KEY, SHARED); } catch { /* 未保存なら何もしない */ }
              this.setState({ error: null, info: null });
            }} className={primaryBtn}>保存データを消して初期化する</button>
          </div>
        </div>
      </div>
    );
  }
}

/* ============================================================
   アプリ本体
   ============================================================ */

function validate(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const { startYM, categories, specs, products, lots } = parsed;
  if (!startYM || !Number.isFinite(Number(startYM.year))) return null;
  if (![categories, specs, products, lots].every(Array.isArray)) return null;
  return {
    startYM, months: num(parsed.months, HORIZON),
    stockBaseYM: parsed.stockBaseYM && Number.isFinite(Number(parsed.stockBaseYM.year)) ? parsed.stockBaseYM : startYM,
    productSort: PRODUCT_SORTS[parsed.productSort] ? parsed.productSort : 'manual',
    safetyMode: parsed.safetyMode === 'fixed' ? 'fixed' : 'avg',
    safetyMonths: num(parsed.safetyMonths, 3),
    safetyBaseYM: parsed.safetyBaseYM && Number.isFinite(Number(parsed.safetyBaseYM.year)) ? parsed.safetyBaseYM : null,
    overrides: parsed.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : {},
    categories: categories.map((c) => ({ ...blankCategory, ...c })),
    specs: specs.map((s) => ({ ...blankSpec, ...s })),
    products: products.map((p) => ({ ...blankProduct, ...p })),
    lots: lots.filter((l) => l && l.product_id),
    purchaseOrders: Array.isArray(parsed.purchaseOrders)
      ? parsed.purchaseOrders.filter((x) => x && x.product_id).map((x) => ({
          ...x, deliveries: x.deliveries ?? [], materials: x.materials ?? [],
          manufactureRecords: Array.isArray(x.manufactureRecords)
            ? x.manufactureRecords
            : (num(x.manufacturedQty) > 0 ? [{ id: uid(), date: x.orderDate || todayIso(), quantity: num(x.manufacturedQty), note: '' }] : []),
        }))
      : [],
    materials: Array.isArray(parsed.materials)
      ? parsed.materials.filter((x) => x && x.id).map((x) => ({ ...blankMaterial(), ...x, stock: Math.max(0, num(x.stock)) }))
      : [],
  };
}

export default function App() {
  return <ErrorBoundary><AppInner /></ErrorBoundary>;
}

function AppInner() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('simulation');
  const [monthlyCsvModal, setMonthlyCsvModal] = useState(false);

  const [productModal, setProductModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [lotModal, setLotModal] = useState(false);
  const [lotProduct, setLotProduct] = useState(null);
  const [catModal, setCatModal] = useState(false);
  const [editingCat, setEditingCat] = useState(null);
  const [specModal, setSpecModal] = useState(false);
  const [editingSpec, setEditingSpec] = useState(null);
  const [csvModal, setCsvModal] = useState(false);
  const [incModal, setIncModal] = useState(false);
  const [incProduct, setIncProduct] = useState(null);
  const [dataMenu, setDataMenu] = useState(false);
  const [poModal, setPoModal] = useState(false);
  const [editingPo, setEditingPo] = useState(null);
  const [materialModal, setMaterialModal] = useState(false);
  const [editingMaterial, setEditingMaterial] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        /* まず共有データを読む */
        const res = await window.storage.get(STORAGE_KEY, SHARED);
        const parsed = validate(JSON.parse(res.value));
        if (!parsed) throw new Error('保存データの形が想定と違います');
        setData(parsed);
      } catch {
        /* 共有データがなければ、個人保存していた分を引き継ぐ */
        try {
          const mine = await window.storage.get(STORAGE_KEY, false);
          const parsed = validate(JSON.parse(mine.value));
          if (parsed) {
            setData(parsed);
            await window.storage.set(STORAGE_KEY, JSON.stringify(parsed), SHARED);
            setLoading(false);
            return;
          }
        } catch { /* 個人保存もなければ空から始める */ }
        /* 初回は空の状態から。サンプルは必要に応じてデータ操作から入れる */
        const init = emptyData();
        setData(init);
        try { await window.storage.set(STORAGE_KEY, JSON.stringify(init), SHARED); } catch { /* 表示は続行 */ }
      } finally { setLoading(false); }
    })();
  }, []);

  const persist = useCallback(async (next) => {
    setData(next);
    setSaving(true);
    try { await window.storage.set(STORAGE_KEY, JSON.stringify(next), SHARED); }
    catch { /* 保存できなくても画面は使える */ }
    finally { setSaving(false); }
  }, []);

  const months = useMemo(() => (data ? buildMonths(data.startYM, data.months ?? HORIZON) : []), [data]);
  const calcAll = useMemo(() => (data && months.length ? compute(data, months) : null), [data, months]);
  const safetyOf = useCallback((id) => {
    if (!calcAll || calcAll.safetyMode !== 'avg') return null;
    return calcAll.productResults.get(id)?.safety ?? null;
  }, [calcAll]);

  if (loading || !data) {
    return <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-teal-200 border-t-teal-600" />
    </div>;
  }

  /* シートからのカテゴリー編集。第2引数があれば規格の更新 */
  const changeFromSheet = (category, spec) => {
    if (spec) { persist({ ...data, specs: data.specs.map((s) => (s.id === spec.id ? spec : s)) }); return; }
    persist({ ...data, categories: data.categories.map((c) => (c.id === category.id ? category : c)) });
  };

  const saveProduct = (form) => {
    persist(form.id
      ? { ...data, products: data.products.map((p) => (p.id === form.id ? { ...p, ...form } : p)) }
      : { ...data, products: [{ ...form, id: uid() }, ...data.products] });
    setProductModal(false); setEditingProduct(null);
  };

  const saveLots = (productId, rows) => {
    const others = data.lots.filter((l) => l.product_id !== productId);
    const cleaned = rows.filter((r) => num(r.quantity) > 0 || r.expiry)
      .map((r) => ({
        id: r.id ?? uid(), product_id: productId, expiry: r.expiry || '',
        quantity: num(r.quantity), specIds: r.specIds ?? [],
        cost: num(r.cost), costParts: r.costParts ?? {},
      }));
    persist({ ...data, lots: [...others, ...cleaned] });
    setLotModal(false); setLotProduct(null);
  };

  const handleImport = (preview, opts = {}) => {
    const { specId, baseYM, lockPast = true, zeroMissing = false, replaceProducts = false } = opts;
    const newBase = baseYM ?? data.stockBaseYM ?? data.startYM;
    const newBaseKey = ymKey(newBase.year, newBase.month);

    /* 取込前の在庫を、基準月より前の月の実績として書き込んでおく */
    const overrides = { ...(data.overrides ?? {}) };
    if (lockPast && months.length) {
      const prev = compute(data, months);
      const stopIdx = months.findIndex((mo) => mo.key === newBaseKey);
      const limit = stopIdx >= 0 ? stopIdx : months.length;
      prev.productResults.forEach((r) => {
        r.rows.forEach((row, i) => {
          if (i >= limit) return;
          if (row.before || row.remain === null) return;
          const k = `stock|${r.product.id}|${row.month.key}`;
          if (overrides[k] === undefined) overrides[k] = Math.round(row.remain);
        });
      });
    }

    const products = replaceProducts ? [] : [...data.products];
    let lots = replaceProducts ? [] : [...data.lots];
    const touched = new Set();

    preview.products.forEach((row) => {
      const key = row.code || row.name;
      const prev = products.find((p) => (p.code || p.name) === key);
      const id = prev?.id ?? uid();
      if (!prev) products.push({ ...blankProduct, id, code: row.code, name: row.name, spec_id: specId || null });
      touched.add(id);
      lots = lots.filter((l) => l.product_id !== id);
      row.lots.forEach((l) => lots.push({
        id: uid(), product_id: id, expiry: l.expiry || '', quantity: l.quantity, specIds: [],
      }));
    });

    if (zeroMissing) lots = lots.filter((l) => touched.has(l.product_id));

    persist({ ...data, products, lots, overrides, stockBaseYM: newBase });
  };

  const tabs = [
    { key: 'simulation', label: 'シミュレーション', icon: BarChart3 },
    { key: 'alerts', label: '発注アラート', icon: AlertTriangle },
    { key: 'delivery', label: '納品管理', icon: Truck },
    { key: 'materials', label: '資材在庫', icon: PackageOpen },
    { key: 'inventory', label: '在庫一覧', icon: Package },
    { key: 'settings', label: '設定', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <style>{`
        .scroll-x { overflow-x: auto; scrollbar-width: auto; scrollbar-color: #94a3b8 #e5e7eb; }
        .scroll-x::-webkit-scrollbar { height: 12px; }
        .scroll-x::-webkit-scrollbar-track { background: #e5e7eb; border-radius: 9999px; }
        .scroll-x::-webkit-scrollbar-thumb { background-color: #94a3b8; border-radius: 9999px; border: 2px solid #e5e7eb; }
        .scroll-x::-webkit-scrollbar-thumb:hover { background-color: #64748b; }
      `}</style>
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white/90 backdrop-blur-md">
        <div className="mx-auto max-w-full px-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-600 text-white"><Boxes className="h-5 w-5" /></div>
              <div>
                <h1 className="text-lg font-bold leading-none text-gray-900">在庫・KPI管理</h1>
                <p className="mt-0.5 text-xs text-gray-400">
                  {SHARED ? 'このデータは開いた全員で共有されます' : 'データはこのブラウザに保存されます'}
                </p>
              </div>
            </div>
            <nav className="flex items-center gap-1 rounded-xl bg-gray-100 p-1">
              {tabs.map(({ key, label, icon: Icon }) => (
                <button key={key} onClick={() => setTab(key)}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${tab === key ? 'bg-white text-teal-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                  <Icon className="h-4 w-4" /><span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </nav>
            <div className="flex items-center gap-2">
              <button onClick={() => window.location.reload()} title="他の人が加えた変更を取り込みます"
                className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                <RotateCcw className="h-4 w-4" /><span className="hidden lg:inline">最新に更新</span>
              </button>
              <button onClick={() => setDataMenu(true)} className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                <Settings className="h-4 w-4" /><span className="hidden lg:inline">データ操作</span>
              </button>
              <button onClick={() => setCsvModal(true)} className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                <Upload className="h-4 w-4" /><span className="hidden lg:inline">CSV取込</span>
              </button>
              <button onClick={() => { setEditingProduct(null); setProductModal(true); }} className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700">
                <Plus className="h-4 w-4" /><span className="hidden lg:inline">商品を追加</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-full px-4 py-6 sm:px-6">
        {data.products.length === 0 && data.categories.length === 0 && (
          <div className="mb-6 rounded-2xl border border-teal-200 bg-teal-50/60 p-6">
            <h2 className="text-sm font-semibold text-gray-900">はじめに</h2>
            <ol className="mt-2 space-y-1 text-sm text-gray-700">
              <li>1. 設定タブで「カテゴリーを追加」（例: ヘルシー、イヌメシ、サプリ）</li>
              <li>2. 「CSV取込」で月次在庫表を読み込み、商品と在庫を登録</li>
              <li>3. 在庫一覧で、各商品に出荷区分（規格）と選択率を割り当て</li>
              <li>4. シミュレーションで新規数とアップセル率を入力</li>
            </ol>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button onClick={() => persist(seedData())}
                className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700">
                サンプルデータを入れて計算を確認する
              </button>
              <span className="text-xs text-gray-500">
                商品コードが実データと異なるため、CSVを使う前にヘッダーの「データ操作」から消してください。
              </span>
            </div>
          </div>
        )}

        {tab === 'simulation' && <SimulationSheet data={data} onChangeCategory={changeFromSheet}
          onChangeOverrides={(next) => persist({ ...data, overrides: next })}
          onEditIncoming={(p) => { setIncProduct(p); setIncModal(true); }}
          onChangeMeta={(fields) => persist({ ...data, ...fields })}
          onImportMonthlyShipment={() => setMonthlyCsvModal(true)} />}
        {tab === 'alerts' && (
          <OrderAlerts data={data}
            onEdit={(p) => { setIncProduct(p); setIncModal(true); }}
            onApply={(id, lines) => persist({
              ...data,
              products: data.products.map((p) => (p.id === id ? {
                ...p,
                /* 発注計画から登録した分は入れ替え、手で入れた分は残す */
                incoming: [
                  ...(p.incoming ?? []).filter((x) => x.source !== 'plan'),
                  ...lines.filter((l) => num(l.quantity) > 0)
                    .map((l) => ({ id: uid(), ym: l.ym, quantity: num(l.quantity), expiry: l.expiry || '', source: 'plan' })),
                ],
              } : p)),
            })} />
        )}
        {tab === 'delivery' && (
          <DeliveryBoard data={data}
            onNew={() => { setEditingPo({ ...blankPo(), product_id: data.products[0]?.id ?? null }); setPoModal(true); }}
            onEdit={(po) => { setEditingPo(po); setPoModal(true); }} />
        )}
        {tab === 'materials' && (
          <MaterialsBoard materials={data.materials ?? []} purchaseOrders={data.purchaseOrders ?? []}
            onAdd={() => { setEditingMaterial(null); setMaterialModal(true); }}
            onEdit={(m) => { setEditingMaterial(m); setMaterialModal(true); }}
            onQuickStock={(id, delta) => persist({
              ...data,
              materials: (data.materials ?? []).map((m) => (m.id === id ? { ...m, stock: Math.max(0, num(m.stock) + delta) } : m)),
            })}
            onReceiveMaterial={(id, qty) => persist({
              ...data,
              materials: (data.materials ?? []).map((m) => (m.id === id ? { ...m, stock: Math.max(0, num(m.stock) + num(qty)) } : m)),
            })} />
        )}
        {tab === 'inventory' && (
          <InventoryTable products={data.products} lots={data.lots} categories={data.categories} specs={data.specs} safetyOf={safetyOf}
            sortMode={data.productSort ?? 'manual'}
            onEdit={(p) => { setEditingProduct(p); setProductModal(true); }}
            onDelete={(id) => persist({ ...data, products: data.products.filter((p) => p.id !== id), lots: data.lots.filter((l) => l.product_id !== id) })}
            onEditLots={(p) => { setLotProduct(p); setLotModal(true); }}
            onUpdateShare={(id, v) => persist({ ...data, products: data.products.map((p) => (p.id === id ? { ...p, share: v } : p)) })}
            onUpdateSpec={(id, v) => persist({ ...data, products: data.products.map((p) => (p.id === id ? { ...p, spec_id: v } : p)) })}
            onUpdateStreams={(id, v) => persist({ ...data, products: data.products.map((p) => (p.id === id ? { ...p, streams: v } : p)) })}
            onUpdateProduct={(id, fields) => persist({ ...data, products: data.products.map((p) => (p.id === id ? { ...p, ...fields } : p)) })}
            onReorder={(list) => {
              const map = new Map(list.map((x) => [x.id, x.order]));
              persist({ ...data, products: data.products.map((p) => (map.has(p.id) ? { ...p, order: map.get(p.id) } : p)) });
            }}
            onIncoming={(p) => { setIncProduct(p); setIncModal(true); }}
            onBulkHideZero={() => {
              const stockOf = (id) => (data.lots ?? []).filter((l) => l.product_id === id).reduce((s, l) => s + num(l.quantity), 0);
              persist({ ...data, products: data.products.map((p) => (!p.hidden && stockOf(p.id) <= 0 ? { ...p, hidden: true } : p)) });
            }}
            onBulkHideExpired={() => {
              const today = todayIso();
              const statsOf = (id) => (data.lots ?? []).filter((l) => l.product_id === id).reduce((acc, l) => {
                acc.stock += num(l.quantity);
                if (l.expiry && l.expiry < today) acc.expired += num(l.quantity);
                return acc;
              }, { stock: 0, expired: 0 });
              persist({
                ...data,
                products: data.products.map((p) => {
                  if (p.hidden) return p;
                  const s = statsOf(p.id);
                  return s.stock > 0 && s.expired >= s.stock ? { ...p, hidden: true } : p;
                }),
              });
            }}
            onBulkHideDiscontinued={() => {
              persist({
                ...data,
                products: data.products.map((p) => (!p.hidden && p.discontinued ? { ...p, hidden: true } : p)),
              });
            }} />
        )}
        {tab === 'settings' && (
          <SettingsTab data={data}
            onSaveMeta={(fields) => persist({ ...data, ...fields })}
            onAddCategory={() => { setEditingCat(null); setCatModal(true); }}
            onEditCategory={(c) => { setEditingCat(c); setCatModal(true); }}
            onDeleteCategory={(id) => persist({
              ...data,
              categories: data.categories.filter((c) => c.id !== id),
              specs: data.specs.filter((s) => s.category_id !== id),
              products: data.products.map((p) => (data.specs.find((s) => s.id === p.spec_id)?.category_id === id ? { ...p, spec_id: null } : p)),
            })}
            onAddSpec={() => { setEditingSpec(null); setSpecModal(true); }}
            onEditSpec={(s) => { setEditingSpec(s); setSpecModal(true); }}
            onDeleteSpec={(id) => persist({
              ...data,
              specs: data.specs.filter((s) => s.id !== id),
              products: data.products.map((p) => (p.spec_id === id ? { ...p, spec_id: null } : p)),
            })} />
        )}
        {saving && <p className="mt-4 text-right text-xs text-gray-400">保存中…</p>}
      </main>

      <ProductFormModal open={productModal} product={editingProduct} categories={data.categories} specs={data.specs} months={months}
        onClose={() => { setProductModal(false); setEditingProduct(null); }} onSave={saveProduct} />
      <LotEditorModal open={lotModal} product={lotProduct} specs={data.specs} categories={data.categories}
        lots={data.lots.filter((l) => l.product_id === lotProduct?.id)}
        onClose={() => { setLotModal(false); setLotProduct(null); }} onSave={saveLots} />
      <CategoryFormModal open={catModal} category={editingCat}
        onClose={() => { setCatModal(false); setEditingCat(null); }}
        onSave={(form, withSpecs) => {
          if (form.id) {
            persist({ ...data, categories: data.categories.map((c) => (c.id === form.id ? { ...c, ...form } : c)) });
          } else {
            const cat = { ...form, id: uid() };
            const newSpecs = withSpecs ? [
              { ...blankSpec, id: uid(), order: 0, name: `${cat.name} 定期`, category_id: cat.id, source: 'repeat_upsell', bagsPerOrder: 1, marginMonths: 2 },
              { ...blankSpec, id: uid(), order: 1, name: `${cat.name} 初回`, category_id: cat.id, source: 'first_base', bagsPerOrder: 1, marginMonths: 2 },
              { ...blankSpec, id: uid(), order: 2, name: `${cat.name} 単品・サンプル`, category_id: cat.id, source: 'first', bagsPerOrder: 1, marginMonths: 0 },
              { ...blankSpec, id: uid(), order: 3, name: `${cat.name} 見切り消化`, category_id: cat.id, source: 'clearance', bagsPerOrder: 1, marginMonths: 0, clearanceCap: 0 },
            ] : [];
            persist({ ...data, categories: [...data.categories, cat], specs: [...data.specs, ...newSpecs] });
          }
          setCatModal(false); setEditingCat(null);
        }} />
      <SpecFormModal open={specModal} spec={editingSpec} categories={data.categories} allSpecs={data.specs} months={months}
        onClose={() => { setSpecModal(false); setEditingSpec(null); }}
        onSave={(form) => {
          persist(form.id
            ? { ...data, specs: data.specs.map((s) => (s.id === form.id ? { ...s, ...form } : s)) }
            : { ...data, specs: [...data.specs, { ...form, id: uid() }] });
          setSpecModal(false); setEditingSpec(null);
        }} />
      <IncomingModal open={incModal} product={incProduct ? data.products.find((p) => p.id === incProduct.id) ?? incProduct : null} months={months}
        onClose={() => { setIncModal(false); setIncProduct(null); }}
        onSave={(id, rows) => {
          persist({ ...data, products: data.products.map((p) => (p.id === id ? {
            ...p,
            incoming: rows.filter((r) => num(r.quantity) > 0).map((r) => ({
              ...r, cost: num(r.cost), costParts: r.costParts ?? {},
            })),
          } : p)) });
          setIncModal(false); setIncProduct(null);
        }} />
      <PoModal open={poModal} po={editingPo} products={data.products} categories={data.categories} specs={data.specs} materials={data.materials ?? []}
        onClose={() => { setPoModal(false); setEditingPo(null); }}
        onSave={(form) => {
          const list = data.purchaseOrders ?? [];
          const oldPo = list.find((x) => x.id === form.id);
          const materials = applyMaterialUsage(data.materials ?? [], materialUsageForPo(oldPo), materialUsageForPo(form));
          persist({
            ...data,
            materials,
            purchaseOrders: list.some((x) => x.id === form.id)
              ? list.map((x) => (x.id === form.id ? form : x))
              : [...list, form],
          });
          setPoModal(false); setEditingPo(null);
        }}
        onDelete={(id) => {
          const oldPo = (data.purchaseOrders ?? []).find((x) => x.id === id);
          const materials = applyMaterialUsage(data.materials ?? [], materialUsageForPo(oldPo), []);
          persist({ ...data, materials, purchaseOrders: (data.purchaseOrders ?? []).filter((x) => x.id !== id) });
          setPoModal(false); setEditingPo(null);
        }} />

      <MaterialFormModal open={materialModal} material={editingMaterial} materials={data.materials ?? []}
        onClose={() => { setMaterialModal(false); setEditingMaterial(null); }}
        onSave={(form) => {
          const list = data.materials ?? [];
          persist({
            ...data,
            materials: list.some((x) => x.id === form.id) ? list.map((x) => (x.id === form.id ? form : x)) : [...list, form],
          });
          setMaterialModal(false); setEditingMaterial(null);
        }}
        onDelete={(id) => {
          persist({ ...data, materials: (data.materials ?? []).filter((x) => x.id !== id) });
          setMaterialModal(false); setEditingMaterial(null);
        }} />

      <DataMenuModal open={dataMenu} data={data} onClose={() => setDataMenu(false)} onReplace={(next) => persist(next)} />

      <CsvImportModal open={csvModal} categories={data.categories} specs={data.specs} months={months}
        currentBase={data.stockBaseYM ?? data.startYM}
        onClose={() => setCsvModal(false)} onImport={handleImport} />

      <MonthlyShipmentCsvImportModal open={monthlyCsvModal} categories={data.categories} products={data.products} specs={data.specs}
        onClose={() => setMonthlyCsvModal(false)}
        onImport={(catId, byMonth, productMap, sizeSpecMap) => {
          const cat = data.categories.find((c) => c.id === catId);
          if (!cat) return;
          const confirmedNew = { ...cat.confirmedNew };
          const pendingCancelNew = { ...cat.pendingCancelNew };
          const upsellRates = { ...cat.upsellRates };
          const repeatActual = { ...cat.repeatActual };
          const overrides = { ...(data.overrides ?? {}) };

          /* 確認画面で選んだ「サイズ→規格」の対応付けをそのまま使う（名前の一致には頼らない）。
             商品側の対応付けで、その規格が商品の主規格／追加の出荷区分のどちらにあるかも特定する。 */
          const specIdForSize = (product, size) => {
            const specId = sizeSpecMap?.[size];
            if (!specId) return null;
            if (product.spec_id === specId) return specId;
            const st = (product.streams ?? []).find((s) => s.spec_id === specId);
            return st ? specId : specId;
          };

          Object.entries(byMonth).forEach(([ym, v]) => {
            confirmedNew[ym] = v.confirmed;
            pendingCancelNew[ym] = v.pending;
            repeatActual[ym] = v.repeat;
            const denom = num(v.trial) + num(v.main);
            if (denom > 0) upsellRates[ym] = Math.round((num(v.main) / denom) * 1000) / 10;

            /* サイズごとの出荷件数・1件あたり袋数を、選んだ規格にそのまま反映する。
               「1件あたり袋数」は合計袋数÷件数で、規格の「出荷件数」「1件あたり袋数」の
               手入力欄（予測との差異）と同じ場所に書き込む。 */
            ['100g', '800g', '1kg'].forEach((size) => {
              const specId = sizeSpecMap?.[size];
              const m = v.size?.[size];
              if (!specId || !m || m.orders <= 0) return;
              overrides[`orders|${specId}|${ym}`] = m.orders;
              overrides[`bags|${specId}|${ym}`] = Math.round((m.bags / m.orders) * 100) / 100;
            });

            /* サイズ×味ごとの実績を、確認画面で手動対応付けした商品にそのまま反映する
               （発注書と同じ「実績の直接入力」の仕組み＝予測との差異の手入力値）。 */
            Object.entries(v.flavorSize ?? {}).forEach(([size, flavors]) => {
              Object.entries(flavors).forEach(([flavor, bags]) => {
                const productId = productMap?.[`${size}|${flavor}`];
                if (!productId) return;
                const product = data.products.find((p) => p.id === productId);
                if (!product) return;
                const specId = specIdForSize(product, size);
                if (!specId) return;
                overrides[`demand|${product.id}:${specId}|${ym}`] = num(bags);
              });
            });
          });

          persist({
            ...data,
            categories: data.categories.map((c) => (
              c.id === catId ? { ...c, confirmedNew, pendingCancelNew, upsellRates, repeatActual, useConfirmedModel: true } : c
            )),
            overrides,
          });
        }} />
    </div>
  );
}
