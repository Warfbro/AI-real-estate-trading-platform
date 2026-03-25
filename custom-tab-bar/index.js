Component({
  data: {
    selected: 0,
    list: [{
      pagePath: "/pages/home/index"
    }, {
      pagePath: "/pages/my/index"
    }]
  },
  methods: {
    switchTab(e) {
      const data = e.currentTarget.dataset
      const url = this.data.list[data.index].pagePath
      const pages = getCurrentPages()
      const currentPage = pages[pages.length - 1]
      const currentRoute = currentPage && currentPage.route ? `/${currentPage.route}` : ""
      const fromHomeToMy =
        currentRoute === "/pages/home/index" && url === "/pages/my/index"

      if (fromHomeToMy) {
        wx.pageScrollTo({
          scrollTop: 0,
          duration: 0
        })
        setTimeout(() => {
          wx.switchTab({ url })
        }, 16)
        return
      }

      wx.switchTab({ url })
    },
    handleAI() {
      const pages = getCurrentPages()
      const currentPage = pages[pages.length - 1]
      const currentRoute = currentPage && currentPage.route ? `/${currentPage.route}` : ""
      const entryTab =
        currentRoute === "/pages/my/index" ? "/pages/my/index" : "/pages/home/index"

      wx.reLaunch({
        url: `/pages/ai/index?source=tabbar&entry_tab=${encodeURIComponent(entryTab)}`,
        fail: () => {
          wx.navigateTo({
            url: `/pages/ai/index?source=tabbar&entry_tab=${encodeURIComponent(entryTab)}`
          })
        }
      })
    }
  }
})
