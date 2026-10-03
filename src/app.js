const cors = require("cors");
const cookieParser = require("cookie-parser");
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const morgan = require("morgan");
const { authRouter } = require("./routes/auth");
const { auditLogsRouter } = require("./routes/auditLogs");
const { dashboardRouter } = require("./routes/dashboard");
const { managedAdminsRouter } = require("./routes/managedAdmins");
const { managedUsersRouter } = require("./routes/managedUsers");
const { reportsRouter } = require("./routes/reports");
const { savingsRouter } = require("./routes/savings");
const { transactionsRouter } = require("./routes/transactions");
const { requireTrustedOrigin } = require("./middleware/access");
const { environment } = require("./config/env");
const { errorHandler } = require("./utils/http");
const { notFound } = require("./middleware/notFound");

const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
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
        return callback(null, true);
      }
      return callback(null, true);
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());
app.use(morgan("combined"));
app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 200,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
app.use("/api", requireTrustedOrigin);

app.get("/api/health", (_request, response) => {
  response.status(200).json({
    success: true,
    message: "Tabungan Santri API siap",
    data: { service: "simpanku-api", status: "ok" },
  });
});

app.use("/api", authRouter);
app.use("/api/admin/users", managedUsersRouter);
app.use("/api/super-admin/admins", managedAdminsRouter);
app.use("/api/savings", savingsRouter);
app.use("/api/transactions", transactionsRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/audit-logs", auditLogsRouter);
app.use("/api/dashboard", dashboardRouter);
app.use(notFound);
app.use(errorHandler);

module.exports = { app };