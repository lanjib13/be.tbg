class AppError extends Error {
  constructor(status, message, errors = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.errors = errors;
  }
}

function sendSuccess(response, message, data, status = 200) {
  return response.status(status).json({ success: true, message, data });
}

function sendFailure(response, status, message, errors = {}) {
  return response.status(status).json({ success: false, message, errors });
}

function validate(schema, source = "body") {
  return (request, response, next) => {
    const result = schema.safeParse(request[source]);
    if (!result.success) {
      const errors = Object.fromEntries(
        result.error.issues.map((issue) => [issue.path.join(".") || "request", [issue.message]]),
      );
      return sendFailure(response, 400, "Validasi gagal", errors);
    }

    request.validated = result.data;
    return next();
  };
}

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function errorHandler(error, _request, response, _next) {
  if (error instanceof AppError) {
    return sendFailure(response, error.status, error.message, error.errors);
  }

  console.error("Unhandled API error", {
    name: error?.name ?? "Error",
    message: error?.message ?? "Unknown error",
  });
  return sendFailure(response, 500, "Terjadi kesalahan pada server");
}

module.exports = { AppError, asyncRoute, errorHandler, sendFailure, sendSuccess, validate };
