import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importReviews } from '../src/importer.js';
import { HEADER, makeStore, toByteStream, toStream } from './helpers.js';

function validRow(i: number): string {
  return `amazon,U${i},text${i},2024-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`;
}

test('恰好 15% 错误率允许提交，只跳过错误记录', async () => {
  const { store } = makeStore();
  // 20 条记录，3 条错误 = 恰好 15%
  const rows: string[] = [];
  for (let i = 0; i < 17; i++) rows.push(validRow(i));
  rows.push('amazon,OnlyThree,2024-01-01T00:00:00Z'); // 字段数 3
  rows.push(''); // 空行
  rows.push('amazon,BadTs,x,2024-02-30T00:00:00Z'); // 日期不存在
  const result = await importReviews(store, 'm1', toStream(HEADER + rows.join('\n') + '\n'));
  assert.equal(result.status, 'imported');
  assert.equal(result.totalRecords, 20);
  assert.equal(result.errorRecords, 3);
  assert.equal(result.upserted, 17);
  assert.equal(store.listReviews('m1').length, 17);
  store.close();
});

test('超过 15% 整批拒绝：已有评论完全不变，包括本会被替换的记录', async () => {
  const { store } = makeStore();
  await importReviews(
    store,
    'm1',
    toStream(HEADER + 'amazon,Alice,original,2024-01-01T00:00:00Z\n'),
  );
  // 20 条记录，4 条错误 = 20% > 15%
  const rows: string[] = [];
  for (let i = 0; i < 16; i++) rows.push(validRow(i));
  rows[0] = 'amazon,Alice,replaced,2024-01-01T00:00:00Z'; // 本可替换已有记录
  rows.push('a,b,c'); // 字段数错误
  rows.push('amazon, ,x,2024-01-01T00:00:00Z'); // reviewer 归一后为空
  rows.push('amazon,NoTz,x,2024-01-01T00:00:00'); // 未带时区
  rows.push('amazon,Leap,x,2024-01-01T00:00:60Z'); // 秒为 60
  const result = await importReviews(store, 'm1', toStream(HEADER + rows.join('\n') + '\n'));
  assert.equal(result.status, 'rejected');
  assert.equal(result.totalRecords, 20);
  assert.equal(result.errorRecords, 4);
  assert.equal(result.upserted, 0);
  const reviews = store.listReviews('m1');
  assert.equal(reviews.length, 1); // 没有新增
  assert.equal(reviews[0].text, 'original'); // 没有替换
  store.close();
});

test('文件末尾引号未闭合：整批失败，已有数据不变', async () => {
  const { store } = makeStore();
  await importReviews(
    store,
    'm1',
    toStream(HEADER + 'amazon,Alice,original,2024-01-01T00:00:00Z\n'),
  );
  const csv =
    HEADER +
    'amazon,Alice,replaced,2024-01-01T00:00:00Z\n' + // 本可替换
    'amazon,Bob,new,2024-01-02T00:00:00Z\n' + // 本可新增
    'amazon,Carol,"truncated,2024-01-03T00:00:00Z'; // 引号未闭合
  const result = await importReviews(store, 'm1', toStream(csv));
  assert.equal(result.status, 'failed');
  assert.match(result.fatalError ?? '', /unclosed quote/);
  const reviews = store.listReviews('m1');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].text, 'original');
  store.close();
});

test('只有表头的文件视为空批次：成功但不修改数据', async () => {
  const { store } = makeStore();
  await importReviews(store, 'm1', toStream(HEADER + 'amazon,Alice,keep,2024-01-01T00:00:00Z\n'));
  const result = await importReviews(store, 'm1', toStream(HEADER));
  assert.equal(result.status, 'imported');
  assert.equal(result.totalRecords, 0);
  assert.equal(result.upserted, 0);
  assert.equal(store.listReviews('m1').length, 1);
  store.close();
});

test('非法 UTF-8 / 表头不符 / lone CR / 未引用字段含引号：整批失败', async () => {
  // 非法 UTF-8
  {
    const { store } = makeStore();
    const bytes = new TextEncoder().encode(HEADER + 'amazon,Alice,');
    const bad = new Uint8Array([...bytes, 0xff, 0xfe]);
    const result = await importReviews(store, 'm1', toByteStream(bad));
    assert.equal(result.status, 'failed');
    assert.match(result.fatalError ?? '', /UTF-8/);
    store.close();
  }
  // 表头不符
  {
    const { store } = makeStore();
    const result = await importReviews(
      store,
      'm1',
      toStream('channel,reviewer,text,timestamp\namazon,A,x,2024-01-01T00:00:00Z\n'),
    );
    assert.equal(result.status, 'failed');
    assert.match(result.fatalError ?? '', /header/);
    store.close();
  }
  // 单独出现的 CR
  {
    const { store } = makeStore();
    const result = await importReviews(
      store,
      'm1',
      toStream(HEADER + 'amazon,Alice,x,2024-01-01T00:00:00Z\ramazon,Bob,y,2024-01-02T00:00:00Z\n'),
    );
    assert.equal(result.status, 'failed');
    store.close();
  }
  // 未引用字段含双引号
  {
    const { store } = makeStore();
    const result = await importReviews(
      store,
      'm1',
      toStream(HEADER + 'amazon,Ali"ce,x,2024-01-01T00:00:00Z\n'),
    );
    assert.equal(result.status, 'failed');
    store.close();
  }
});

test('结束引号后紧跟非法字符：整批失败', async () => {
  const { store } = makeStore();
  const result = await importReviews(
    store,
    'm1',
    toStream(HEADER + '"amazon"x,Alice,t,2024-01-01T00:00:00Z\n'),
  );
  assert.equal(result.status, 'failed');
  store.close();
});

test('timestamp 边界：3 位小数合法，4 位不合法；2 月 29 日闰年判断', async () => {
  const { store } = makeStore();
  const rows = [
    'amazon,A,ms3,2024-01-01T00:00:00.123Z', // 有效
    'amazon,B,ms4,2024-01-01T00:00:00.1234Z', // 错误：4 位小数
    'amazon,C,leap,2024-02-29T00:00:00Z', // 有效：闰年
    'amazon,D,notleap,2023-02-29T00:00:00Z', // 错误：非闰年
    ...Array.from({ length: 18 }, (_, i) => `amazon,E${i},pad,2024-03-0${(i % 9) + 1}T00:00:00Z`),
  ];
  const result = await importReviews(store, 'm1', toStream(HEADER + rows.join('\n') + '\n'));
  assert.equal(result.status, 'imported'); // 2/22 < 15%
  assert.equal(result.errorRecords, 2);
  const reviews = store.listReviews('m1');
  assert.equal(reviews.length, 20);
  const ms = reviews.find((r) => r.text === 'ms3');
  assert.equal(ms?.timestampMs, Date.UTC(2024, 0, 1, 0, 0, 0, 123));
  store.close();
});
