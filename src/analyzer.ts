import type { AnalysisResult, Hit, OperationType } from "./types.js";
import { TokenKind, type Token } from "./lexer.js";

const enum S {
  StmtStart, // expecting the first token of a statement
  SkipStmt, // consume until top-level ';'
  DropExpectTable, // saw DROP
  DtIfOrName, // DROP TABLE, optional IF EXISTS or first name
  DtExists, // saw IF
  DtNameStart, // expecting a table name
  DtNameDot, // after a name part: '.', ',', option or end
  DtNamePart, // after '.': expecting next name part
  TrFirst, // saw TRUNCATE: optional TABLE
  TrObjStart, // expecting [ONLY] name
  TrNameStartOnly, // after ONLY: expecting name
  TrNameDot, // after a name part
  TrNamePart, // after '.'
  TrAfterObj, // after trailing '*'
  TrTail, // identity/cascade options until ';'
  AlExpectTable, // saw ALTER
  AlIfOrOnly, // ALTER TABLE, optional IF EXISTS / ONLY / name
  AlExists, // saw IF
  AlOnlyOrName, // after IF EXISTS: optional ONLY / name
  AlNameStart, // expecting the table name
  AlNameDot, // after a name part
  AlNamePart, // after '.'
  AlActionStart, // first token of an action
  AlAfterDrop, // action starts with DROP
  AlColIfOrName, // after DROP COLUMN: optional IF EXISTS or column name
  AlColExists, // saw IF
  AlColName, // after IF EXISTS: expecting column name
  AlSkipAction, // consume until top-level ',' or ';'
}

/**
 * Consumes the token stream of one event, splits top-level statements and
 * recognizes DROP TABLE / TRUNCATE / ALTER TABLE ... DROP COLUMN.
 * Keeps only a bounded lookahead; hits of the current statement are rolled
 * back if the event ends with an unterminated lexical structure.
 */
export class Analyzer {
  private state: S = S.StmtStart;
  private depth = 0; // paren/bracket nesting inside skip states
  private readonly hits: Hit[] = [];
  private pendingStart = 0; // hits from this index on belong to the open statement
  private keywordOffset = 0; // offset of DROP / TRUNCATE for the open statement
  private actionDropOffset = 0; // offset of the current action's DROP
  private readonly parts: string[] = []; // name parts of the object being parsed
  private readonly alterTable: string[] = []; // table of the open ALTER statement

  /** Feed one token from the lexer. */
  feed(token: Token): void {
    let t = token;
    let again = true;
    while (again) {
      again = false;
      switch (this.state) {
        case S.StmtStart:
          this.depth = 0;
          if (t.kind === TokenKind.Ident) {
            if (t.text === "drop") {
              this.keywordOffset = t.start;
              this.state = S.DropExpectTable;
            } else if (t.text === "truncate") {
              this.keywordOffset = t.start;
              this.state = S.TrFirst;
            } else if (t.text === "alter") {
              this.keywordOffset = t.start;
              this.state = S.AlExpectTable;
            } else {
              this.state = S.SkipStmt;
            }
          } else if (t.kind === TokenKind.Semi) {
            // empty statement
          } else if (t.kind === TokenKind.LParen || t.kind === TokenKind.LBracket) {
            this.depth = 1;
            this.state = S.SkipStmt;
          } else {
            this.state = S.SkipStmt;
          }
          break;

        case S.SkipStmt:
          if (t.kind === TokenKind.LParen || t.kind === TokenKind.LBracket) this.depth++;
          else if (t.kind === TokenKind.RParen || t.kind === TokenKind.RBracket)
            this.depth = Math.max(0, this.depth - 1);
          else if (t.kind === TokenKind.Semi && this.depth === 0) this.completeStmt();
          break;

        // ---- DROP TABLE ----
        case S.DropExpectTable:
          if (t.kind === TokenKind.Ident && t.text === "table") this.state = S.DtIfOrName;
          else this.skipFrom(t);
          break;
        case S.DtIfOrName:
          if (t.kind === TokenKind.Ident && t.text === "if") this.state = S.DtExists;
          else if (this.beginName(t)) this.state = S.DtNameDot;
          else this.skipFrom(t);
          break;
        case S.DtExists:
          if (t.kind === TokenKind.Ident && t.text === "exists") this.state = S.DtNameStart;
          else this.skipFrom(t);
          break;
        case S.DtNameStart:
          if (this.beginName(t)) this.state = S.DtNameDot;
          else this.skipFrom(t);
          break;
        case S.DtNameDot:
          if (t.kind === TokenKind.Dot) this.state = S.DtNamePart;
          else {
            this.emitHit("dropTable", this.parts, this.keywordOffset);
            if (t.kind === TokenKind.Comma) this.state = S.DtNameStart;
            else if (t.kind === TokenKind.Semi) this.completeStmt();
            else this.skipFrom(t);
          }
          break;
        case S.DtNamePart:
          if (this.continueName(t)) this.state = S.DtNameDot;
          else this.skipFrom(t);
          break;

        // ---- TRUNCATE ----
        case S.TrFirst:
          if (t.kind === TokenKind.Ident && t.text === "table") this.state = S.TrObjStart;
          else {
            this.state = S.TrObjStart;
            again = true;
          }
          break;
        case S.TrObjStart:
          if (t.kind === TokenKind.Ident && t.text === "only") this.state = S.TrNameStartOnly;
          else if (this.beginName(t)) this.state = S.TrNameDot;
          else this.skipFrom(t);
          break;
        case S.TrNameStartOnly:
          if (this.beginName(t)) this.state = S.TrNameDot;
          else this.skipFrom(t);
          break;
        case S.TrNameDot:
          if (t.kind === TokenKind.Dot) this.state = S.TrNamePart;
          else if (t.kind === TokenKind.Star) {
            this.emitHit("truncate", this.parts, this.keywordOffset);
            this.state = S.TrAfterObj;
          } else {
            this.emitHit("truncate", this.parts, this.keywordOffset);
            if (t.kind === TokenKind.Comma) this.state = S.TrObjStart;
            else if (t.kind === TokenKind.Semi) this.completeStmt();
            else {
              this.state = S.TrTail;
              again = true;
            }
          }
          break;
        case S.TrNamePart:
          if (this.continueName(t)) this.state = S.TrNameDot;
          else this.skipFrom(t);
          break;
        case S.TrAfterObj:
          if (t.kind === TokenKind.Comma) this.state = S.TrObjStart;
          else if (t.kind === TokenKind.Semi) this.completeStmt();
          else this.state = S.TrTail;
          break;
        case S.TrTail:
          if (t.kind === TokenKind.LParen || t.kind === TokenKind.LBracket) this.depth++;
          else if (t.kind === TokenKind.RParen || t.kind === TokenKind.RBracket)
            this.depth = Math.max(0, this.depth - 1);
          else if (t.kind === TokenKind.Semi && this.depth === 0) this.completeStmt();
          break;

        // ---- ALTER TABLE ----
        case S.AlExpectTable:
          if (t.kind === TokenKind.Ident && t.text === "table") this.state = S.AlIfOrOnly;
          else this.skipFrom(t);
          break;
        case S.AlIfOrOnly:
          if (t.kind === TokenKind.Ident && t.text === "if") this.state = S.AlExists;
          else if (t.kind === TokenKind.Ident && t.text === "only") this.state = S.AlNameStart;
          else if (this.beginName(t)) this.state = S.AlNameDot;
          else this.skipFrom(t);
          break;
        case S.AlExists:
          if (t.kind === TokenKind.Ident && t.text === "exists") this.state = S.AlOnlyOrName;
          else this.skipFrom(t);
          break;
        case S.AlOnlyOrName:
          if (t.kind === TokenKind.Ident && t.text === "only") this.state = S.AlNameStart;
          else if (this.beginName(t)) this.state = S.AlNameDot;
          else this.skipFrom(t);
          break;
        case S.AlNameStart:
          if (this.beginName(t)) this.state = S.AlNameDot;
          else this.skipFrom(t);
          break;
        case S.AlNameDot:
          if (t.kind === TokenKind.Dot) this.state = S.AlNamePart;
          else if (t.kind === TokenKind.Star) {
            this.saveAlterTable();
            this.state = S.AlActionStart;
          } else {
            this.saveAlterTable();
            this.state = S.AlActionStart;
            again = true;
          }
          break;
        case S.AlNamePart:
          if (this.continueName(t)) this.state = S.AlNameDot;
          else this.skipFrom(t);
          break;
        case S.AlActionStart:
          if (t.kind === TokenKind.Ident && t.text === "drop") {
            this.actionDropOffset = t.start;
            this.state = S.AlAfterDrop;
          } else if (t.kind === TokenKind.Semi) {
            this.completeStmt();
          } else if (t.kind === TokenKind.Comma) {
            // tolerate empty action
          } else {
            this.state = S.AlSkipAction;
            again = true;
          }
          break;
        case S.AlAfterDrop:
          if (t.kind === TokenKind.Ident && t.text === "constraint") {
            this.state = S.AlSkipAction;
          } else if (t.kind === TokenKind.Ident && t.text === "column") {
            this.state = S.AlColIfOrName;
          } else if (t.kind === TokenKind.Ident && t.text === "if") {
            this.state = S.AlColExists;
          } else if (t.kind === TokenKind.Ident || t.kind === TokenKind.QuotedIdent) {
            this.emitHit("dropColumn", this.alterTable, this.actionDropOffset, t.text!);
            this.state = S.AlSkipAction;
          } else {
            this.state = S.AlSkipAction;
            again = true;
          }
          break;
        case S.AlColIfOrName:
          if (t.kind === TokenKind.Ident && t.text === "if") this.state = S.AlColExists;
          else if (t.kind === TokenKind.Ident || t.kind === TokenKind.QuotedIdent) {
            this.emitHit("dropColumn", this.alterTable, this.actionDropOffset, t.text!);
            this.state = S.AlSkipAction;
          } else {
            this.state = S.AlSkipAction;
            again = true;
          }
          break;
        case S.AlColExists:
          if (t.kind === TokenKind.Ident && t.text === "exists") this.state = S.AlColName;
          else {
            this.state = S.AlSkipAction;
            again = true;
          }
          break;
        case S.AlColName:
          if (t.kind === TokenKind.Ident || t.kind === TokenKind.QuotedIdent) {
            this.emitHit("dropColumn", this.alterTable, this.actionDropOffset, t.text!);
          }
          this.state = S.AlSkipAction;
          if (t.kind !== TokenKind.Ident && t.kind !== TokenKind.QuotedIdent) again = true;
          break;
        case S.AlSkipAction:
          if (t.kind === TokenKind.LParen || t.kind === TokenKind.LBracket) this.depth++;
          else if (t.kind === TokenKind.RParen || t.kind === TokenKind.RBracket)
            this.depth = Math.max(0, this.depth - 1);
          else if (this.depth === 0 && t.kind === TokenKind.Comma) this.state = S.AlActionStart;
          else if (this.depth === 0 && t.kind === TokenKind.Semi) this.completeStmt();
          break;
      }
    }
  }

  /**
   * Finalize the event.
   * @param lexerClean true when the lexer ended with all structures closed.
   */
  end(lexerClean: boolean): AnalysisResult {
    if (!lexerClean) {
      // The trailing statement is unfinished: drop its tentative hits.
      this.hits.length = this.pendingStart;
      return { status: "incomplete", hits: this.hits };
    }
    // The last statement may end without a semicolon; flush a pending name.
    if (this.state === S.DtNameDot) {
      this.emitHit("dropTable", this.parts, this.keywordOffset);
    } else if (this.state === S.TrNameDot) {
      this.emitHit("truncate", this.parts, this.keywordOffset);
    }
    return { status: "ok", hits: this.hits };
  }

  private completeStmt(): void {
    this.state = S.StmtStart;
    this.pendingStart = this.hits.length;
    this.depth = 0;
  }

  private skipFrom(t: Token): void {
    if (t.kind === TokenKind.Semi) {
      this.completeStmt();
      return;
    }
    this.depth =
      t.kind === TokenKind.LParen || t.kind === TokenKind.LBracket ? 1 : 0;
    this.state = S.SkipStmt;
  }

  /** If t can start a name, store it as the first part and return true. */
  private beginName(t: Token): boolean {
    if (t.kind === TokenKind.Ident || t.kind === TokenKind.QuotedIdent) {
      this.parts.length = 0;
      this.parts.push(t.text!);
      return true;
    }
    return false;
  }

  /** If t can continue a qualified name, append it and return true. */
  private continueName(t: Token): boolean {
    if (t.kind === TokenKind.Ident || t.kind === TokenKind.QuotedIdent) {
      this.parts.push(t.text!);
      return true;
    }
    return false;
  }

  private saveAlterTable(): void {
    this.alterTable.length = 0;
    this.alterTable.push(...this.parts);
  }

  private emitHit(op: OperationType, table: readonly string[], offset: number, column?: string): void {
    const hit: Hit = { operation: op, table: [...table], offset };
    if (column !== undefined) hit.column = column;
    this.hits.push(hit);
  }
}
