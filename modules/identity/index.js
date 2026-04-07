const authRepo = require("./authRepo");
const authClient = require("./authClient");

module.exports = {
  ...authClient,
  authRepo
};
