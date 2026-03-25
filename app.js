const { writeActivityLog } = require("./utils/track");
const { ensureCloud } = require("./utils/cloud");

App({
  globalData: {
    appName: "房产决策助手"
  },

  onLaunch() {
    try {
      ensureCloud();
    } catch (err) {
      console.warn("[cloud] init failed", err);
    }

    writeActivityLog({
      action_type: "app_launch",
      object_type: "app",
      detail_json: {
        launched_at: new Date().toISOString()
      }
    });
  }
});
