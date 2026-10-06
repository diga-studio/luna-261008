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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.audit = exports.decide = void 0;
__exportStar(require("./types.js"), exports);
var decide_js_1 = require("./decide.js");
Object.defineProperty(exports, "decide", { enumerable: true, get: function () { return decide_js_1.decide; } });
var audit_js_1 = require("./audit.js");
Object.defineProperty(exports, "audit", { enumerable: true, get: function () { return audit_js_1.audit; } });
