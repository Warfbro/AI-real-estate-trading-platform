/**
 * repos/index.js - 仓库层统一导出
 *
 * 使用方式：
 *   const { authRepo, listingRepo, profileRepo, chatRepo, intakeRepo, workflowRepo } = require('../../repos');
 *   或
 *   const repos = require('../../repos');
 *   repos.authRepo.getSession();
 */

const authRepo = require("./authRepo");
const listingRepo = require("./listingRepo");
const profileRepo = require("./profileRepo");
const chatRepo = require("./chatRepo");
const intakeRepo = require("./intakeRepo");
const workflowRepo = require("./workflowRepo");

/**
 * 全局缓存失效（在登出或某些重要操作后调用）
 */
function invalidateAllCaches() {
  authRepo.invalidateCache && authRepo.invalidateCache();
  listingRepo.invalidateCache && listingRepo.invalidateCache();
  profileRepo.invalidateCache && profileRepo.invalidateCache();
  chatRepo.invalidateCache && chatRepo.invalidateCache();
  intakeRepo.invalidateCache && intakeRepo.invalidateCache();
  workflowRepo.invalidateCache && workflowRepo.invalidateCache();
}

module.exports = {
  authRepo,
  listingRepo,
  profileRepo,
  chatRepo,
  intakeRepo,
  workflowRepo,
  invalidateAllCaches
};
