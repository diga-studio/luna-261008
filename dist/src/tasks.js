import { withTransaction } from "./db.js";
function rowToTask(row) {
    return {
        id: row.id,
        areas: JSON.parse(row.areas),
        status: row.status,
        createdAt: row.created_at,
    };
}
function getTaskRow(db, taskId) {
    const row = db.prepare("SELECT id, areas, status, created_at FROM tasks WHERE id = ?").get(taskId);
    if (!row) {
        throw new Error(`任务不存在: ${taskId}`);
    }
    return row;
}
/** 开启盘点任务：在同一事务中冻结当前整份账册为基线 */
export function openTask(db, areas) {
    if (areas.length === 0) {
        throw new Error("盘点任务必须指定至少一个区域");
    }
    return withTransaction(db, () => {
        const seqRow = db.prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM op_log").get();
        const createdAt = new Date().toISOString();
        const result = db
            .prepare("INSERT INTO tasks (areas, status, baseline_seq, created_at) VALUES (?, 'open', ?, ?)")
            .run(JSON.stringify(areas), seqRow.max_seq, createdAt);
        const taskId = Number(result.lastInsertRowid);
        db.prepare(`INSERT INTO baselines (task_id, tag, area, custodian, mark)
       SELECT ?, tag, area, custodian, mark FROM ledger`).run(taskId);
        return getTask(db, taskId);
    });
}
/** 提交整份盘点结果，提交后固定，不再编辑 */
export function submitResults(db, taskId, records) {
    withTransaction(db, () => {
        const task = getTaskRow(db, taskId);
        if (task.status !== "open") {
            throw new Error(`任务 ${taskId} 已提交，结果固定不可编辑`);
        }
        const scope = new Set(JSON.parse(task.areas));
        const seen = new Set();
        const exists = db.prepare("SELECT 1 AS one FROM ledger WHERE tag = ?");
        const insert = db.prepare("INSERT INTO submissions (task_id, tag, area, custodian) VALUES (?, ?, ?, ?)");
        for (const record of records) {
            if (seen.has(record.tag)) {
                throw new Error(`提交结果包含重复标签: ${record.tag}`);
            }
            seen.add(record.tag);
            if (!exists.get(record.tag)) {
                throw new Error(`扫描标签未登记: ${record.tag}`);
            }
            if (!scope.has(record.area)) {
                throw new Error(`实测区域不在任务范围内: ${record.area}`);
            }
            insert.run(taskId, record.tag, record.area, record.custodian);
        }
        db.prepare("UPDATE tasks SET status = 'submitted' WHERE id = ?").run(taskId);
    });
}
/** 查看任务信息 */
export function getTask(db, taskId) {
    return rowToTask(getTaskRow(db, taskId));
}
/** 计算任务的差异清单（基于冻结基线与提交结果，不随当前账册变化） */
export function getDiffs(db, taskId) {
    const task = getTaskRow(db, taskId);
    const scope = new Set(JSON.parse(task.areas));
    const baselineRows = db
        .prepare("SELECT tag, area, custodian, mark FROM baselines WHERE task_id = ?")
        .all(taskId);
    const baselineByTag = new Map();
    for (const row of baselineRows) {
        baselineByTag.set(row.tag, {
            tag: row.tag,
            area: row.area,
            custodian: row.custodian,
            mark: row.mark,
        });
    }
    const scannedRows = db
        .prepare("SELECT tag, area, custodian FROM submissions WHERE task_id = ?")
        .all(taskId);
    const scannedByTag = new Map(scannedRows.map((row) => [row.tag, row]));
    const diffs = [];
    for (const baseline of baselineByTag.values()) {
        const scanned = scannedByTag.get(baseline.tag);
        const inScope = scope.has(baseline.area);
        if (!scanned) {
            if (inScope && baseline.mark !== "pending") {
                diffs.push({
                    tag: baseline.tag,
                    kinds: ["shortage"],
                    baseline,
                    target: { mark: "pending" },
                });
            }
            continue;
        }
        const target = {
            area: scanned.area,
            custodian: scanned.custodian,
            mark: "found",
        };
        if (!inScope) {
            diffs.push({ tag: baseline.tag, kinds: ["surplus"], baseline, target });
            continue;
        }
        const kinds = [];
        if (scanned.area !== baseline.area)
            kinds.push("location");
        if (scanned.custodian !== baseline.custodian)
            kinds.push("custodian");
        const markDiffers = baseline.mark !== "found";
        if (kinds.length > 0 || markDiffers) {
            diffs.push({ tag: baseline.tag, kinds, baseline, target });
        }
    }
    return diffs.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}
//# sourceMappingURL=tasks.js.map