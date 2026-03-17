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
      wx.switchTab({ url })
    },
    handleAI() {
      wx.navigateTo({
        url: "/pages/ai/index"
      })
    }
  }
})
