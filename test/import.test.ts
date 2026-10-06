import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enc, HEADER, makeLib } from './helpers.ts';

test('多行正文（含逗号、引号、LF/CRLF）原样读回', () => {
  const { lib, cleanup } = makeLib();
  try {
    const text = '第一行\n第二行, 含逗号\n第三行 "引号" 结尾\r\n第四行';
    const csv = HEADER + `web,Alice,"${text.replace(/"/g, '""')}",2024-01-01T00:00:00Z\n`;
    const result = lib.importCsv('m1', enc(csv));
    assert.equal(result.status, 'ok');
    assert.equal(result.imported, 1);
    const reviews = lib.listReviews('m1');
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].text, text);
    assert.equal(reviews[0].channel, 'web');
    assert.equal(reviews[0].reviewerName, 'Alice');
    assert.equal(reviews[0].timestamp, '2024-01-01T00:00:00Z');
  } finally {
    cleanup();
  }
});

test('去重：不同时区同一时刻、NFC 归一同名、无效记录穿插，最后一条有效记录胜出', () => {
  const { lib, cleanup } = makeLib();
  try {
    // 同一时刻的两种时区表达；Eve 的两种 Unicode 形式（NFC 归一后相同）
    const decomposed = 'E\u0301ve'; // E + 组合锐音符
    const composed = '\u00C9ve'; // 预组合字符 É
    const lines = [
      HEADER,
      `web,${decomposed},first,2024-01-01T00:00:00Z\n`, // 有效，将被覆盖
      'bad,record,three\n', // 无效：字段数不为 4
      `web,${composed},second,2024-01-01T08:00:00+08:00\n`, // 同键，最后一条有效记录
      'web,,missing name,2024-01-01T00:00:00Z\n', // 无效：reviewer 归一后为空
      'web,Bob,bad time,2024-01-01 00:00:00\n', // 无效：timestamp 非 RFC3339
    ];
    // 补足到 20 条记录，使错误率恰好 15%（3/20），批次可以提交
    for (let i = 6; i <= 20; i += 1) {
      lines.push(`shop,user${i},text${i},2024-03-01T00:00:${String(i).padStart(2, '0')}Z\n`);
    }
    const csv = lines.join('');
    const result = lib.importCsv('m1', enc(csv));
    assert.equal(result.status, 'ok');
    assert.equal(result.totalRecords, 20);
    assert.equal(result.errorRecords, 3);
    assert.equal(result.imported, 16);
    const reviews = lib.listReviews('m1');
    assert.equal(reviews.length, 16);
    const eves = reviews.filter((r) => r.channel === 'web');
    assert.equal(eves.length, 1);
    // 保留批次中最后一条有效记录的完整原始字段
    assert.equal(eves[0].text, 'second');
    assert.equal(eves[0].reviewerName, composed);
    assert.equal(eves[0].timestamp, '2024-01-01T08:00:00+08:00');
  } finally {
    cleanup();
  }
});

test('去重键含商家标识：不同商家永不合并', () => {
  const { lib, cleanup } = makeLib();
  try {
    const csv = HEADER + 'web,Alice,hello,2024-01-01T00:00:00Z\n';
    lib.importCsv('m1', enc(csv));
    lib.importCsv('m2', enc(csv));
    assert.equal(lib.listReviews('m1').length, 1);
    assert.equal(lib.listReviews('m2').length, 1);
    // 同一商家重复导入同键记录 → 替换而非新增
    lib.importCsv('m1', enc(HEADER + 'web,Alice,updated,2024-01-01T00:00:00Z\n'));
    const reviews = lib.listReviews('m1');
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].text, 'updated');
  } finally {
    cleanup();
  }
});

test('恰好 15% 错误率允许提交，只跳过错误记录', () => {
  const { lib, cleanup } = makeLib();
  try {
    // 20 条记录，3 条错误 = 恰好 15%
    const lines = [HEADER];
    for (let i = 1; i <= 20; i += 1) {
      if (i === 3) {
        lines.push('too,few,fields\n');
      } else if (i === 7) {
        lines.push('web,Bob,no timezone,2024-01-01T00:00:00\n');
      } else if (i === 11) {
        lines.push('web,  ,blank name,2024-01-01T00:00:00Z\n');
      } else {
        lines.push(`web,user${i},text${i},2024-01-01T00:00:${String(i).padStart(2, '0')}Z\n`);
      }
    }
    const result = lib.importCsv('m1', enc(lines.join('')));
    assert.equal(result.status, 'ok');
    assert.equal(result.totalRecords, 20);
    assert.equal(result.errorRecords, 3);
    assert.equal(result.imported, 17);
    assert.equal(lib.listReviews('m1').length, 17);
  } finally {
    cleanup();
  }
});

test('超过 15% 错误率整批拒绝，已有数据（含将被替换的记录）不变', () => {
  const { lib, cleanup } = makeLib();
  try {
    lib.importCsv('m1', enc(HEADER + 'web,Alice,original,2024-01-01T00:00:00Z\n'));
    // 20 条记录，4 条错误 = 20% > 15%；其中一条本将替换已有记录
    const lines = [HEADER];
    lines.push('web,Alice,replacement,2024-01-01T00:00:00Z\n'); // 同键，本将替换
    for (let i = 2; i <= 20; i += 1) {
      if (i <= 4) {
        lines.push('bad,record,fields\n');
      } else if (i === 5) {
        lines.push('web,Bob,bad ts,not-a-time\n');
      } else {
        lines.push(`web,user${i},text${i},2024-02-01T00:00:${String(i).padStart(2, '0')}Z\n`);
      }
    }
    const result = lib.importCsv('m1', enc(lines.join('')));
    assert.equal(result.status, 'rejected');
    assert.equal(result.totalRecords, 20);
    assert.equal(result.errorRecords, 4);
    assert.equal(result.imported, 0);
    const reviews = lib.listReviews('m1');
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].text, 'original'); // 未被替换
  } finally {
    cleanup();
  }
});

test('文件末尾引号未闭合：整批失败，已有数据不变', () => {
  const { lib, cleanup } = makeLib();
  try {
    lib.importCsv('m1', enc(HEADER + 'web,Alice,original,2024-01-01T00:00:00Z\n'));
    const csv = HEADER + 'web,Alice,replacement,2024-01-01T00:00:00Z\nweb,Bob,"unclosed,2024-01-01T00:00:00Z';
    const result = lib.importCsv('m1', enc(csv));
    assert.equal(result.status, 'failed');
    assert.match(result.failureReason ?? '', /unterminated/);
    const reviews = lib.listReviews('m1');
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].text, 'original'); // 没有新增，也没有替换
  } finally {
    cleanup();
  }
});

test('表头不符与非法 UTF-8：整批失败', () => {
  const { lib, cleanup } = makeLib();
  try {
    const badHeader = lib.importCsv('m1', enc('channel,reviewer,text,timestamp\n'));
    assert.equal(badHeader.status, 'failed');
    const invalidUtf8 = lib.importCsv('m1', new Uint8Array([0xff, 0xfe, 0x41]));
    assert.equal(invalidUtf8.status, 'failed');
    assert.equal(lib.listReviews('m1').length, 0);
  } finally {
    cleanup();
  }
});

test('只有表头的文件视为空批次：成功但不修改数据', () => {
  const { lib, cleanup } = makeLib();
  try {
    lib.importCsv('m1', enc(HEADER + 'web,Alice,original,2024-01-01T00:00:00Z\n'));
    const result = lib.importCsv('m1', enc(HEADER));
    assert.equal(result.status, 'ok');
    assert.equal(result.totalRecords, 0);
    assert.equal(result.imported, 0);
    assert.equal(lib.listReviews('m1').length, 1);
  } finally {
    cleanup();
  }
});

test('空行算一条错误记录，文件末尾的换行不额外产生空记录', () => {
  const { lib, cleanup } = makeLib();
  try {
    // 1 条有效 + 1 条空行 = 2 条数据记录，1 条错误（50% > 15%，拒绝）
    const csv = HEADER + 'web,Alice,ok,2024-01-01T00:00:00Z\n\n';
    const result = lib.importCsv('m1', enc(csv));
    assert.equal(result.status, 'rejected');
    assert.equal(result.totalRecords, 2);
    assert.equal(result.errorRecords, 1);
    // 末尾换行不产生额外空记录：只有 1 条数据记录，0 错误
    const clean = lib.importCsv('m1', enc(HEADER + 'web,Alice,ok,2024-01-01T00:00:00Z\n'));
    assert.equal(clean.status, 'ok');
    assert.equal(clean.totalRecords, 1);
    assert.equal(clean.errorRecords, 0);
  } finally {
    cleanup();
  }
});

test('BOM 与 CRLF 记录结束符', () => {
  const { lib, cleanup } = makeLib();
  try {
    const csv = '\uFEFF' + HEADER.replace('\n', '\r\n') + 'web,Alice,hi,2024-01-01T00:00:00Z\r\n';
    const result = lib.importCsv('m1', enc(csv));
    assert.equal(result.status, 'ok');
    assert.equal(result.imported, 1);
    assert.equal(lib.listReviews('m1')[0].text, 'hi');
  } finally {
    cleanup();
  }
});
