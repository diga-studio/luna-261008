import type { Hit, ScanResult } from './types.ts';
import type { Token } from './lexer.ts';

type State =
  | 'idle'
  | 'skip'
  | 'dropFirst'
  | 'dropTableIf'
  | 'dropTableExists'
  | 'dropName'
  | 'dropNamePart'
  | 'dropNameDot'
  | 'dropTail'
  | 'truncateHead'
  | 'truncateItem'
  | 'truncateName'
  | 'truncateNamePart'
  | 'truncateNameDot'
  | 'truncateAfterItem'
  | 'truncateIdentity'
  | 'truncateTail'
  | 'alterFirst'
  | 'alterIf'
  | 'alterExists'
  | 'alterOnly'
  | 'alterName'
  | 'alterNamePart'
  | 'alterNameDot'
  | 'alterActions'
  | 'alterSkipAction'
  | 'alterDrop'
  | 'alterDropIf'
  | 'alterDropExists'
  | 'alterDropCol'
  | 'alterDropTail';

function isKw(t: Token, word: string): boolean {
  return t.kind === 'ident' && !t.quoted && t.text === word;
}

function isPunct(t: Token, ch: string): boolean {
  return t.kind === 'punct' && t.text === ch;
}

/**
 * 流式语句解析器：逐单元接收词法输出，识别顶层
 * DROP TABLE / TRUNCATE / ALTER TABLE ... DROP COLUMN。
 * 命中先进入当前语句的暂存区，语句正常结束（分号或干净 EOF）才提交。
 */
export class Parser {
  private state: State = 'idle';
  private skipDepth = 0;
  private actionDepth = 0;

  private readonly hits: Hit[] = [];
  private pendingHits: Hit[] = [];

  private stmtOffset = 0;
  private actionDropOffset = 0;
  private nameParts: string[] = [];
  private tableParts: string[] = [];

  /** 接收一个词法单元。 */
  feed(t: Token): void {
    switch (this.state) {
      case 'idle':
        this.idleToken(t);
        return;
      case 'skip':
        this.skipToken(t);
        return;
      case 'dropFirst':
        if (isKw(t, 'table')) this.state = 'dropTableIf';
        else this.enterSkip(t);
        return;
      case 'dropTableIf':
        if (isKw(t, 'if')) {
          this.state = 'dropTableExists';
        } else {
          this.state = 'dropName';
          this.dropNameToken(t);
        }
        return;
      case 'dropTableExists':
        if (isKw(t, 'exists')) this.state = 'dropName';
        else this.enterSkip(t);
        return;
      case 'dropName':
        this.dropNameToken(t);
        return;
      case 'dropNamePart':
        if (t.kind === 'ident') {
          this.nameParts.push(t.text);
          this.state = 'dropNameDot';
        } else {
          this.enterSkip(t);
        }
        return;
      case 'dropNameDot':
        if (isPunct(t, '.')) {
          this.state = 'dropNamePart';
          return;
        }
        this.emitDropTableHit();
        if (isPunct(t, ',')) this.state = 'dropName';
        else if (isPunct(t, ';')) this.commit();
        else if (isKw(t, 'cascade') || isKw(t, 'restrict')) this.state = 'dropTail';
        else this.enterSkip(t);
        return;
      case 'dropTail':
        if (isPunct(t, ';')) this.commit();
        else this.enterSkip(t);
        return;
      case 'truncateHead':
        if (isKw(t, 'table')) this.state = 'truncateItem';
        else {
          this.state = 'truncateItem';
          this.truncateItemToken(t);
        }
        return;
      case 'truncateItem':
        this.truncateItemToken(t);
        return;
      case 'truncateName':
        if (t.kind === 'ident') {
          this.nameParts = [t.text];
          this.state = 'truncateNameDot';
        } else {
          this.enterSkip(t);
        }
        return;
      case 'truncateNamePart':
        if (t.kind === 'ident') {
          this.nameParts.push(t.text);
          this.state = 'truncateNameDot';
        } else {
          this.enterSkip(t);
        }
        return;
      case 'truncateNameDot':
        if (isPunct(t, '.')) {
          this.state = 'truncateNamePart';
          return;
        }
        this.emitTruncateHit();
        if (isPunct(t, '*')) this.state = 'truncateAfterItem';
        else if (isPunct(t, ',')) this.state = 'truncateItem';
        else if (isPunct(t, ';')) this.commit();
        else if (isKw(t, 'restart') || isKw(t, 'continue')) this.state = 'truncateIdentity';
        else if (isKw(t, 'cascade') || isKw(t, 'restrict')) this.state = 'truncateTail';
        else this.enterSkip(t);
        return;
      case 'truncateAfterItem':
        if (isPunct(t, ',')) this.state = 'truncateItem';
        else if (isPunct(t, ';')) this.commit();
        else if (isKw(t, 'restart') || isKw(t, 'continue')) this.state = 'truncateIdentity';
        else if (isKw(t, 'cascade') || isKw(t, 'restrict')) this.state = 'truncateTail';
        else this.enterSkip(t);
        return;
      case 'truncateIdentity':
        if (isKw(t, 'identity')) this.state = 'truncateTail';
        else this.enterSkip(t);
        return;
      case 'truncateTail':
        if (isPunct(t, ';')) this.commit();
        else this.enterSkip(t);
        return;
      case 'alterFirst':
        if (isKw(t, 'table')) this.state = 'alterIf';
        else this.enterSkip(t);
        return;
      case 'alterIf':
        if (isKw(t, 'if')) {
          this.state = 'alterExists';
        } else {
          this.state = 'alterOnly';
          this.alterOnlyToken(t);
        }
        return;
      case 'alterExists':
        if (isKw(t, 'exists')) this.state = 'alterOnly';
        else this.enterSkip(t);
        return;
      case 'alterOnly':
        this.alterOnlyToken(t);
        return;
      case 'alterName':
        if (t.kind === 'ident') {
          this.tableParts = [t.text];
          this.state = 'alterNameDot';
        } else {
          this.enterSkip(t);
        }
        return;
      case 'alterNamePart':
        if (t.kind === 'ident') {
          this.tableParts.push(t.text);
          this.state = 'alterNameDot';
        } else {
          this.enterSkip(t);
        }
        return;
      case 'alterNameDot':
        if (isPunct(t, '.')) {
          this.state = 'alterNamePart';
          return;
        }
        if (isPunct(t, '*')) {
          this.state = 'alterActions';
          return;
        }
        this.state = 'alterActions';
        this.alterActionToken(t);
        return;
      case 'alterActions':
        this.alterActionToken(t);
        return;
      case 'alterSkipAction':
        this.skipActionToken(t);
        return;
      case 'alterDrop':
        if (isKw(t, 'column')) {
          this.state = 'alterDropIf';
        } else if (isKw(t, 'if')) {
          this.state = 'alterDropExists';
        } else if (isKw(t, 'constraint')) {
          this.enterSkipAction(t);
        } else if (t.kind === 'ident') {
          this.emitDropColumnHit(t.text);
          this.state = 'alterDropTail';
        } else if (isPunct(t, ',')) {
          this.state = 'alterActions';
        } else if (isPunct(t, ';')) {
          this.commit();
        } else {
          this.enterSkipAction(t);
        }
        return;
      case 'alterDropIf':
        if (isKw(t, 'if')) this.state = 'alterDropExists';
        else if (t.kind === 'ident') {
          this.emitDropColumnHit(t.text);
          this.state = 'alterDropTail';
        } else this.enterSkipAction(t);
        return;
      case 'alterDropExists':
        if (isKw(t, 'exists')) this.state = 'alterDropCol';
        else this.enterSkipAction(t);
        return;
      case 'alterDropCol':
        if (t.kind === 'ident') {
          this.emitDropColumnHit(t.text);
          this.state = 'alterDropTail';
        } else this.enterSkipAction(t);
        return;
      case 'alterDropTail':
        if (isPunct(t, ',')) this.state = 'alterActions';
        else if (isPunct(t, ';')) this.commit();
        else if (isKw(t, 'cascade') || isKw(t, 'restrict')) this.state = 'alterDropTail';
        else this.enterSkipAction(t);
        return;
    }
  }

  /**
   * 结束事件。
   * @param clean 词法器是否干净结束（无未闭合构造）。
   */
  finish(clean: boolean): ScanResult {
    if (!clean) {
      // 未完成语句的暂存命中全部丢弃。
      this.pendingHits = [];
      return { hits: this.hits, complete: false };
    }
    // 最后一条语句可以没有分号：补全已完成的名字并提交。
    if (this.state === 'dropNameDot') this.emitDropTableHit();
    else if (this.state === 'truncateNameDot') this.emitTruncateHit();
    this.commit();
    return { hits: this.hits, complete: true };
  }

  private idleToken(t: Token): void {
    if (isPunct(t, ';')) return;
    if (t.kind === 'ident' && !t.quoted) {
      if (t.text === 'drop') {
        this.stmtOffset = t.offset;
        this.state = 'dropFirst';
        return;
      }
      if (t.text === 'truncate') {
        this.stmtOffset = t.offset;
        this.state = 'truncateHead';
        return;
      }
      if (t.text === 'alter') {
        this.stmtOffset = t.offset;
        this.state = 'alterFirst';
        return;
      }
    }
    this.enterSkip(t);
  }

  private dropNameToken(t: Token): void {
    if (t.kind === 'ident') {
      this.nameParts = [t.text];
      this.state = 'dropNameDot';
    } else {
      this.enterSkip(t);
    }
  }

  private truncateItemToken(t: Token): void {
    if (isKw(t, 'only')) {
      this.state = 'truncateName';
    } else if (t.kind === 'ident') {
      this.nameParts = [t.text];
      this.state = 'truncateNameDot';
    } else if (isPunct(t, ';')) {
      this.commit();
    } else {
      this.enterSkip(t);
    }
  }

  private alterOnlyToken(t: Token): void {
    if (isKw(t, 'only')) {
      this.state = 'alterName';
    } else if (t.kind === 'ident') {
      this.tableParts = [t.text];
      this.state = 'alterNameDot';
    } else {
      this.enterSkip(t);
    }
  }

  private alterActionToken(t: Token): void {
    if (isKw(t, 'drop')) {
      this.actionDropOffset = t.offset;
      this.state = 'alterDrop';
      return;
    }
    if (isPunct(t, ';')) {
      this.commit();
      return;
    }
    this.enterSkipAction(t);
  }

  private skipActionToken(t: Token): void {
    if (t.kind !== 'punct') return;
    if (t.text === '(' || t.text === '[') {
      this.actionDepth++;
    } else if (t.text === ')' || t.text === ']') {
      if (this.actionDepth > 0) this.actionDepth--;
    } else if (t.text === ',' && this.actionDepth === 0) {
      this.state = 'alterActions';
    } else if (t.text === ';' && this.actionDepth === 0) {
      this.commit();
    }
  }

  private enterSkip(t: Token): void {
    this.state = 'skip';
    this.skipDepth = 0;
    this.skipToken(t);
  }

  private skipToken(t: Token): void {
    if (t.kind !== 'punct') return;
    if (t.text === '(' || t.text === '[') {
      this.skipDepth++;
    } else if (t.text === ')' || t.text === ']') {
      if (this.skipDepth > 0) this.skipDepth--;
    } else if (t.text === ';' && this.skipDepth === 0) {
      this.commit();
    }
  }

  private enterSkipAction(t: Token): void {
    this.state = 'alterSkipAction';
    this.actionDepth = 0;
    this.skipActionToken(t);
  }

  private emitDropTableHit(): void {
    this.pendingHits.push({
      operation: 'DROP_TABLE',
      table: this.nameParts.join('.'),
      tableParts: [...this.nameParts],
      offset: this.stmtOffset,
    });
  }

  private emitTruncateHit(): void {
    this.pendingHits.push({
      operation: 'TRUNCATE',
      table: this.nameParts.join('.'),
      tableParts: [...this.nameParts],
      offset: this.stmtOffset,
    });
  }

  private emitDropColumnHit(column: string): void {
    this.pendingHits.push({
      operation: 'DROP_COLUMN',
      table: this.tableParts.join('.'),
      tableParts: [...this.tableParts],
      column,
      offset: this.actionDropOffset,
    });
  }

  private commit(): void {
    if (this.pendingHits.length > 0) {
      this.hits.push(...this.pendingHits);
      this.pendingHits = [];
    }
    this.nameParts = [];
    this.tableParts = [];
    this.skipDepth = 0;
    this.actionDepth = 0;
    this.state = 'idle';
  }
}
