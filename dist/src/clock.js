"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ManualClock = exports.SystemClock = void 0;
class SystemClock {
    now() {
        return Date.now();
    }
}
exports.SystemClock = SystemClock;
class ManualClock {
    constructor(start = 0) {
        this.current = start;
    }
    now() {
        return this.current;
    }
    advance(ms) {
        this.current += ms;
    }
}
exports.ManualClock = ManualClock;
