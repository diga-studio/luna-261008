/** 归一化用于去重键的文本：去首尾 ASCII 空格（U+0020）+ Unicode NFC，区分大小写。 */
export function normalizeKeyText(value: string): string {
  return value.replace(/^ +| +$/g, '').normalize('NFC');
}
