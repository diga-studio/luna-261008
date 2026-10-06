import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importReviews } from '../src/importer.js';
import { HEADER, makeStore, toStream } from './helpers.js';

test('多行正文、逗号与转义引号原样读回', async () => {
  const { store } = makeStore();
  const csv =
    HEADER +
    '"amazon","Alice","line1\nline2, with comma and ""quote""\r\nline3","2024-03-01T10:00:00Z"\n';
  const result = await importReviews(store, 'm1', toStream(csv));
  assert.equal(result.status, 'imported');
  assert.equal(result.upserted, 1);
  const reviews = store.listReviews('m1');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].text, 'line1\nline2, with comma and "quote"\r\nline3');
  assert.equal(reviews[0].channel, 'amazon');
  store.close();
});

test('不同时区同一时刻、归一后同名的记录去重，保留批次中最后一条', async () => {
  const { store } = makeStore();
  const nfc = 'José'; // é 单码点
  const nfd = 'José'; // e + 组合音符
  const rows = [
    // r1: UTC 表达，reviewer 为 NFC，channel 带首尾空格
    ` amazon ,${nfc},first,2024-01-01T00:00:00Z`,
    'amazon, ,blank reviewer,2024-01-01T00:00:00Z', // r2: reviewer 归一后为空 -> 记录错误
    // r3: 与 r1 同一时刻（+08:00），reviewer 为 NFD，归一后同名 -> 替换 r1
    `amazon,${nfd},second,2024-01-01T08:00:00+08:00`,
    // r4..r10: 互不相同的有效记录，把错误率压到 10%
    'amazon,Bob,r4,2024-01-02T00:00:00Z',
    'amazon,Carol,r5,2024-01-03T00:00:00Z',
    'ebay,Dave,r6,2024-01-01T00:00:00Z',
    'etsy,Eve,r7,2024-01-01T00:00:00Z',
    'amazon,Frank,r8,2024-01-04T00:00:00Z',
    'amazon,Grace,r9,2024-01-05T00:00:00Z',
    'amazon,Heidi,r10,2024-01-06T00:00:00Z',
  ];
  const csv = HEADER + rows.join('\n') + '\n';
  const result = await importReviews(store, 'm1', toStream(csv));
  assert.equal(result.status, 'imported');
  assert.equal(result.totalRecords, 10);
  assert.equal(result.errorRecords, 1);
  assert.equal(result.errors[0].recordIndex, 2);

  const reviews = store.listReviews('m1');
  assert.equal(reviews.length, 8); // 9 条有效，r1/r3 同键 -> 8 条
  const dup = reviews.find((r) => r.timestampMs === Date.UTC(2024, 0, 1));
  assert.ok(dup);
  assert.equal(dup.text, 'second'); // 保留批次中最后一条
  assert.equal(dup.timestamp, '2024-01-01T08:00:00+08:00'); // 完整原始字段
  assert.equal(dup.reviewerName, nfd); // 原始字段原样保存（未做 NFC）
  store.close();
});

test('跨批次同键替换，且不同商家互不合并', async () => {
  const { store } = makeStore();
  const csv1 = HEADER + 'amazon,Alice,old,2024-01-01T00:00:00Z\n';
  const csv2 = HEADER + 'amazon,Alice,new,2024-01-01T00:00:00Z\n';
  await importReviews(store, 'm1', toStream(csv1));
  await importReviews(store, 'm2', toStream(csv1)); // 不同商家同键
  await importReviews(store, 'm1', toStream(csv2));
  const m1 = store.listReviews('m1');
  assert.equal(m1.length, 1);
  assert.equal(m1[0].text, 'new'); // 同键替换库中已有记录
  const m2 = store.listReviews('m2');
  assert.equal(m2.length, 1);
  assert.equal(m2[0].text, 'old'); // 不同商家永不合并
  store.close();
});

test('错误记录不能覆盖库中已有的有效记录', async () => {
  const { store } = makeStore();
  await importReviews(
    store,
    'm1',
    toStream(HEADER + 'amazon,Alice,original,2024-01-01T00:00:00Z\n'),
  );
  // 同键但 timestamp 非法 -> 记录错误，跳过；错误率 1/2 = 50%？不，凑到 <=15%
  const rows = [
    'amazon,Alice,evil,not-a-timestamp', // 错误记录，不能覆盖
    ...Array.from({ length: 9 }, (_, i) => `amazon,U${i},ok,2024-02-0${(i % 9) + 1}T00:00:00Z`),
  ];
  const result = await importReviews(store, 'm1', toStream(HEADER + rows.join('\n') + '\n'));
  assert.equal(result.status, 'imported');
  const alice = store.listReviews('m1').find((r) => r.reviewerName === 'Alice');
  assert.equal(alice?.text, 'original');
  store.close();
});

test('空 text 允许；空行算一条错误记录；末尾换行不产生空记录；BOM 与 CRLF 兼容', async () => {
  const { store } = makeStore();
  const csv =
    '﻿channel,reviewer_name,text,timestamp\r\n' +
    'amazon,Alice,,2024-01-01T00:00:00Z\r\n' + // 空 text，有效
    '\r\n' + // 空行 -> 错误记录
    // 补足有效记录，把错误率压到 1/9 < 15%
    Array.from({ length: 6 }, (_, i) => `amazon,Pad${i},pad,2024-02-0${i + 1}T00:00:00Z`).join('\n') +
    '\n' +
    'amazon,Bob,last,2024-01-02T00:00:00Z'; // 最后一条无换行
  const result = await importReviews(store, 'm1', toStream(csv));
  assert.equal(result.status, 'imported');
  assert.equal(result.totalRecords, 9);
  assert.equal(result.errorRecords, 1);
  const reviews = store.listReviews('m1');
  assert.equal(reviews.length, 8);
  assert.equal(reviews[0].text, '');
  store.close();
});

test('多字节字符被流块边界切开也能正确解析', async () => {
  const { store } = makeStore();
  const csv = HEADER + 'amazon,小明,你好世界,2024-01-01T00:00:00Z\n';
  const result = await importReviews(store, 'm1', toStream(csv, 3)); // 每 3 字节一块
  assert.equal(result.status, 'imported');
  assert.equal(store.listReviews('m1')[0].text, '你好世界');
  store.close();
});
