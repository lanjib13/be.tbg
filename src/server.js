require("dotenv").config();

const { app } = require("./app");
const { environment } = require("./config/env");

const server = app.listen(environment.PORT, () => {
  console.info(`Tabungan Santri Ponpes Ihyaul Ulum API berjalan pada http://localhost:${environment.PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}