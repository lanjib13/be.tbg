const { sendFailure } = require("../utils/http");

function notFound(_request, response) {
  return sendFailure(response, 404, "Endpoint tidak ditemukan");
}

module.exports = { notFound };
