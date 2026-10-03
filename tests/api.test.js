const assert = require("node:assert/strict");
const test = require("node:test");
const request = require("supertest");
const { app } = require("../src/app");

test("health endpoint returns the standard success envelope", async () => {
  const response = await request(app).get("/api/health").expect(200);

  assert.equal(response.body.success, true);
  assert.equal(response.body.data.service, "simpanku-api");
  assert.equal(response.body.data.status, "ok");
});

test("protected routes reject requests without a session", async () => {
  const response = await request(app).get("/api/auth/me").expect(401);

  assert.equal(response.body.success, false);
  assert.match(response.body.message, /sesi/i);
});

test("login validates input before contacting Supabase Auth", async () => {
  const response = await request(app)
    .post("/api/auth/login")
    .set("Origin", "http://localhost:3000")
    .send({ username: "x", password: "bad" })
    .expect(400);

  assert.equal(response.body.success, false);
  assert.equal(response.body.message, "Validasi gagal");
});

test("mutations reject untrusted origins before session checks", async () => {
  const response = await request(app)
    .post("/api/transactions/deposit")
    .set("Origin", "https://attacker.invalid")
    .send({})
    .expect(403);

  assert.equal(response.body.success, false);
  assert.equal(response.body.message, "Origin tidak diizinkan");
});

test("role-managed routes reject requests without a session", async () => {
  await request(app).get("/api/admin/users").expect(401);
  await request(app).get("/api/super-admin/admins").expect(401);
  await request(app)
    .post("/api/transactions/deposit")
    .set("Origin", "http://localhost:3000")
    .expect(401);
});

test("unknown routes use the standard error envelope", async () => {
  const response = await request(app).get("/api/not-a-route").expect(404);

  assert.equal(response.body.success, false);
  assert.equal(response.body.message, "Endpoint tidak ditemukan");
});
