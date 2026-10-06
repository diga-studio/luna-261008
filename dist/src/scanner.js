"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createScanner = void 0;
const matcher_1 = require("./matcher");
const mime_1 = require("./mime");
const QUARANTINE_THRESHOLD = 70;
const SCORE_CAP = 100;
function createScanner(rules) {
    const seenIds = new Set();
    for (const rule of rules) {
        if (seenIds.has(rule.id)) {
            throw new Error(`duplicate rule id: ${rule.id}`);
        }
        seenIds.add(rule.id);
        if (rule.needle.length === 0) {
            throw new Error(`rule ${rule.id} has empty needle`);
        }
        if (!Number.isInteger(rule.weight) || rule.weight <= 0) {
            throw new Error(`rule ${rule.id} has invalid weight`);
        }
    }
    const matcher = new matcher_1.KeywordMatcher(rules);
    const reported = new Set();
    const weights = new Map();
    for (const rule of rules) {
        weights.set(rule.id, rule.weight);
    }
    let leafState = null;
    let pendingHits = [];
    let finished = false;
    const collect = (ids) => {
        for (const id of ids) {
            if (!reported.has(id)) {
                reported.add(id);
                pendingHits.push(id);
            }
        }
    };
    const parser = new mime_1.MimeParser({
        onLeafStart() {
            leafState = matcher.createState();
        },
        onLeafText(text) {
            if (leafState !== null) {
                collect(matcher.feed(leafState, text));
            }
        },
        onLeafEnd() {
            leafState = null;
        },
    });
    return {
        write(bytes) {
            if (finished) {
                throw new Error("cannot write after finish");
            }
            parser.write(bytes);
            const hits = pendingHits;
            pendingHits = [];
            return hits;
        },
        finish() {
            if (finished) {
                throw new Error("finish called twice");
            }
            finished = true;
            parser.finish();
            const hitIds = [...reported];
            pendingHits = [];
            let score = 0;
            for (const id of reported) {
                score += weights.get(id);
            }
            const capped = Math.min(score, SCORE_CAP);
            return {
                hitIds,
                score: capped,
                quarantined: capped >= QUARANTINE_THRESHOLD,
            };
        },
    };
}
exports.createScanner = createScanner;
