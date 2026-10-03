const { randomBytes, timingSafeEqual } = require("node:crypto");
const { environment } = require("../config/env");
const { sendFailure } = require("../utils/http");
const { CSRF_COOKIE } = require("./session");

function requireTrustedOrigin(request, response, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    return next();
  }

  const origin = request.get("origin");
  if (!origin) {
    return next();
  }

  const allowedOrigins = [
    environment.FRONTEND_ORIGIN,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://be-tbg.onrender.com",
  ];

  if (
    allowedOrigins.includes(origin) ||
    origin.endsWith(".vercel.app") ||
    origin.endsWith(".onrender.com")
  ) {
    return next();
  }

  return sendFailure(response, 403, `Origin ${origin} tidak diizinkan`);
}

function requireCsrf(request, response, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    return next();
  }

  const cookieToken = request.cookies?.[CSRF_COOKIE];
  const headerToken = request.get("x-csrf-token");
  if (typeof cookieToken !== "string" || typeof headerToken !== "string") {
    return sendFailure(response, 403, "Token CSRF tidak tersedia");
  }

  const cookieBuffer = Buffer.from(cookieToken);
  const headerBuffer = Buffer.from(headerToken);
  if (cookieBuffer.length !== headerBuffer.length || !timingSafeEqual(cookieBuffer, headerBuffer)) {
    return sendFailure(response, 403, "Token CSRF tidak valid");
  }
  return next();
}

function allowRoles(...roles) {
  return (request, response, next) => {
    if (!request.profile || !roles.includes(request.profile.role)) {
      return sendFailure(response, 403, "Anda tidak memiliki izin untuk mengakses resource ini");
    }
    return next();
  };
}

function newCsrfToken() {
  return randomBytes(32).toString("hex");
}

module.exports = { allowRoles, newCsrfToken, requireCsrf, requireTrustedOrigin };
