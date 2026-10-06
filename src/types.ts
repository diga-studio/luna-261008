/** 姓名键：上游已规范为小写英文字母串 */
export type NameKey = string;

/** 出生日期，ISO 格式 YYYY-MM-DD；可缺失 */
export type BirthDate = string;

/** SSN：完整 9 位数字串，或仅末 4 位数字串；可缺失 */
export type Ssn = string;

/** 员工（待筛查人员） */
export interface Employee {
  id: string;
  nameKey: NameKey;
  birthDate?: BirthDate;
  ssn?: Ssn;
}

/** 刑录记录 */
export interface CriminalRecord {
  id: string;
  nameKey: NameKey;
  birthDate?: BirthDate;
  ssn?: Ssn;
}

/** 命中类别，优先级 exact > partial > fuzzy */
export type MatchCategory = "exact" | "partial" | "fuzzy";

/** 单条命中结果 */
export interface ScreenHit {
  recordId: string;
  category: MatchCategory;
}

/** 一位员工的筛查结果 */
export interface EmployeeScreenResult {
  employeeId: string;
  hits: ScreenHit[];
}
