export class TrialError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'TrialError';
        this.code = code;
    }
}
