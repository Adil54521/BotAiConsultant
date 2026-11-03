function sanitizeErrorMessage(message) {
    return String(message || "unknown error")
        .replace(/[+]?\d{5,}/g, "<redacted-number>")
        .replace(/[\r\n]+/g, " ")
        .slice(0, 300);
}

function safeErrorMetadata(operation, error, requestId, stage) {
    const stackLine = String(error && error.stack || "")
        .split("\n")
        .slice(1, 2)
        .join("")
        .trim()
        .replace(process.cwd(), ".")
        .slice(0, 240);
    return {
        operation,
        request_id: requestId,
        stage,
        type: error && error.constructor ? error.constructor.name : "Error",
        code: error && error.code || null,
        message: sanitizeErrorMessage(error && error.message),
        schema: error && error.schema || null,
        table: error && error.table || null,
        column: error && error.column || null,
        parameter: error && error.parameter || null,
        constraint: error && error.constraint || null,
        routine: error && error.routine || null,
        location: stackLine || null,
    };
}

function logSafeError(operation, error, requestId, stage) {
    console.error("BACKEND_OPERATION_ERROR", JSON.stringify(
        safeErrorMetadata(operation, error, requestId, stage)
    ));
}

module.exports = {sanitizeErrorMessage, safeErrorMetadata, logSafeError};
