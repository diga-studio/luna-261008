"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Store = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function emptyState() {
    return { definitions: [], applications: [], opLog: {}, seq: 0 };
}
class Store {
    filePath;
    data;
    constructor(filePath) {
        this.filePath = filePath;
        this.data = this.load();
    }
    load() {
        let raw;
        try {
            raw = fs.readFileSync(this.filePath, 'utf8');
        }
        catch {
            return emptyState();
        }
        const parsed = JSON.parse(raw);
        return {
            definitions: parsed.definitions ?? [],
            applications: parsed.applications ?? [],
            opLog: parsed.opLog ?? {},
            seq: parsed.seq ?? 0,
        };
    }
    get state() {
        return this.data;
    }
    /** 将当前状态原子落盘（先写临时文件再改名） */
    save() {
        const dir = path.dirname(this.filePath);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
        fs.renameSync(tmp, this.filePath);
    }
}
exports.Store = Store;
